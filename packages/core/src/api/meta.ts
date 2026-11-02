// GET /v1/meta (public, no auth): what this gateway can do right now, so the Wallet can degrade
// visibly instead of failing (no AI keys → manual Writ editor; no PayPal → "not configured").
import { z } from "zod";

export const MetaResponseSchema = z.strictObject({
  service: z.literal("writ-gateway"),
  env: z.literal("sandbox"),
  app_env: z.enum(["production", "development", "test"]),
  judge_mode: z.boolean(),
  database: z.enum(["postgres", "pglite", "none"]),
  paypal: z.strictObject({ configured: z.boolean(), webhook_configured: z.boolean() }),
  /** Which AI roles have a model list (MODEL_<ROLE>) and a provider key. */
  ai: z.strictObject({
    compiler: z.boolean(),
    sentinel: z.boolean(),
    verifier: z.boolean(),
    reader: z.boolean(),
    analyst: z.boolean(),
    agent: z.boolean(),
  }),
  channel3: z.boolean(),
  /** null when APP_BASE_URL is unknown in production: passkey routes then answer 503 webauthn_unconfigured. */
  webauthn: z.strictObject({ rp_id: z.string(), rp_name: z.string(), origin: z.string() }).nullable(),
});
export type MetaResponse = z.infer<typeof MetaResponseSchema>;
