// Built-in agent runs (P0-3, plan decision 6). Atlas and Scout run as background work in the gateway
// process but cross the same trust boundary as any external agent: a fresh key minted at run start,
// kept in memory, used only against the public agent API. Every step is persisted and pushed over SSE.
import type { JsonValue } from "@writ/core";
import { RunEventSchema, type BuiltinAgentKind, type RunEvent, type RunEventView, type RunFailureCode, type RunStatus, type RunView } from "@writ/core/api";
import { and, asc, eq, inArray, lt } from "drizzle-orm";
import { AgentApiClient, createAtlas, createScout } from "@writ/agents";
import { mintAgentKey } from "../auth/agent-keys";
import type { AgentRunner, StartRunInput } from "../contracts/index";
import type { Db } from "../db/client";
import { agentRunEvents, agentRuns, agents, writs, type AgentRun } from "../db/schema";
import { requireDb, type CoreServices } from "../deps";
import { httpError } from "../http/errors";

const RUN_TIMEOUT_MS = 5 * 60_000;
/** A run this quiet at boot has no live owner, even while an old instance overlaps during a deploy. */
const ORPHANED_AFTER_MS = 2 * 60_000;

export function runView(row: AgentRun): RunView {
  return {
    run_id: row.id,
    agent_id: row.agentId as RunView["agent_id"],
    agent_kind: row.agentKind,
    writ_id: row.writId as RunView["writ_id"],
    mode: row.mode,
    status: row.status,
    goal: row.goal,
    failure_code: row.failureCode as RunFailureCode | null,
    failure_detail: row.failureDetail,
    purchase_id: row.purchaseId as RunView["purchase_id"],
    steps: row.steps,
    tokens: row.tokens,
    started_at: row.startedAt?.toISOString() ?? null,
    finished_at: row.finishedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}

export async function runDetail(db: Db, tenantId: string, runId: string): Promise<{ run: RunView; events: RunEventView[] }> {
  const [row] = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.tenantId, tenantId)));
  if (row === undefined) throw httpError.notFound("Run");
  const events = await db.select().from(agentRunEvents).where(eq(agentRunEvents.runId, runId)).orderBy(asc(agentRunEvents.seq)).limit(2000);
  return {
    run: runView(row),
    events: events.map((event) => ({ run_id: runId, seq: event.seq, at: event.createdAt.toISOString(), event: RunEventSchema.parse(event.payload) })),
  };
}

export function createAgentRunner(deps: CoreServices): AgentRunner {
  const active = new Map<string, { abort: AbortController; done: Promise<void> }>();

  async function emit(tenantId: string, runId: string, seqRef: { value: number }, event: RunEvent): Promise<void> {
    seqRef.value += 1;
    const seq = seqRef.value;
    const parsed = RunEventSchema.parse(event);
    await deps.uow.run(tenantId, async (ctx) => {
      await ctx.db.insert(agentRunEvents).values({ tenantId, runId, seq, type: parsed.type, payload: parsed as unknown as JsonValue, createdAt: ctx.now });
      await ctx.db.update(agentRuns).set({ updatedAt: ctx.now }).where(eq(agentRuns.id, runId));
      ctx.emit({ type: "run.event", data: { run_id: runId, seq, at: ctx.now.toISOString(), event: parsed } });
    });
  }

  async function finish(tenantId: string, runId: string, seqRef: { value: number }, result: { status: RunStatus; failure_code: RunFailureCode | null; failure_detail: string | null; purchase_id?: string | null; steps?: number; tokens?: number }): Promise<void> {
    await emit(tenantId, runId, seqRef, { type: "run.finished", status: result.status, failure_code: result.failure_code });
    await deps.uow.run(tenantId, async (ctx) => {
      const [row] = await ctx.db
        .update(agentRuns)
        .set({
          status: result.status,
          failureCode: result.failure_code,
          failureDetail: result.failure_detail?.slice(0, 500) ?? null,
          ...(result.purchase_id == null ? {} : { purchaseId: result.purchase_id }),
          steps: result.steps ?? 0,
          tokens: result.tokens ?? 0,
          finishedAt: ctx.now,
          updatedAt: ctx.now,
        })
        .where(eq(agentRuns.id, runId))
        .returning();
      if (row !== undefined) ctx.emit({ type: "run.updated", data: runView(row) });
    });
  }

  async function execute(input: StartRunInput, runId: string, agentId: string, kind: BuiltinAgentKind, goal: string, abort: AbortController): Promise<void> {
    const seq = { value: 0 };
    const tenantId = input.tenantId;
    const timer = setTimeout(() => abort.abort(), RUN_TIMEOUT_MS);
    try {
      await emit(tenantId, runId, seq, { type: "run.started", agent_kind: kind, writ_id: input.writId as never, goal });
      const models = deps.ai.agentModels;
      if (models === null) {
        await finish(tenantId, runId, seq, { status: "FAILED", failure_code: "ai_unavailable", failure_detail: "No agent model is configured (MODEL_AGENT)." });
        return;
      }
      const reader = deps.ai.reader;
      if (kind === "scout" && reader === null) {
        await finish(tenantId, runId, seq, { status: "FAILED", failure_code: "ai_unavailable", failure_detail: "Scout needs a reader model (MODEL_READER)." });
        return;
      }
      const minted = mintAgentKey();
      await requireDb(deps).update(agents).set({ apiKeyHash: minted.hash, keyHint: minted.hint }).where(eq(agents.id, agentId));
      const client = new AgentApiClient({ baseUrl: deps.config.gatewayInternalUrl, apiKey: minted.key });
      const agent = kind === "scout" && reader !== null ? createScout({ models, client, pageReader: deps.pages, reader }) : createAtlas({ models, client, pageReader: deps.pages });
      const result = await agent.run({
        writId: input.writId,
        goal,
        signal: abort.signal,
        emit: (event) => emit(tenantId, runId, seq, event),
        consumeLlmCall: () => deps.limits.tryConsumeLlmCall(),
      });
      await finish(tenantId, runId, seq, result);
    } catch (error) {
      deps.log.error({ err: error, run_id: runId }, "agent run failed");
      await finish(tenantId, runId, seq, { status: "FAILED", failure_code: "internal_error", failure_detail: "The run stopped on an internal error." }).catch(() => undefined);
    } finally {
      clearTimeout(timer);
      active.delete(runId);
    }
  }

  return {
    async start(input) {
      const db = requireDb(deps);
      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.userId, input.userId), eq(agents.tenantId, input.tenantId), eq(agents.builtinKind, input.agentKind)));
      if (agent === undefined) throw httpError.notFound("Agent");
      const [writ] = await db
        .select({ status: writs.status, agentId: writs.agentId, body: writs.body })
        .from(writs)
        .where(and(eq(writs.id, input.writId), eq(writs.tenantId, input.tenantId)));
      if (writ === undefined) throw httpError.notFound("Writ");
      if (writ.status !== "ACTIVE") throw httpError.conflict("writ_not_active", "This Writ is not active.");
      if (writ.agentId !== agent.id) throw httpError.conflict("agent_not_bound", "This Writ is signed for a different agent.");
      const running = await db
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(and(eq(agentRuns.agentId, agent.id), inArray(agentRuns.status, ["QUEUED", "RUNNING"])));
      if (running.some((row) => active.has(row.id))) throw httpError.conflict("run_active", "This agent is already running.");

      const goal = input.goal ?? String((writ.body as { purpose?: unknown }).purpose ?? "Buy what the Writ allows.");
      const id = deps.ids("run");
      const now = deps.clock();
      const [row] = await db
        .insert(agentRuns)
        .values({ id, tenantId: input.tenantId, userId: input.userId, agentId: agent.id, writId: input.writId, agentKind: input.agentKind, mode: input.mode, status: "RUNNING", goal, startedAt: now, createdAt: now, updatedAt: now })
        .returning();
      if (row === undefined) throw new Error("run insert returned no row");
      const abort = new AbortController();
      const done = execute(input, id, agent.id, input.agentKind, goal, abort);
      active.set(id, { abort, done });
      return runView(row);
    },

    async stop(input) {
      const handle = active.get(input.runId);
      if (handle !== undefined) {
        handle.abort.abort();
        await handle.done;
      }
      return (await runDetail(requireDb(deps), input.tenantId, input.runId)).run;
    },

    async recoverOnStartup() {
      const db = deps.db;
      if (db === null) return;
      const cutoff = new Date(deps.clock().getTime() - ORPHANED_AFTER_MS);
      await db
        .update(agentRuns)
        .set({ status: "FAILED", failureCode: "interrupted", failureDetail: "The gateway restarted during this run.", finishedAt: deps.clock() })
        .where(and(inArray(agentRuns.status, ["QUEUED", "RUNNING"]), lt(agentRuns.updatedAt, cutoff)));
    },

    async shutdown() {
      for (const handle of active.values()) handle.abort.abort();
      await Promise.allSettled([...active.values()].map((handle) => handle.done));
    },
  };
}
