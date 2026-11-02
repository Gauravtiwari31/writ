// The public agent API (P0-3/P0-4; owner: api stream; routes in apps/gateway/src/routes/agent-api.ts).
// Auth: `Authorization: Bearer wak_...`. Agents never name a payee, an amount or a raw address:
// carts are built by the gateway from catalog data, and the agent only picks product_refs,
// quantities and an address-book ref (threats T2, T3, T6).
import { z } from "zod";
import { CartSchema, CartSourceSchema, ProductRefSchema } from "../cart";
import { HashHexSchema } from "../hash";
import { idSchema } from "../ids";
import { MinorAmountSchema } from "../money";
import { PolicyReasonSchema } from "../policy/decision";
import { CatalogItemSchema } from "../product";
import { PurchaseStateReasonSchema, PurchaseStateSchema } from "../purchase";
import { CategoryLeafSchema } from "../taxonomy";
import { VerdictSchema } from "../verdicts";
import { StageContributionSchema } from "../verification";
import { WritBodySchema, WritStatusSchema } from "../writ";
import { TimestampSchema } from "./common";
import { BudgetViewSchema } from "./writs";

export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
/** Printable ASCII, 1-255 chars (purchases.idempotency_key CHECK). */
export const IdempotencyKeySchema = z.string().regex(/^[\x21-\x7e]{1,255}$/, "Idempotency-Key: 1-255 printable ASCII chars");

// GET /v1/agent/writs[/:id]
export const AgentWritViewSchema = z.strictObject({
  writ: WritBodySchema,
  status: WritStatusSchema,
  hash: HashHexSchema,
  budget: BudgetViewSchema,
  /** Plain-English constraints, the same lines the user signed. */
  summary: z.array(z.string().min(1).max(300)).max(20),
});
export type AgentWritView = z.infer<typeof AgentWritViewSchema>;
export const AgentWritListResponseSchema = z.strictObject({ writs: z.array(AgentWritViewSchema).max(100) });
export type AgentWritListResponse = z.infer<typeof AgentWritListResponseSchema>;

// POST /v1/agent/search (Channel3 proxy, typed results)
export const AgentSearchRequestSchema = z.strictObject({
  writ_id: idSchema("wr").optional(),
  query: z.string().min(1).max(200),
  max_price_minor: MinorAmountSchema.optional(),
  category: CategoryLeafSchema.optional(),
  limit: z.int().min(1).max(30).optional(),
});
export type AgentSearchRequest = z.infer<typeof AgentSearchRequestSchema>;
export const SEARCH_SOURCES = ["channel3", "fixture", "unavailable"] as const;
export const AgentSearchResponseSchema = z.strictObject({
  /** "unavailable": CHANNEL3_API_KEY is not set and no fixture matched; never fabricated results. */
  source: z.enum(SEARCH_SOURCES),
  results: z.array(CatalogItemSchema).max(30),
  /** Shown to people (e.g. "Channel3 is not configured; showing security test fixture products"). */
  notice: z.string().max(300).nullable(),
});
export type AgentSearchResponse = z.infer<typeof AgentSearchResponseSchema>;

// GET /v1/agent/products/:ref
export const AgentProductResponseSchema = z.strictObject({ product: CatalogItemSchema });

// POST /v1/agent/carts → policy preview (deterministic stages only; nothing is reserved)
export const ProposeCartRequestSchema = z.strictObject({
  writ_id: idSchema("wr"),
  items: z
    .array(z.strictObject({ product_ref: ProductRefSchema, qty: z.int().min(1).max(99) }))
    .min(1)
    .max(20),
  ship_to_ref: idSchema("adr"),
  /** Tainted inputs that shaped this cart (pages read, search results); the Sentinel scans exactly these. */
  sources: z.array(CartSourceSchema).max(50),
});
export type ProposeCartRequest = z.infer<typeof ProposeCartRequestSchema>;

export const PolicyPreviewViewSchema = z.strictObject({
  verdict: VerdictSchema,
  /** Typed reasons the agent can re-plan from (BLOCK: every failed check; REVIEW: the threshold). */
  reasons: z.array(PolicyReasonSchema),
  contributions: z.array(StageContributionSchema),
  pending_stages: z.array(z.enum(["sentinel", "verifier"])),
});
export type PolicyPreviewView = z.infer<typeof PolicyPreviewViewSchema>;

export const ProposeCartResponseSchema = z.strictObject({
  cart_id: idSchema("crt"),
  cart: CartSchema,
  preview: PolicyPreviewViewSchema,
});
export type ProposeCartResponse = z.infer<typeof ProposeCartResponseSchema>;

// POST /v1/agent/checkout (header Idempotency-Key required) and GET /v1/agent/purchases/:id
export const CheckoutRequestSchema = z.strictObject({ cart_id: idSchema("crt") });
export type CheckoutRequest = z.infer<typeof CheckoutRequestSchema>;

export const CheckoutReasonSchema = z.strictObject({
  stage: z.string().min(1).max(32),
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(1000),
});

export const AgentPurchaseViewSchema = z.strictObject({
  purchase_id: idSchema("pur"),
  status: PurchaseStateSchema,
  state_reason: PurchaseStateReasonSchema.nullable(),
  /** The combined verdict once known; BLOCK from policy is final. */
  verdict: VerdictSchema.nullable(),
  reasons: z.array(CheckoutReasonSchema).max(100),
  /** Policy reasons in full when the policy blocked (403), so the agent can re-plan. */
  policy_reasons: z.array(PolicyReasonSchema),
  amount_minor: MinorAmountSchema,
  paypal: z.strictObject({
    order_id: z.string().nullable(),
    authorization_id: z.string().nullable(),
    capture_id: z.string().nullable(),
  }),
  approval: z.strictObject({ approval_id: idSchema("apr"), expires_at: TimestampSchema }).nullable(),
  /** True once PayPal captured funds. A BLOCKED purchase never even created an authorization ("$0 moved"). */
  money_moved: z.boolean(),
  /** Wallet path of the receipt, e.g. /receipts/pur_... */
  receipt_path: z.string().startsWith("/"),
});
export type AgentPurchaseView = z.infer<typeof AgentPurchaseViewSchema>;

/** 200/202 for every outcome except a policy or budget BLOCK, which is 403 with the same body. */
export const CheckoutResponseSchema = AgentPurchaseViewSchema.extend({
  /** True when this Idempotency-Key was seen before and the stored purchase is returned (T7). */
  replayed: z.boolean(),
});
export type CheckoutResponse = z.infer<typeof CheckoutResponseSchema>;
