// Wallet-side agent management: create (key shown once), list, revoke, rotate (P0-3).
// Owner: api stream. Paths and auth are frozen in routes/table.ts; bodies are the named
// @writ/core/api schemas. Every route answers 501 not_implemented until the owner fills it in.
import type { FastifyPluginAsync } from "fastify";
import { notImplemented } from "../http/errors";

const OWNER = "api";

export const agentRoutes: FastifyPluginAsync = async (app) => {
  // session → CreateAgentResponse
  app.post("/v1/agents", notImplemented(OWNER, "POST /v1/agents"));
  // session → ListAgentsResponse
  app.get("/v1/agents", notImplemented(OWNER, "GET /v1/agents"));
  // session → AgentView
  app.post("/v1/agents/:id/revoke", notImplemented(OWNER, "POST /v1/agents/:id/revoke"));
  // session → CreateAgentResponse
  app.post("/v1/agents/:id/rotate-key", notImplemented(OWNER, "POST /v1/agents/:id/rotate-key"));
};
