// The deterministic policy decision (plan §6.2 step 3). It is plain JSON (amounts as minor-unit
// strings, explicit nulls, no bigint) because H_p = sha256(JCS(decision)) goes into the PayPal
// pre-commitment (§6.7). Any change to check ids, codes or message text changes H_p for the same
// inputs, so it must bump POLICY_VERSION.
import { z } from "zod";
import { toHex } from "../bytes";
import { hashJcs } from "../hash";
import { VerdictSchema } from "../verdicts";

export const POLICY_VERSION = "policy/0.1";

/** Every check runs on every cart, in this order, so the agent learns all problems in one round. */
export const POLICY_CHECK_IDS = [
  "writ.active",
  "writ.signature",
  "writ.not_expired",
  "writ.agent_bound",
  "cart.writ_match",
  "cart.agent_match",
  "cart.currency",
  "cart.total_consistent",
  "limits.per_order",
  "limits.budget",
  "limits.max_orders",
  "scope.categories",
  "scope.deny_kinds",
  "scope.merchants",
  "ship_to",
  "delivery.deadline",
  "velocity",
] as const;
export type PolicyCheckId = (typeof POLICY_CHECK_IDS)[number];

/** Not a pass/fail check: once every check passes, an amount above the threshold means REVIEW. */
export const THRESHOLD_CHECK_ID = "threshold.human_review";
export type ThresholdCheckId = typeof THRESHOLD_CHECK_ID;

/** Stable machine codes; agents and the UI switch on these, never on message text. */
export const POLICY_REASON_CODES = [
  "WRIT_NOT_ACTIVE",
  "WRIT_SIGNATURE_INVALID",
  "WRIT_EXPIRED",
  "AGENT_NOT_BOUND",
  "CART_WRIT_MISMATCH",
  "CART_AGENT_MISMATCH",
  "CURRENCY_MISMATCH",
  "CART_TOTAL_MISMATCH",
  "OVER_PER_ORDER_LIMIT",
  "OVER_BUDGET",
  "MAX_ORDERS_REACHED",
  "CATEGORY_NOT_ALLOWED",
  "KIND_DENIED",
  "MERCHANT_DENIED",
  "MERCHANT_NOT_ALLOWED",
  "SHIP_TO_LOCKED",
  "SHIP_TO_UNKNOWN",
  "ETA_MISSING",
  "ETA_AFTER_DEADLINE",
  "VELOCITY_LIMIT",
  "REVIEW_THRESHOLD",
] as const;
export type PolicyReasonCode = (typeof POLICY_REASON_CODES)[number];

/** Digits only, no length cap: a computed cart total can exceed the 16-digit input format. */
const MinorDigitsSchema = z.string().regex(/^(0|[1-9][0-9]*)$/, "minor units as a non-negative integer string");

export const PolicyReasonSchema = z.strictObject({
  check: z.enum([...POLICY_CHECK_IDS, THRESHOLD_CHECK_ID]),
  code: z.enum(POLICY_REASON_CODES),
  /** Plain English for the Wallet and for the agent to re-plan. Never echoes untrusted titles. */
  message: z.string().min(1),
  /** Path of the offending value, e.g. "cart.items[1].kind"; null when no single field is at fault. */
  field: z.string().min(1).nullable(),
  /** Amounts are minor-unit strings, counts decimal strings, lists comma-separated codes. */
  expected: z.string().nullable(),
  actual: z.string().nullable(),
});
export type PolicyReason = z.infer<typeof PolicyReasonSchema>;

export const PolicyCheckSchema = z
  .strictObject({
    id: z.enum(POLICY_CHECK_IDS),
    passed: z.boolean(),
    /** Per-item checks report one reason per offending line, so the list can be longer than one. */
    reasons: z.array(PolicyReasonSchema),
  })
  .refine((check) => check.passed === (check.reasons.length === 0), "passed must mean no reasons")
  .refine((check) => check.reasons.every((reason) => reason.check === check.id), "reasons must belong to the check");
export type PolicyCheck = z.infer<typeof PolicyCheckSchema>;

export const PolicyDecisionSchema = z.strictObject({
  policy_version: z.literal(POLICY_VERSION),
  verdict: VerdictSchema,
  /** The computed cart total (items + shipping + tax): what PayPal would be asked to authorize. */
  amount_minor: MinorDigitsSchema,
  checks: z.array(PolicyCheckSchema),
  /** BLOCK: every failed check's reasons, in check order. REVIEW: the threshold reason. APPROVE: []. */
  reasons: z.array(PolicyReasonSchema),
});
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

/** H_p = sha256(JCS(decision)) (plan §6.7). */
export function policyDecisionHash(decision: PolicyDecision): Uint8Array {
  return hashJcs(decision);
}

export function policyDecisionHashHex(decision: PolicyDecision): string {
  return toHex(policyDecisionHash(decision));
}
