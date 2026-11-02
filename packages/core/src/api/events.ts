// GET /v1/stream: Server-Sent Events, tenant-scoped, fed only from committed state (events are
// published after COMMIT by the gateway's unit of work, or by the agent-run runner for timeline
// rows). Frames are unnamed SSE messages:
//
//   id: <message id>
//   data: <JSON StreamMessage>
//
// plus a ": ping" comment every 15 s. Reconnects send Last-Event-ID; the gateway replays what it
// still buffers, and a client that missed too much should refetch with the GET endpoints.
import { z } from "zod";
import { TimestampSchema } from "./common";
import { ApprovalViewSchema } from "./approvals";
import { DisputeViewSchema } from "./disputes";
import { VaultStatusViewSchema } from "./paypal";
import { AttackViewSchema, DecisionViewSchema, LedgerEventViewSchema, PurchaseViewSchema } from "./purchases";
import { RunEventViewSchema, RunViewSchema } from "./runs";
import { BudgetViewSchema, KillSwitchResponseSchema, WritViewSchema } from "./writs";

export const StreamEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("purchase.updated"), data: PurchaseViewSchema }),
  z.strictObject({ type: z.literal("decision.recorded"), data: DecisionViewSchema }),
  z.strictObject({ type: z.literal("attack.detected"), data: AttackViewSchema }),
  z.strictObject({ type: z.literal("approval.updated"), data: ApprovalViewSchema }),
  z.strictObject({ type: z.literal("writ.updated"), data: WritViewSchema }),
  z.strictObject({ type: z.literal("budget.updated"), data: BudgetViewSchema }),
  z.strictObject({ type: z.literal("ledger.appended"), data: LedgerEventViewSchema }),
  z.strictObject({ type: z.literal("run.updated"), data: RunViewSchema }),
  z.strictObject({ type: z.literal("run.event"), data: RunEventViewSchema }),
  z.strictObject({ type: z.literal("dispute.updated"), data: DisputeViewSchema }),
  z.strictObject({ type: z.literal("paypal.updated"), data: VaultStatusViewSchema }),
  z.strictObject({ type: z.literal("kill_switch.engaged"), data: KillSwitchResponseSchema }),
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;
export type StreamEventType = StreamEvent["type"];
export const STREAM_EVENT_TYPES = StreamEventSchema.options.map((option) => option.shape.type.value);

export const StreamMessageSchema = z.strictObject({
  /** "<boot id>-<counter>": unique across restarts, increasing within one process. */
  id: z.string().regex(/^[0-9a-z]{1,16}-[0-9]{1,15}$/),
  at: TimestampSchema,
  event: StreamEventSchema,
});
export type StreamMessage = z.infer<typeof StreamMessageSchema>;

export const SSE_HEARTBEAT_MS = 15_000;
