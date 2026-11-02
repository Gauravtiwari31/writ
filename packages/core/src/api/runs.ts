// Built-in agent runs (P0-3; owner: agents stream; routes in apps/gateway/src/routes/runs.ts).
// Atlas and Scout run as background runs inside the gateway process, started from the Wallet, and
// reach the gateway ONLY through the public agent API with their own key. Every step is persisted
// (agent_run_events) and pushed over SSE as `run.event`, which feeds the live timeline.
import { z } from "zod";
import { idSchema } from "../ids";
import { MinorAmountSchema } from "../money";
import { PolicyReasonSchema } from "../policy/decision";
import { PurchaseStateSchema } from "../purchase";
import { VerdictSchema } from "../verdicts";
import { localIdSchema, MinorDigitsSchema, TimestampSchema } from "./common";
import { BuiltinAgentKindSchema } from "./agents";

export const RunIdSchema = localIdSchema("run");

export const RUN_STATUSES = ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"] as const;
export const RunStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/** "hero": judge mode's one-click scenes 4-8 (plan §18); "manual": started from the Wallet. */
export const RUN_MODES = ["manual", "hero"] as const;
export const RunModeSchema = z.enum(RUN_MODES);
export type RunMode = z.infer<typeof RunModeSchema>;

export const RUN_FAILURE_CODES = [
  "ai_unavailable",
  "writ_not_active",
  "agent_not_bound",
  "step_limit",
  "timeout",
  "interrupted",
  "gateway_error",
  "rate_limited",
  "internal_error",
] as const;
export const RunFailureCodeSchema = z.enum(RUN_FAILURE_CODES);
export type RunFailureCode = z.infer<typeof RunFailureCodeSchema>;

export const RunViewSchema = z.strictObject({
  run_id: RunIdSchema,
  agent_id: idSchema("agt"),
  agent_kind: BuiltinAgentKindSchema,
  writ_id: idSchema("wr"),
  mode: RunModeSchema,
  status: RunStatusSchema,
  goal: z.string().min(1).max(500),
  failure_code: RunFailureCodeSchema.nullable(),
  failure_detail: z.string().max(500).nullable(),
  /** The last purchase this run checked out, if any. */
  purchase_id: idSchema("pur").nullable(),
  steps: z.int().min(0),
  tokens: z.int().min(0),
  started_at: TimestampSchema.nullable(),
  finished_at: TimestampSchema.nullable(),
  created_at: TimestampSchema,
});
export type RunView = z.infer<typeof RunViewSchema>;

export const AGENT_TOOLS = ["get_writ", "search_products", "read_page", "propose_cart", "checkout"] as const;
export const AgentToolSchema = z.enum(AGENT_TOOLS);
export type AgentTool = z.infer<typeof AgentToolSchema>;

const UntrustedText = (max: number) => z.string().max(max);

/** One timeline row. Text from pages or the agent is UNTRUSTED: rendered as text, never as HTML. */
export const RunEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("run.started"), agent_kind: BuiltinAgentKindSchema, writ_id: idSchema("wr"), goal: z.string().max(500) }),
  /** The agent's own narration (untrusted, capped). */
  z.strictObject({ type: z.literal("agent.message"), text: UntrustedText(2000) }),
  z.strictObject({ type: z.literal("tool.called"), tool: AgentToolSchema, input: z.record(z.string(), z.unknown()) }),
  z.strictObject({ type: z.literal("tool.result"), tool: AgentToolSchema, ok: z.boolean(), summary: UntrustedText(500) }),
  z.strictObject({
    type: z.literal("search.results"),
    query: UntrustedText(200),
    source: z.enum(["channel3", "fixture", "unavailable"]),
    items: z
      .array(
        z.strictObject({
          product_ref: z.string().max(128),
          title: UntrustedText(200),
          price_minor: MinorAmountSchema,
          merchant_id: z.string().max(64),
        }),
      )
      .max(30),
  }),
  /** A page the agent read. `hidden_chars` > 0 means the page carried text a human could not see. */
  z.strictObject({
    type: z.literal("page.read"),
    url: z.string().max(2048),
    title: UntrustedText(200).nullable(),
    visible_chars: z.int().min(0),
    hidden_chars: z.int().min(0),
  }),
  z.strictObject({
    type: z.literal("cart.proposed"),
    cart_id: idSchema("crt"),
    total_minor: MinorDigitsSchema,
    verdict: VerdictSchema,
    reasons: z.array(PolicyReasonSchema),
  }),
  z.strictObject({
    type: z.literal("checkout.result"),
    purchase_id: idSchema("pur"),
    status: PurchaseStateSchema,
    verdict: VerdictSchema.nullable(),
    money_moved: z.boolean(),
  }),
  z.strictObject({ type: z.literal("run.finished"), status: RunStatusSchema, failure_code: RunFailureCodeSchema.nullable() }),
]);
export type RunEvent = z.infer<typeof RunEventSchema>;
export type RunEventType = RunEvent["type"];

export const RunEventViewSchema = z.strictObject({
  run_id: RunIdSchema,
  /** 1-based, gap-free within a run. */
  seq: z.int().positive(),
  at: TimestampSchema,
  event: RunEventSchema,
});
export type RunEventView = z.infer<typeof RunEventViewSchema>;

// POST /v1/runs → 202 RunView
export const StartRunRequestSchema = z.strictObject({
  agent: BuiltinAgentKindSchema,
  writ_id: idSchema("wr"),
  goal: z.string().min(1).max(500).optional(),
});
export type StartRunRequest = z.infer<typeof StartRunRequestSchema>;

// GET /v1/runs, GET /v1/runs/:id
export const ListRunsResponseSchema = z.strictObject({ runs: z.array(RunViewSchema).max(200) });
export type ListRunsResponse = z.infer<typeof ListRunsResponseSchema>;
export const RunDetailResponseSchema = z.strictObject({
  run: RunViewSchema,
  events: z.array(RunEventViewSchema).max(2000),
});
export type RunDetailResponse = z.infer<typeof RunDetailResponseSchema>;
