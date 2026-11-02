// Durable jobs (plan §6.1/§6.8, decision 3): the outbox table is the queue. A topic's row is
// inserted in the same transaction as the state change it follows from (TxContext.enqueue), and
// the in-process poller (money stream, src/jobs) claims due rows with FOR UPDATE SKIP LOCKED,
// leases them (locked_until), runs the handler registered for the topic, and marks the row
// published, retried with backoff, or dead. Handlers MUST be idempotent: a crash after a handler's
// commit but before the row is marked done runs it again.
//
// FROZEN for the parallel build: adding a topic is an architect change (docs/ARCHITECTURE.md).
import { DisputeActionSchema, idSchema, PurchaseStateReasonSchema } from "@writ/core";
import { localIdSchema } from "@writ/core/api";
import { z } from "zod";

export const OUTBOX_TOPICS = [
  "purchase.authorize",
  "purchase.capture",
  "purchase.void",
  "purchase.refund",
  "approval.expire",
  "paypal.webhook",
  "dispute.sync",
  "dispute.execute",
] as const;
export type OutboxTopic = (typeof OUTBOX_TOPICS)[number];

const PurchaseRef = { purchase_id: idSchema("pur") };

/** Payload contract per topic; TxContext.enqueue validates before inserting (a bad payload rolls back). */
export const OUTBOX_PAYLOAD_SCHEMAS = {
  /** money: AUTHORIZING → PayPal create order (vault, custom_id = C_pre) → AUTHORIZED | FAILED. */
  "purchase.authorize": z.strictObject(PurchaseRef),
  /** money: CAPTURING → PayPal capture (exact amount, final_capture, invoice_id = C_post) → CAPTURED. */
  "purchase.capture": z.strictObject(PurchaseRef),
  /** money: VOIDING → PayPal void → VOIDED. */
  "purchase.void": z.strictObject({ ...PurchaseRef, reason: PurchaseStateReasonSchema }),
  /** money: CAPTURED → PayPal refund (platform liability) → REFUNDED. */
  "purchase.refund": z.strictObject({ ...PurchaseRef, reason: PurchaseStateReasonSchema }),
  /** money: scheduled at approvals.expires_at; still PENDING → EXPIRED → VOIDING (24 h auto-void). */
  "approval.expire": z.strictObject({ approval_id: idSchema("apr") }),
  /** money: a verified, deduped webhook_events row; re-fetch the resource from PayPal before acting (§22 rule 15). */
  "paypal.webhook": z.strictObject({ event_id: z.string().min(1).max(128) }),
  /** evidence: GET the dispute → load evidence → analyst → auto PROVIDE_EVIDENCE or wait for a human. */
  "dispute.sync": z.strictObject({ paypal_dispute_id: z.string().min(1).max(64), event_id: z.string().min(1).max(128).nullable() }),
  /** evidence: execute an approved dispute action (auto, or the human click in the console). */
  "dispute.execute": z.strictObject({
    dispute_id: localIdSchema("dsp"),
    action: DisputeActionSchema,
    requested_by: z.enum(["auto", "human"]),
  }),
} as const satisfies Record<OutboxTopic, z.ZodType>;

export type OutboxPayload<T extends OutboxTopic> = z.output<(typeof OUTBOX_PAYLOAD_SCHEMAS)[T]>;

export interface OutboxJob<T extends OutboxTopic = OutboxTopic> {
  readonly id: string;
  readonly tenantId: string;
  readonly topic: T;
  readonly payload: OutboxPayload<T>;
  /** Including the current attempt (1 on the first run). */
  readonly attempts: number;
  readonly createdAt: Date;
}

export type JobOutcome =
  | { status: "done" }
  /** Retry later with backoff (default: exponential from 1 s, capped at 5 min). */
  | { status: "retry"; error: string; delayMs?: number }
  /** Give up: the row gets dead_at and stays for inspection. */
  | { status: "dead"; error: string };

export type JobHandler<T extends OutboxTopic> = (job: OutboxJob<T>) => Promise<JobOutcome>;
export type JobHandlers = { [T in OutboxTopic]?: JobHandler<T> };

/** Work on a timer (e.g. the 30 s saga recovery job, the approval-timeout and Writ-expiry sweeps). */
export interface PeriodicTask {
  readonly name: string;
  readonly intervalMs: number;
  run(): Promise<void>;
}

/** What each stream module contributes to the runner. */
export interface JobRegistration {
  readonly handlers: JobHandlers;
  readonly periodic: readonly PeriodicTask[];
}

export interface JobRunner {
  /** Starts polling and the periodic tasks (server.ts, when JOBS_ENABLED). */
  start(): void;
  /** Stops polling and waits for in-flight handlers. */
  stop(): Promise<void>;
  /** Poll now: the unit of work calls it after a commit that enqueued work. */
  kick(): void;
  /** Claims and runs due jobs once; resolves with how many ran (tests, evals, the chaos test). */
  runDue(limit?: number): Promise<number>;
}
