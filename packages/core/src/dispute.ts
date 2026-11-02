// Dispute Analyst contract (plan §8.6) and the auto-execute rule. The analyst only recommends; the
// dispute engine executes PROVIDE_EVIDENCE on its own only when canAutoExecute() says so, and every
// other action waits for a human click (plan P0-9).
import { z } from "zod";

export const DISPUTE_LIABILITIES = [
  "USER_AUTHORIZED",
  "MERCHANT_FULFILLED",
  "MERCHANT_MISREPRESENTATION",
  "PLATFORM_ERROR",
  "INCONCLUSIVE",
] as const;
export const DisputeLiabilitySchema = z.enum(DISPUTE_LIABILITIES);
export type DisputeLiability = z.infer<typeof DisputeLiabilitySchema>;

export const DISPUTE_ACTIONS = ["PROVIDE_EVIDENCE", "ACCEPT_CLAIM", "MAKE_OFFER", "ESCALATE_TO_HUMAN"] as const;
export const DisputeActionSchema = z.enum(DISPUTE_ACTIONS);
export type DisputeAction = z.infer<typeof DisputeActionSchema>;

// Any control character except LF.
const CONTROL_EXCEPT_NEWLINE_RE = /(?!\n)\p{Cc}/u;
const LONE_SURROGATE_RE = /\p{Cs}/u;

export const DisputeAnalysisSchema = z.strictObject({
  liability: DisputeLiabilitySchema,
  action: DisputeActionSchema,
  /** PayPal Disputes API evidence_type codes (e.g. PROOF_OF_FULFILLMENT); checked against the API by the engine. */
  evidence_types: z
    .array(z.string().regex(/^[A-Z][A-Z_]{2,59}$/, "an UPPER_SNAKE evidence type code"))
    .max(5),
  /** Plain-English note for the evidence submission. Newlines allowed, other control characters not. */
  note: z
    .string()
    .min(1)
    .max(1500)
    .refine((text) => !CONTROL_EXCEPT_NEWLINE_RE.test(text), "control characters are not allowed")
    .refine((text) => !LONE_SURROGATE_RE.test(text), "lone surrogates are not allowed")
    .refine((text) => text.trim().length > 0, "must not be blank"),
  confidence: z.number().min(0).max(1),
});
export type DisputeAnalysis = z.infer<typeof DisputeAnalysisSchema>;

export const DISPUTE_AUTO_EXECUTE_MIN_CONFIDENCE = 0.8;
const AUTO_LIABILITIES: ReadonlySet<DisputeLiability> = new Set(["USER_AUTHORIZED", "MERCHANT_FULFILLED"]);

/** Plan §8.6: only PROVIDE_EVIDENCE, confidence >= 0.8, liability USER_AUTHORIZED or MERCHANT_FULFILLED. */
export function canAutoExecute(analysis: DisputeAnalysis): boolean {
  const parsed = DisputeAnalysisSchema.safeParse(analysis);
  if (!parsed.success) return false;
  const a = parsed.data;
  return a.action === "PROVIDE_EVIDENCE" && a.confidence >= DISPUTE_AUTO_EXECUTE_MIN_CONFIDENCE && AUTO_LIABILITIES.has(a.liability);
}

/** What the engine records when no analyst model is configured or the analyst failed: a human decides. */
export const ANALYST_UNAVAILABLE: DisputeAnalysis = Object.freeze({
  liability: "INCONCLUSIVE",
  action: "ESCALATE_TO_HUMAN",
  evidence_types: [],
  note: "The dispute analyst is unavailable, so a person must review this dispute.",
  confidence: 0,
}) as DisputeAnalysis;
