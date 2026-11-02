// Connect PayPal once: JS SDK v6 save flow and the redirect fallback (P0-2).
// Owner: web-flows stream. Paths and auth are frozen in routes/table.ts; bodies are the named
// @writ/core/api schemas. Every route answers 501 not_implemented until the owner fills it in.
import type { FastifyPluginAsync } from "fastify";
import { notImplemented } from "../http/errors";

const OWNER = "web-flows";

export const paypalRoutes: FastifyPluginAsync = async (app) => {
  // session → PayPalConfigResponse
  app.get("/v1/paypal/config", notImplemented(OWNER, "GET /v1/paypal/config"));
  // session → VaultStatusView
  app.get("/v1/paypal/vault", notImplemented(OWNER, "GET /v1/paypal/vault"));
  // session → CreateSetupTokenResponse
  app.post("/v1/paypal/vault/setup-token", notImplemented(OWNER, "POST /v1/paypal/vault/setup-token"));
  // session → VaultStatusView
  app.post("/v1/paypal/vault/payment-token", notImplemented(OWNER, "POST /v1/paypal/vault/payment-token"));
  // session → VaultStatusView
  app.post("/v1/paypal/vault/disconnect", notImplemented(OWNER, "POST /v1/paypal/vault/disconnect"));
};
