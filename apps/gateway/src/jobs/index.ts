// The outbox poller (plan decision 3): claims due outbox rows with FOR UPDATE SKIP LOCKED under a
// lease (locked_until), runs the handler registered for the topic outside the claim transaction,
// then marks the row published, retried with backoff, or dead. Works the same on Postgres and PGlite.
// Handlers are idempotent: a crash after a handler's commit but before the row is marked runs it again.
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import {
  OUTBOX_PAYLOAD_SCHEMAS,
  OUTBOX_TOPICS,
  type JobHandler,
  type JobOutcome,
  type JobRegistration,
  type JobRunner,
  type OutboxJob,
  type OutboxTopic,
} from "../contracts/index";
import type { AppDb } from "../db/client";
import { outbox } from "../db/schema";
import type { CoreServices } from "../deps";

export interface JobRunnerDeps extends CoreServices {
  readonly registrations: readonly JobRegistration[];
}

const POLL_INTERVAL_MS = 1_000;
const BATCH_SIZE = 8;
const LEASE_MS = 120_000;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 300_000;
/** After this many attempts a job goes dead; the saga's recovery task enqueues a fresh one for a money step. */
const MAX_ATTEMPTS = 12;

interface ClaimedRow {
  readonly id: string;
  readonly tenantId: string;
  readonly topic: string;
  readonly payload: unknown;
  readonly attempts: number;
  readonly createdAt: Date;
}

function isTopic(value: string): value is OutboxTopic {
  return (OUTBOX_TOPICS as readonly string[]).includes(value);
}

function backoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000);
}

export function createJobRunner(deps: JobRunnerDeps): JobRunner {
  const handlers = new Map<OutboxTopic, JobHandler<OutboxTopic>>();
  for (const registration of deps.registrations) {
    for (const topic of OUTBOX_TOPICS) {
      const handler = registration.handlers[topic];
      if (handler !== undefined) handlers.set(topic, handler as JobHandler<OutboxTopic>);
    }
  }
  const periodic = deps.registrations.flatMap((registration) => registration.periodic);

  let timers: NodeJS.Timeout[] = [];
  let started = false;
  let draining: Promise<number> | null = null;
  let kickAgain = false;

  async function claim(db: AppDb, limit: number): Promise<ClaimedRow[]> {
    const now = deps.clock();
    const leaseUntil = new Date(now.getTime() + LEASE_MS);
    return db.transaction(async (tx) => {
      const due = await tx
        .select({ id: outbox.id })
        .from(outbox)
        .where(
          and(
            isNull(outbox.publishedAt),
            isNull(outbox.deadAt),
            lte(outbox.availableAt, now),
            or(isNull(outbox.lockedUntil), lte(outbox.lockedUntil, now)),
          ),
        )
        .orderBy(asc(outbox.availableAt))
        .limit(limit)
        .for("update", { skipLocked: true });
      const claimed: ClaimedRow[] = [];
      for (const { id } of due) {
        const [row] = await tx
          .update(outbox)
          .set({ attempts: sql`${outbox.attempts} + 1`, lockedUntil: leaseUntil })
          .where(eq(outbox.id, id))
          .returning();
        if (row !== undefined) {
          claimed.push({ id: row.id, tenantId: row.tenantId, topic: row.topic, payload: row.payload, attempts: row.attempts, createdAt: row.createdAt });
        }
      }
      return claimed;
    });
  }

  async function finish(db: AppDb, row: ClaimedRow, outcome: JobOutcome): Promise<void> {
    const now = deps.clock();
    if (outcome.status === "done") {
      await db.update(outbox).set({ publishedAt: now, lockedUntil: null, lastError: null }).where(eq(outbox.id, row.id));
      return;
    }
    if (outcome.status === "dead" || row.attempts >= MAX_ATTEMPTS) {
      deps.log.error({ job: { id: row.id, topic: row.topic, attempts: row.attempts }, error: outcome.error }, "outbox job is dead");
      await db.update(outbox).set({ deadAt: now, lockedUntil: null, lastError: outcome.error }).where(eq(outbox.id, row.id));
      return;
    }
    const delayMs = outcome.delayMs ?? backoffMs(row.attempts);
    deps.log.warn({ job: { id: row.id, topic: row.topic, attempts: row.attempts, delay_ms: delayMs }, error: outcome.error }, "outbox job will retry");
    await db
      .update(outbox)
      .set({ availableAt: new Date(now.getTime() + delayMs), lockedUntil: null, lastError: outcome.error })
      .where(eq(outbox.id, row.id));
  }

  async function runOne(row: ClaimedRow): Promise<JobOutcome> {
    if (!isTopic(row.topic)) return { status: "dead", error: `unknown topic ${row.topic}` };
    const handler = handlers.get(row.topic);
    if (handler === undefined) return { status: "dead", error: `no handler registered for ${row.topic}` };
    const payload = OUTBOX_PAYLOAD_SCHEMAS[row.topic].safeParse(row.payload);
    if (!payload.success) return { status: "dead", error: `invalid payload for ${row.topic}` };
    const job = { id: row.id, tenantId: row.tenantId, topic: row.topic, payload: payload.data, attempts: row.attempts, createdAt: row.createdAt } as OutboxJob<OutboxTopic>;
    try {
      return await handler(job);
    } catch (error) {
      return { status: "retry", error: errorText(error) };
    }
  }

  async function runDue(limit: number = BATCH_SIZE): Promise<number> {
    const db = deps.db;
    if (db === null) return 0;
    const claimed = await claim(db, limit);
    await Promise.all(
      claimed.map(async (row) => {
        const outcome = await runOne(row);
        await finish(db, row, outcome);
      }),
    );
    return claimed.length;
  }

  function drain(): void {
    if (draining !== null) {
      kickAgain = true;
      return;
    }
    const loop = async (): Promise<number> => {
      let total = 0;
      for (;;) {
        kickAgain = false;
        const ran = await runDue();
        total += ran;
        if (!started || (ran === 0 && !kickAgain)) return total;
      }
    };
    draining = loop()
      .catch((error: unknown) => {
        deps.log.error({ err: error }, "outbox poll failed");
        return 0;
      })
      .finally(() => {
        draining = null;
      });
  }

  return {
    start() {
      if (started) return;
      if (deps.db === null) {
        deps.log.warn("outbox job runner not started: no database");
        return;
      }
      started = true;
      timers.push(setInterval(drain, POLL_INTERVAL_MS));
      for (const task of periodic) {
        let running = false;
        timers.push(
          setInterval(() => {
            if (running) return;
            running = true;
            task
              .run()
              .catch((error: unknown) => deps.log.error({ err: error, task: task.name }, "periodic task failed"))
              .finally(() => {
                running = false;
              });
          }, task.intervalMs),
        );
      }
      drain();
    },
    async stop() {
      started = false;
      for (const timer of timers) clearInterval(timer);
      timers = [];
      if (draining !== null) await draining;
    },
    kick() {
      if (started) drain();
    },
    runDue,
  };
}
