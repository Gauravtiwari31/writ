// The "second key" record (plan §6.2 steps 6-8, §6.7). After AUTHORIZE, the decision pipeline runs
// the Sentinel over every tainted source and the Verifier over the typed cart, then combines. This
// record is what H_verifier hashes into C_post = sha256(C_pre ‖ H_verifier ‖ H_approval), and what
// the evidence pack carries as `verifier`. It is built by the pipeline and stored on the decisions
// row of stage "combiner" (output + output_hash).
import { z } from "zod";
import { hashJcs, HashHexSchema } from "./hash";
import { idSchema, HttpUrlSchema } from "./ids";
import { COMBINER_REASON_CODES, DECISION_STAGES } from "./policy/combiner";
import { SentinelCategorySchema, VerdictSchema, VerifierOutputSchema } from "./verdicts";
import { IsoTimestampSchema } from "./writ";

export const VERIFICATION_SPEC = "writ-verification/0.1";

export const StageContributionSchema = z.strictObject({
  stage: z.enum(DECISION_STAGES),
  verdict: VerdictSchema,
  reason: z.strictObject({ code: z.enum(COMBINER_REASON_CODES), message: z.string().min(1).max(1000) }),
});

/** One Sentinel signal per scanned source, reduced to what the combiner used (spans live in the attacks table). */
export const SentinelSummarySchema = z.strictObject({
  /** The scanned source; null for a cart-line title or description scan. */
  source_url: HttpUrlSchema.max(2048).nullable(),
  status: z.enum(["ok", "error", "timeout"]),
  is_injection: z.boolean().nullable(),
  category: SentinelCategorySchema.nullable(),
  score: z.number().min(0).max(1).nullable(),
});
export type SentinelSummary = z.infer<typeof SentinelSummarySchema>;

export const VerifierSummarySchema = z.strictObject({
  /** "missing": the Verifier never ran (no model configured); the combiner then says REVIEW. */
  status: z.enum(["ok", "error", "timeout", "invalid", "missing"]),
  output: VerifierOutputSchema.nullable(),
  /** "provider:model-id" that answered, when one did. */
  model: z.string().min(1).max(200).nullable(),
});
export type VerifierSummary = z.infer<typeof VerifierSummarySchema>;

export const VerificationRecordSchema = z
  .strictObject({
    spec: z.literal(VERIFICATION_SPEC),
    purchase_id: idSchema("pur"),
    cart_hash: HashHexSchema,
    c_pre: HashHexSchema,
    sentinel: z.array(SentinelSummarySchema).max(50),
    verifier: VerifierSummarySchema,
    final: VerdictSchema,
    contributions: z.array(StageContributionSchema).min(1).max(200),
    decided_at: IsoTimestampSchema,
  })
  .refine((record) => (record.verifier.status === "ok") === (record.verifier.output !== null), {
    message: "verifier.output is present exactly when verifier.status is ok",
    path: ["verifier", "output"],
  });
export type VerificationRecord = z.infer<typeof VerificationRecordSchema>;

/** H_verifier = sha256(JCS(record)). */
export function verificationRecordHash(record: VerificationRecord): Uint8Array {
  return hashJcs(VerificationRecordSchema.parse(record));
}
