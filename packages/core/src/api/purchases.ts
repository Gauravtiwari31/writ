// Purchases, decisions, attacks and ledger rows as the Wallet and console read them (owner: api
// stream; routes in apps/gateway/src/routes/purchases.ts). Also the payloads of several SSE events.
import { z } from "zod";
import { CartSchema, CartSourceSchema } from "../cart";
import { HashHexSchema } from "../hash";
import { idSchema } from "../ids";
import { CurrencySchema, MinorAmountSchema } from "../money";
import { DecisionRecordStageSchema, PurchaseStateReasonSchema, PurchaseStateSchema } from "../purchase";
import { SentinelCategorySchema, SentinelSpanSchema, VerdictSchema } from "../verdicts";
import { localIdSchema, TimestampSchema } from "./common";

export const PayPalIdsViewSchema = z.strictObject({
  order_id: z.string().nullable(),
  authorization_id: z.string().nullable(),
  capture_id: z.string().nullable(),
  refund_id: z.string().nullable(),
});

export const PurchaseViewSchema = z.strictObject({
  purchase_id: idSchema("pur"),
  writ_id: idSchema("wr"),
  cart_id: idSchema("crt"),
  agent_id: idSchema("agt"),
  state: PurchaseStateSchema,
  state_reason: PurchaseStateReasonSchema.nullable(),
  amount_minor: MinorAmountSchema,
  currency: CurrencySchema,
  final_verdict: VerdictSchema.nullable(),
  paypal: PayPalIdsViewSchema,
  /** Seeded console history (plan §11 "synthetic history" badge). */
  synthetic: z.boolean(),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
});
export type PurchaseView = z.infer<typeof PurchaseViewSchema>;

export const DecisionViewSchema = z.strictObject({
  decision_id: localIdSchema("dec"),
  purchase_id: idSchema("pur").nullable(),
  cart_id: idSchema("crt"),
  stage: DecisionRecordStageSchema,
  verdict: VerdictSchema,
  /** Stage-specific typed reasons (PolicyReason[], StageContribution[], ...). */
  reasons: z.array(z.unknown()).max(200),
  model: z.string().max(200).nullable(),
  latency_ms: z.int().min(0).nullable(),
  tokens: z.int().min(0).nullable(),
  created_at: TimestampSchema,
});
export type DecisionView = z.infer<typeof DecisionViewSchema>;

export const AttackViewSchema = z.strictObject({
  attack_id: localIdSchema("atk"),
  source_url: z.string().max(2048),
  category: SentinelCategorySchema,
  /** Untrusted quotes with offsets: rendered in red, never fed to a privileged prompt. */
  spans: z.array(SentinelSpanSchema).max(50),
  score: z.number().min(0).max(1).nullable(),
  detector: z.enum(["rules", "llm", "both"]).nullable(),
  cart_id: idSchema("crt").nullable(),
  purchase_id: idSchema("pur").nullable(),
  agent_id: idSchema("agt").nullable(),
  synthetic: z.boolean(),
  created_at: TimestampSchema,
});
export type AttackView = z.infer<typeof AttackViewSchema>;

export const LedgerEventViewSchema = z.strictObject({
  seq: z.int().positive(),
  writ_id: idSchema("wr"),
  purchase_id: idSchema("pur").nullable(),
  type: z.string().min(1).max(64),
  payload: z.record(z.string(), z.unknown()),
  ts: TimestampSchema,
  prev_hash: HashHexSchema,
  hash: HashHexSchema,
});
export type LedgerEventView = z.infer<typeof LedgerEventViewSchema>;

// GET /v1/purchases?writ_id=&state=
export const ListPurchasesResponseSchema = z.strictObject({ purchases: z.array(PurchaseViewSchema).max(500) });
export type ListPurchasesResponse = z.infer<typeof ListPurchasesResponseSchema>;

// GET /v1/purchases/:id
export const PurchaseDetailResponseSchema = z.strictObject({
  purchase: PurchaseViewSchema,
  cart: CartSchema,
  sources: z.array(CartSourceSchema).max(50),
  decisions: z.array(DecisionViewSchema).max(200),
  attacks: z.array(AttackViewSchema).max(100),
  approval_id: idSchema("apr").nullable(),
  ledger: z.array(LedgerEventViewSchema).max(1000),
});
export type PurchaseDetailResponse = z.infer<typeof PurchaseDetailResponseSchema>;
