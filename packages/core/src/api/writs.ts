// Writ lifecycle (P0-1; owner: api stream; routes in apps/gateway/src/routes/writs.ts).
// compile → create (server-generated id; body + hash = single-use WebAuthn challenge) → sign →
// ACTIVE; revoke; kill switch (revokes every Writ and voids in-flight authorizations).
import { z } from "zod";
import { HashHexSchema } from "../hash";
import { idSchema } from "../ids";
import { MinorAmountSchema } from "../money";
import { WritSignatureSchema } from "../signatures/schema";
import { singleLineText, WritBodySchema, WritDraftSchema, WritStatusSchema } from "../writ";
import { Base64UrlSchema, MinorDigitsSchema, TimestampSchema, WebAuthnRequestOptionsSchema } from "./common";

export const BudgetViewSchema = z.strictObject({
  writ_id: idSchema("wr"),
  limit_minor: MinorAmountSchema,
  max_per_order_minor: MinorAmountSchema,
  reserved_minor: MinorDigitsSchema,
  spent_minor: MinorDigitsSchema,
  /** limit - spent - reserved. */
  remaining_minor: MinorDigitsSchema,
  /** Captured orders. */
  orders_count: z.int().min(0),
  /** Orders holding a reservation (in flight). orders_count + held_orders <= max_orders. */
  held_orders: z.int().min(0),
  max_orders: z.int().min(1),
});
export type BudgetView = z.infer<typeof BudgetViewSchema>;

export const WritViewSchema = z.strictObject({
  writ_id: idSchema("wr"),
  status: WritStatusSchema,
  agent_id: idSchema("agt"),
  /** The canonical signed (or, for DRAFT, to-be-signed) body. */
  body: WritBodySchema,
  /** H_w = sha256(JCS(body)); shown as the Writ's serial number. */
  hash: HashHexSchema,
  /** Plain-English permission-card lines ("Can spend up to $60", "Never: gift cards, ..."). */
  summary: z.array(z.string().min(1).max(300)).max(20),
  /** "webauthn" | "device-ed25519" once signed. */
  signature_kind: z.enum(["webauthn", "device-ed25519"]).nullable(),
  created_at: TimestampSchema,
  signed_at: TimestampSchema.nullable(),
  revoked_at: TimestampSchema.nullable(),
  expires_at: TimestampSchema,
  /** null while DRAFT (the budget row is created at signing). */
  budget: BudgetViewSchema.nullable(),
});
export type WritView = z.infer<typeof WritViewSchema>;

// POST /v1/writs/compile (503 ai_unavailable without a compiler model: the Wallet falls back to the manual editor)
export const CompileRequestSchema = z.strictObject({
  text: z.string().min(1).max(2000),
  agent_id: idSchema("agt").optional(),
});
export type CompileRequest = z.infer<typeof CompileRequestSchema>;
export const CompileResponseSchema = z.strictObject({
  draft: WritDraftSchema,
  /** "provider:model-id" that answered. */
  model: z.string().min(1).max(200),
});
export type CompileResponse = z.infer<typeof CompileResponseSchema>;

// POST /v1/writs
export const CreateWritRequestSchema = z.strictObject({
  draft: WritDraftSchema,
  agent_id: idSchema("agt"),
  ship_to_ref: idSchema("adr"),
});
export type CreateWritRequest = z.infer<typeof CreateWritRequestSchema>;
export const CreateWritResponseSchema = z.strictObject({
  writ: WritViewSchema,
  /** base64url of the 32-byte H_w: the WebAuthn challenge (single use: /sign consumes it). */
  challenge: Base64UrlSchema,
  /** null when the user has no passkey (device-key path). */
  sign_options: WebAuthnRequestOptionsSchema.nullable(),
});
export type CreateWritResponse = z.infer<typeof CreateWritResponseSchema>;

// POST /v1/writs/:id/sign → WritView (ACTIVE)
export const SignWritRequestSchema = z.strictObject({ signature: WritSignatureSchema });
export type SignWritRequest = z.infer<typeof SignWritRequestSchema>;

// POST /v1/writs/:id/revoke → WritView (REVOKED)
export const RevokeWritRequestSchema = z.strictObject({ reason: singleLineText(200).optional() });
export type RevokeWritRequest = z.infer<typeof RevokeWritRequestSchema>;

// GET /v1/writs
export const ListWritsResponseSchema = z.strictObject({ writs: z.array(WritViewSchema).max(500) });
export type ListWritsResponse = z.infer<typeof ListWritsResponseSchema>;

// POST /v1/kill-switch
export const KillSwitchRequestSchema = z.strictObject({ reason: singleLineText(200).optional() });
export type KillSwitchRequest = z.infer<typeof KillSwitchRequestSchema>;
export const KillSwitchResponseSchema = z.strictObject({
  revoked_writ_ids: z.array(idSchema("wr")).max(1000),
  /** Purchases moved to VOIDING; their PayPal voids run after commit. */
  void_requested_purchase_ids: z.array(idSchema("pur")).max(1000),
});
export type KillSwitchResponse = z.infer<typeof KillSwitchResponseSchema>;
