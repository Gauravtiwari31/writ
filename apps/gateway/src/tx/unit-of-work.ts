// The unit of work behind §22 rule 14: every state change is ONE database transaction holding the
// state update + its ledger event(s) + its outbox row(s), and nothing leaves the process before
// COMMIT. Side effects are expressed as outbox rows (run by the job poller after commit) and SSE
// events (published by this module after commit). A transaction that rolls back emits nothing.
//
// Lock order inside a transaction (deadlock avoidance): writs row (lockWrit, also taken by
// appendLedger) → writ_budgets → purchases → approvals. Serialization failures, deadlocks and a lost
// ledger-append race are retried (the callback must be safe to run again: DB work only, no I/O).
//
// FROZEN for the parallel build (docs/ARCHITECTURE.md): money, api, evidence and judge all write
// through run(); nobody inserts into ledger_events or outbox directly.
import { fromHex } from "@writ/core";
import type { StreamEvent } from "@writ/core/api";
import { appendEvent, type JsonObject, type LedgerEvent, type LedgerEventType } from "@writ/ledger";
import { and, desc, eq } from "drizzle-orm";
import { OUTBOX_PAYLOAD_SCHEMAS, type OutboxPayload, type OutboxTopic } from "../contracts/jobs";
import type { AppDb, Db } from "../db/client";
import { pgError, PG_UNIQUE_VIOLATION } from "../db/errors";
import type { RowKind } from "../db/ids";
import { ledgerEvents, outbox, writs } from "../db/schema";
import type { EventBus } from "../events/bus";
import { httpError } from "../http/errors";
import { ledgerEventFromRow, ledgerEventView } from "./ledger";

export interface AppendLedgerInput {
  writId: string;
  /** Purchase-scoped events bind the purchase id into the hashed payload (@writ/ledger appendEvent). */
  purchaseId?: string | null;
  type: LedgerEventType;
  payload: JsonObject;
}

export interface EnqueueInput<T extends OutboxTopic = OutboxTopic> {
  topic: T;
  payload: OutboxPayload<T>;
  /** Run no earlier than this (e.g. approval.expire at expires_at). Default: now. */
  availableAt?: Date;
  /** Enqueue-once key, e.g. "purchase.capture:pur_...": a second enqueue with the same key is a no-op. */
  dedupeKey?: string;
}

export interface TxContext {
  /** The open transaction: run every query of this unit through it. */
  readonly db: Db;
  readonly tenantId: string;
  /** One clock reading for the whole transaction (ledger ts, updated_at, expires_at math). */
  readonly now: Date;
  /** SELECT … FOR UPDATE on the tenant's writ row; 404 when it does not exist in this tenant. */
  lockWrit(writId: string): Promise<void>;
  /** Appends to the Writ's hash chain (genesis must be WRIT_SIGNED) and queues a ledger.appended event. */
  appendLedger(input: AppendLedgerInput): Promise<LedgerEvent>;
  /** Inserts an outbox row after validating the payload; null when dedupeKey already exists. */
  enqueue<T extends OutboxTopic>(input: EnqueueInput<T>): Promise<string | null>;
  /** Queues an SSE event for after COMMIT. */
  emit(event: StreamEvent): void;
}

export interface UnitOfWork {
  run<T>(tenantId: string, fn: (ctx: TxContext) => Promise<T>): Promise<T>;
}

export interface UnitOfWorkDeps {
  db: AppDb | null;
  events: EventBus;
  clock: () => Date;
  ids: (kind: RowKind) => string;
  /** Called after a COMMIT that enqueued at least one job (the job runner's kick). */
  onEnqueued?: () => void;
  maxAttempts?: number;
}

const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(["40001", "40P01"]);

function isRetryable(error: unknown): boolean {
  const info = pgError(error);
  if (info === undefined) return false;
  if (RETRYABLE_SQLSTATES.has(info.code)) return true;
  return info.code === PG_UNIQUE_VIOLATION && info.constraint === "ledger_events_writ_prev_hash_unique";
}

export function createUnitOfWork(deps: UnitOfWorkDeps): UnitOfWork {
  const maxAttempts = deps.maxAttempts ?? 3;

  return {
    async run(tenantId, fn) {
      const db: Db | null = deps.db;
      if (db === null) throw httpError.unavailable("database_unavailable", "The gateway has no database configured.");
      for (let attempt = 1; ; attempt += 1) {
        const pending: StreamEvent[] = [];
        let enqueued = false;
        try {
          const result = await db.transaction(async (tx) => {
            const now = deps.clock();
            const locked = new Set<string>();

            const lockWrit = async (writId: string): Promise<void> => {
              if (locked.has(writId)) return;
              const rows = await tx
                .select({ id: writs.id })
                .from(writs)
                .where(and(eq(writs.id, writId), eq(writs.tenantId, tenantId)))
                .for("update");
              if (rows.length === 0) throw httpError.notFound("Writ");
              locked.add(writId);
            };

            const ctx: TxContext = {
              db: tx,
              tenantId,
              now,
              lockWrit,
              async appendLedger(input) {
                await lockWrit(input.writId);
                const [tailRow] = await tx
                  .select()
                  .from(ledgerEvents)
                  .where(eq(ledgerEvents.writId, input.writId))
                  .orderBy(desc(ledgerEvents.seq))
                  .limit(1);
                const tail = tailRow === undefined ? null : ledgerEventFromRow(tailRow);
                const event = appendEvent(tail, {
                  type: input.type,
                  payload: input.payload,
                  ts: now,
                  purchase_id: input.purchaseId ?? null,
                  ...(tail === null ? { writ_id: input.writId } : {}),
                });
                const [row] = await tx
                  .insert(ledgerEvents)
                  .values({
                    tenantId,
                    writId: event.writ_id,
                    purchaseId: event.purchase_id,
                    type: event.type,
                    payload: event.payload,
                    prevHash: fromHex(event.prev_hash),
                    hash: fromHex(event.hash),
                    ts: event.ts,
                  })
                  .returning({ seq: ledgerEvents.seq });
                if (row === undefined) throw new Error("ledger insert returned no row");
                const stored: LedgerEvent = { ...event, seq: row.seq };
                pending.push({ type: "ledger.appended", data: ledgerEventView(stored) });
                return stored;
              },
              async enqueue(input) {
                const payload = OUTBOX_PAYLOAD_SCHEMAS[input.topic].parse(input.payload);
                const id = deps.ids("outbox");
                const rows = await tx
                  .insert(outbox)
                  .values({
                    id,
                    tenantId,
                    topic: input.topic,
                    payload,
                    availableAt: input.availableAt ?? now,
                    dedupeKey: input.dedupeKey ?? null,
                  })
                  .onConflictDoNothing({ target: outbox.dedupeKey })
                  .returning({ id: outbox.id });
                if (rows.length === 0) return null;
                enqueued = true;
                return id;
              },
              emit(event) {
                pending.push(event);
              },
            };
            return fn(ctx);
          });
          // Committed: only now may anything leave the process.
          for (const event of pending) deps.events.publish(tenantId, event);
          if (enqueued) deps.onEnqueued?.();
          return result;
        } catch (error) {
          if (attempt >= maxAttempts || !isRetryable(error)) throw error;
        }
      }
    },
  };
}
