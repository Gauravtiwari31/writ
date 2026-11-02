// Connect PayPal once (P0-2; owner: web-flows stream; routes in apps/gateway/src/routes/paypal.ts).
// JS SDK v6 save flow: the SDK's createVaultToken callback gets a setup token from the gateway,
// the buyer approves in the PayPal popup, and the gateway turns the approved setup token into a
// Vault payment token stored per user (paypal_vault_tokens). The redirect fallback uses the
// setup token's approve URL. Without PAYPAL_CLIENT_ID the Wallet shows "not configured".
import { z } from "zod";
import { HttpUrlSchema } from "../ids";
import { localIdSchema, TimestampSchema } from "./common";

/** JS SDK v6 core script (plan §7 row 2). v5 is deprecated: never load it. */
export const PAYPAL_SDK_V6_SANDBOX_URL = "https://www.sandbox.paypal.com/web-sdk/v6/core";

// GET /v1/paypal/config (the client id is public by design)
export const PayPalConfigResponseSchema = z.strictObject({
  configured: z.boolean(),
  env: z.literal("sandbox"),
  client_id: z.string().min(1).max(200).nullable(),
  sdk_url: z.literal(PAYPAL_SDK_V6_SANDBOX_URL),
});
export type PayPalConfigResponse = z.infer<typeof PayPalConfigResponseSchema>;

export const VAULT_TOKEN_STATUSES = ["PENDING", "ACTIVE", "REVOKED", "FAILED"] as const;
export const VaultTokenStatusSchema = z.enum(VAULT_TOKEN_STATUSES);
export type VaultTokenStatus = z.infer<typeof VaultTokenStatusSchema>;

// GET /v1/paypal/vault
export const VaultStatusViewSchema = z.strictObject({
  connected: z.boolean(),
  status: z.enum(["NONE", ...VAULT_TOKEN_STATUSES]),
  vault_token_id: localIdSchema("vlt").nullable(),
  /** Masked payer email, e.g. "a***@example.com". */
  payer_hint: z.string().max(120).nullable(),
  /** Judge-mode demo wallet (pre-vaulted sandbox token, labeled). */
  demo: z.boolean(),
  updated_at: TimestampSchema.nullable(),
});
export type VaultStatusView = z.infer<typeof VaultStatusViewSchema>;

// POST /v1/paypal/vault/setup-token
export const CreateSetupTokenRequestSchema = z.strictObject({ flow: z.enum(["sdk", "redirect"]) });
export type CreateSetupTokenRequest = z.infer<typeof CreateSetupTokenRequestSchema>;
export const CreateSetupTokenResponseSchema = z.strictObject({
  setup_token_id: z.string().min(1).max(64),
  /** PayPal-hosted approval page (redirect fallback); null for the SDK flow. */
  approve_url: HttpUrlSchema.nullable(),
});
export type CreateSetupTokenResponse = z.infer<typeof CreateSetupTokenResponseSchema>;

// POST /v1/paypal/vault/payment-token → VaultStatusView
export const CreatePaymentTokenRequestSchema = z.strictObject({ setup_token_id: z.string().min(1).max(64) });
export type CreatePaymentTokenRequest = z.infer<typeof CreatePaymentTokenRequestSchema>;
