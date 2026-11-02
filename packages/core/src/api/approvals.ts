// Human review (P0-6; owner: money stream; routes in apps/gateway/src/routes/approvals.ts).
// The Wallet shows the request full-screen and signs approvalBody(request, decision) with a passkey
// (challenge = base64url(approvalHash(body))). 24 h without a decision → EXPIRED → auto-void.
import { z } from "zod";
import { ApprovalDecisionSchema, ApprovalRequestSchema } from "../approval";
import { idSchema } from "../ids";
import { CurrencySchema, MinorAmountSchema } from "../money";
import { ApprovalStatusSchema } from "../purchase";
import { WritSignatureSchema } from "../signatures/schema";
import { singleLineText } from "../writ";
import { Base64UrlSchema, MinorDigitsSchema, TimestampSchema, WebAuthnRequestOptionsSchema } from "./common";
import { PurchaseViewSchema } from "./purchases";

export const ApprovalViewSchema = z.strictObject({
  approval_id: idSchema("apr"),
  purchase_id: idSchema("pur"),
  writ_id: idSchema("wr"),
  status: ApprovalStatusSchema,
  request: ApprovalRequestSchema,
  decision: ApprovalDecisionSchema.nullable(),
  /** What the human is approving, in plain words (titles are untrusted merchant text: display only). */
  cart_summary: z.strictObject({
    items: z
      .array(z.strictObject({ title: singleLineText(200), qty: z.int().min(1), unit_minor: MinorAmountSchema }))
      .min(1)
      .max(20),
    total_minor: MinorDigitsSchema,
    currency: CurrencySchema,
  }),
  /** Plain-English reasons the purchase needs a human ("$44 is above your $40 approval line"). */
  reasons: z.array(z.string().min(1).max(500)).max(30),
  expires_at: TimestampSchema,
  decided_at: TimestampSchema.nullable(),
  created_at: TimestampSchema,
});
export type ApprovalView = z.infer<typeof ApprovalViewSchema>;

// GET /v1/approvals?status=PENDING
export const ListApprovalsResponseSchema = z.strictObject({ approvals: z.array(ApprovalViewSchema).max(200) });
export type ListApprovalsResponse = z.infer<typeof ListApprovalsResponseSchema>;

// GET /v1/approvals/:id: the request plus one challenge per decision.
export const ApprovalChallengeResponseSchema = z.strictObject({
  approval: ApprovalViewSchema,
  challenges: z.strictObject({ APPROVE: Base64UrlSchema, DECLINE: Base64UrlSchema }),
  /** WebAuthn request options per decision; null when the user has no passkey (device-key path). */
  options: z.strictObject({ APPROVE: WebAuthnRequestOptionsSchema, DECLINE: WebAuthnRequestOptionsSchema }).nullable(),
});
export type ApprovalChallengeResponse = z.infer<typeof ApprovalChallengeResponseSchema>;

// POST /v1/approvals/:id/decide
export const DecideApprovalRequestSchema = z.strictObject({
  decision: ApprovalDecisionSchema,
  signature: WritSignatureSchema,
});
export type DecideApprovalRequest = z.infer<typeof DecideApprovalRequestSchema>;
export const DecideApprovalResponseSchema = z.strictObject({
  approval: ApprovalViewSchema,
  purchase: PurchaseViewSchema,
});
export type DecideApprovalResponse = z.infer<typeof DecideApprovalResponseSchema>;
