// The public agent API: writs, search, products, carts, checkout, purchase status (P0-3, P0-4).
// Owner: api stream. Paths and auth are frozen in routes/table.ts; bodies are the named
// @writ/core/api schemas. Every route answers 501 not_implemented until the owner fills it in.
import type { FastifyPluginAsync } from "fastify";
import { notImplemented } from "../http/errors";

const OWNER = "api";

export const agentApiRoutes: FastifyPluginAsync = async (app) => {
  // agent-key → AgentWritListResponse
  app.get("/v1/agent/writs", notImplemented(OWNER, "GET /v1/agent/writs"));
  // agent-key → AgentWritView
  app.get("/v1/agent/writs/:id", notImplemented(OWNER, "GET /v1/agent/writs/:id"));
  // agent-key → AgentSearchResponse
  app.post("/v1/agent/search", notImplemented(OWNER, "POST /v1/agent/search"));
  // agent-key → AgentProductResponse
  app.get("/v1/agent/products/:ref", notImplemented(OWNER, "GET /v1/agent/products/:ref"));
  // agent-key → ProposeCartResponse
  app.post("/v1/agent/carts", notImplemented(OWNER, "POST /v1/agent/carts"));
  // agent-key → CheckoutResponse (403 when BLOCKED)
  app.post("/v1/agent/checkout", notImplemented(OWNER, "POST /v1/agent/checkout"));
  // agent-key → AgentPurchaseView
  app.get("/v1/agent/purchases/:id", notImplemented(OWNER, "GET /v1/agent/purchases/:id"));
};
