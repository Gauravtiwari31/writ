// The purchase state machine (plan §6.3) as data, plus the closed value lists the gateway stores
// next to it. The gateway's saga (money stream) may only move a purchase along PURCHASE_TRANSITIONS;
// apps/gateway/src/db/enums.ts mirrors PURCHASE_STATES for its CHECK constraint (asserted in tests).
import { z } from "zod";

export const PURCHASE_STATES = [
  "PROPOSED",
  "BLOCKED",
  "RESERVED",
  "AUTHORIZING",
  "AUTHORIZED",
  "FAILED",
  "VERIFYING",
  "CAPTURING",
  "AWAITING_HUMAN",
  "VOIDING",
  "CAPTURED",
  "VOIDED",
  "REFUNDED",
  "DISPUTED",
  "DISPUTE_WON",
  "DISPUTE_LOST",
] as const;
export const PurchaseStateSchema = z.enum(PURCHASE_STATES);
export type PurchaseState = z.infer<typeof PurchaseStateSchema>;

/**
 * Every allowed edge. Beyond the §6.3 diagram: AUTHORIZED → VOIDING (kill switch or revoke before
 * verification starts), RESERVED → FAILED (nothing to authorize with, e.g. PayPal unconfigured or
 * no vaulted wallet) and CAPTURING → VOIDING (PayPal permanently refused the capture; the
 * authorization is voided and the settled budget reversed).
 */
export const PURCHASE_TRANSITIONS: Readonly<Record<PurchaseState, readonly PurchaseState[]>> = {
  PROPOSED: ["BLOCKED", "RESERVED"],
  RESERVED: ["AUTHORIZING", "FAILED"],
  AUTHORIZING: ["AUTHORIZED", "FAILED"],
  AUTHORIZED: ["VERIFYING", "VOIDING"],
  VERIFYING: ["CAPTURING", "AWAITING_HUMAN", "VOIDING"],
  AWAITING_HUMAN: ["CAPTURING", "VOIDING"],
  CAPTURING: ["CAPTURED", "VOIDING"],
  VOIDING: ["VOIDED"],
  CAPTURED: ["REFUNDED", "DISPUTED"],
  DISPUTED: ["DISPUTE_WON", "DISPUTE_LOST"],
  BLOCKED: [],
  FAILED: [],
  VOIDED: [],
  REFUNDED: [],
  DISPUTE_WON: [],
  DISPUTE_LOST: [],
};

export function canTransition(from: PurchaseState, to: PurchaseState): boolean {
  const next = Object.hasOwn(PURCHASE_TRANSITIONS, from) ? PURCHASE_TRANSITIONS[from] : undefined;
  return next !== undefined && next.includes(to);
}

/** No outgoing edge: the saga is finished with this purchase. */
export function isTerminalPurchaseState(state: PurchaseState): boolean {
  return Object.hasOwn(PURCHASE_TRANSITIONS, state) && PURCHASE_TRANSITIONS[state].length === 0;
}

/** A live PayPal authorization exists and nothing is capturing it yet: the kill switch and a revoke void these. */
export const VOIDABLE_PURCHASE_STATES = ["AUTHORIZED", "VERIFYING", "AWAITING_HUMAN"] as const satisfies readonly PurchaseState[];

/**
 * A PayPal call may be in flight: each of these has exactly one live outbox job for its step, and
 * the 30 s recovery task keeps it that way (revives a dead job, re-enqueues a missing one) with the
 * same PayPal-Request-Id `<purchase_id>:<step>`, so PayPal replays and never repeats (plan §6.8).
 */
export const RECOVERABLE_PURCHASE_STATES = ["AUTHORIZING", "CAPTURING", "VOIDING"] as const satisfies readonly PurchaseState[];

/**
 * Only a live checkout request moves these forward. Recovery fails them closed once they are older
 * than STALLED_PIPELINE_MS (checkout.ts): PROPOSED → BLOCKED and RESERVED → FAILED with
 * checkout_interrupted ($0 held), AUTHORIZED / VERIFYING → VOIDING with verification_interrupted.
 * (RESERVED never rests: saga.reserveAndAuthorize commits PROPOSED → RESERVED → AUTHORIZING or
 * → FAILED in one transaction; the rule is defense in depth.)
 */
export const PIPELINE_PURCHASE_STATES = ["PROPOSED", "RESERVED", "AUTHORIZED", "VERIFYING"] as const satisfies readonly PurchaseState[];

/** Money is held or moved: PayPal has an authorization or a capture for these. */
export const MONEY_HELD_STATES = [
  "AUTHORIZED",
  "VERIFYING",
  "AWAITING_HUMAN",
  "CAPTURING",
  "VOIDING",
] as const satisfies readonly PurchaseState[];

/**
 * Why a purchase is in its current state (purchases.state_reason). Stable codes the Wallet, the
 * console and the agents switch on; never free text.
 */
export const PURCHASE_STATE_REASONS = [
  // BLOCKED: no PayPal call was made, $0 moved.
  "policy_blocked",
  "budget_exhausted",
  // BLOCKED (from PROPOSED) or FAILED (from RESERVED) by recovery: the checkout request died before
  // any authorization was requested; $0 held, the agent retries with a new Idempotency-Key.
  "checkout_interrupted",
  // FAILED at RESERVED or AUTHORIZING: the reservation is released.
  "paypal_unconfigured",
  "paypal_not_connected",
  "paypal_error",
  "payer_action_required",
  "authorization_declined",
  // VOIDING / VOIDED: the authorization is voided and the reservation released.
  "verifier_blocked",
  "human_declined",
  "approval_expired",
  "kill_switch",
  "writ_revoked",
  "writ_expired",
  "settle_refused",
  "capture_failed",
  "verification_interrupted",
  // After capture.
  "platform_liability",
  "dispute_opened",
  "dispute_won",
  "dispute_lost",
] as const;
export const PurchaseStateReasonSchema = z.enum(PURCHASE_STATE_REASONS);
export type PurchaseStateReason = z.infer<typeof PurchaseStateReasonSchema>;

/**
 * decisions.stage values: one row per pipeline stage (plan §6.2, P0-4), plus "preview" for the
 * cart-propose policy preview and "human" for the passkey approval or decline.
 */
export const DECISION_RECORD_STAGES = [
  "preview",
  "schema",
  "policy",
  "threshold",
  "reserve",
  "authorize",
  "sentinel",
  "verifier",
  "combiner",
  "human",
] as const;
export const DecisionRecordStageSchema = z.enum(DECISION_RECORD_STAGES);
export type DecisionRecordStage = z.infer<typeof DecisionRecordStageSchema>;

/** approvals.status (P0-6). */
export const APPROVAL_STATUSES = ["PENDING", "APPROVED", "DECLINED", "EXPIRED", "CANCELLED"] as const;
export const ApprovalStatusSchema = z.enum(APPROVAL_STATUSES);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

/** Human-review window (plan P0-6): well inside the PayPal authorization honor period, so no re-authorization. */
export const APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;
