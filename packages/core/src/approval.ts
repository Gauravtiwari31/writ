// Human approval (plan P0-6). When the combiner says REVIEW, the gateway stores an ApprovalRequest;
// the human signs ApprovalBody = request + decision with a passkey (challenge = sha256(JCS(body))),
// so the signature binds both the exact purchase commitment (c_pre) and the choice. The decided
// ApprovalRecord is hashed into C_post as H_approval (plan §6.7).
import { z } from "zod";
import { hashJcs, HashHexSchema } from "./hash";
import { idSchema } from "./ids";
import { CurrencySchema, MinorAmountSchema } from "./money";
import { COMBINER_REASON_CODES } from "./policy/combiner";
import { WritSignatureSchema } from "./signatures/schema";
import { IsoTimestampSchema } from "./writ";

export const APPROVAL_SPEC = "writ-approval/0.1";

export const APPROVAL_DECISIONS = ["APPROVE", "DECLINE"] as const;
export const ApprovalDecisionSchema = z.enum(APPROVAL_DECISIONS);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

const approvalRequestShape = {
  spec: z.literal(APPROVAL_SPEC),
  approval_id: idSchema("apr"),
  purchase_id: idSchema("pur"),
  writ_id: idSchema("wr"),
  /** H_w of the signed Writ the purchase spends under. */
  writ_hash: HashHexSchema,
  /** H_c of the cart being approved. */
  cart_hash: HashHexSchema,
  /** The pre-commitment already anchored in the PayPal order's custom_id. */
  c_pre: HashHexSchema,
  amount_minor: MinorAmountSchema,
  currency: CurrencySchema,
  /** Combiner reason codes that sent the purchase to a human (e.g. REVIEW_THRESHOLD, VERIFIER_ITEM_UNCLEAR). */
  review_codes: z
    .array(z.enum(COMBINER_REASON_CODES))
    .min(1)
    .max(30)
    .refine((codes) => new Set(codes).size === codes.length, "codes must be unique"),
  requested_at: IsoTimestampSchema,
  expires_at: IsoTimestampSchema,
};

function expiresAfterRequest(value: { requested_at: string; expires_at: string }): boolean {
  return Date.parse(value.expires_at) > Date.parse(value.requested_at);
}

/** Stored on approvals.request when the purchase enters AWAITING_HUMAN; immutable afterwards. */
export const ApprovalRequestSchema = z
  .strictObject(approvalRequestShape)
  .refine(expiresAfterRequest, { message: "expires_at must be after requested_at", path: ["expires_at"] });
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

/** The signed document. */
export const ApprovalBodySchema = z
  .strictObject({ ...approvalRequestShape, decision: ApprovalDecisionSchema })
  .refine(expiresAfterRequest, { message: "expires_at must be after requested_at", path: ["expires_at"] });
export type ApprovalBody = z.infer<typeof ApprovalBodySchema>;

/** The body for one decision; validated, so a malformed request can never be signed. */
export function approvalBody(request: ApprovalRequest, decision: ApprovalDecision): ApprovalBody {
  return ApprovalBodySchema.parse({ ...request, decision });
}

/** sha256(JCS(body)): the WebAuthn challenge (32 raw bytes) for this decision. */
export function approvalHash(body: ApprovalBody): Uint8Array {
  return hashJcs(ApprovalBodySchema.parse(body));
}

/** What the evidence pack carries as `approval`; H_approval = sha256(JCS(record)). */
export const ApprovalRecordSchema = z.strictObject({
  body: ApprovalBodySchema,
  signature: WritSignatureSchema,
  decided_at: IsoTimestampSchema,
});
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

export function approvalRecordHash(record: ApprovalRecord): Uint8Array {
  return hashJcs(ApprovalRecordSchema.parse(record));
}
