// Disputes (P0-9; owner: evidence stream; routes in apps/gateway/src/routes/disputes.ts).
// CUSTOMER.DISPUTE.* webhooks → outbox → dispute engine (GET dispute → evidence → analyst →
// provide-evidence or accept-claim). Sandbox-only simulate steps are labeled "sandbox adjudication".
import { z } from "zod";
import { DisputeActionSchema, DisputeAnalysisSchema, DisputeLiabilitySchema } from "../dispute";
import { idSchema } from "../ids";
import { CurrencySchema, MinorAmountSchema } from "../money";
import { localIdSchema, TimestampSchema } from "./common";
import { LedgerEventViewSchema } from "./purchases";

export const DisputeViewSchema = z.strictObject({
  dispute_id: localIdSchema("dsp"),
  paypal_dispute_id: z.string().min(1).max(64),
  purchase_id: idSchema("pur").nullable(),
  reason: z.string().max(64).nullable(),
  /** PayPal's dispute status (e.g. OPEN, WAITING_FOR_SELLER_RESPONSE, UNDER_REVIEW, RESOLVED). */
  status: z.string().min(1).max(64),
  stage: z.string().max(64).nullable(),
  liability: DisputeLiabilitySchema.nullable(),
  action: DisputeActionSchema.nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  outcome: z.string().max(64).nullable(),
  /** The analyst's recommendation waits for a human click (anything but a confident PROVIDE_EVIDENCE). */
  needs_human: z.boolean(),
  amount_minor: MinorAmountSchema.nullable(),
  currency: CurrencySchema.nullable(),
  synthetic: z.boolean(),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
});
export type DisputeView = z.infer<typeof DisputeViewSchema>;

// GET /v1/disputes, GET /v1/disputes/:id
export const ListDisputesResponseSchema = z.strictObject({ disputes: z.array(DisputeViewSchema).max(500) });
export type ListDisputesResponse = z.infer<typeof ListDisputesResponseSchema>;
export const DisputeDetailResponseSchema = z.strictObject({
  dispute: DisputeViewSchema,
  analysis: DisputeAnalysisSchema.nullable(),
  events: z.array(LedgerEventViewSchema).max(1000),
});
export type DisputeDetailResponse = z.infer<typeof DisputeDetailResponseSchema>;

// POST /v1/disputes/:id/actions (the human click for anything not auto-executed)
export const DisputeActionRequestSchema = z.strictObject({ action: DisputeActionSchema });
export type DisputeActionRequest = z.infer<typeof DisputeActionRequestSchema>;

// POST /v1/demo/disputes/:purchaseId/simulate (sandbox-only endpoints, plan §7 row 8)
export const DISPUTE_SIMULATE_STEPS = ["escalate", "require-evidence", "adjudicate"] as const;
export const SimulateDisputeRequestSchema = z.strictObject({
  step: z.enum(DISPUTE_SIMULATE_STEPS),
  /** adjudicate only. */
  outcome: z.enum(["SELLER_FAVOR", "BUYER_FAVOR"]).optional(),
});
export type SimulateDisputeRequest = z.infer<typeof SimulateDisputeRequestSchema>;
