// Disputes and the sandbox-only simulate steps (P0-9).
// Owner: evidence stream. Paths and auth are frozen in routes/table.ts; bodies are the named
// @writ/core/api schemas. Every route answers 501 not_implemented until the owner fills it in.
import type { FastifyPluginAsync } from "fastify";
import { notImplemented } from "../http/errors";

const OWNER = "evidence";

export const disputeRoutes: FastifyPluginAsync = async (app) => {
  // session → ListDisputesResponse
  app.get("/v1/disputes", notImplemented(OWNER, "GET /v1/disputes"));
  // session → DisputeDetailResponse
  app.get("/v1/disputes/:id", notImplemented(OWNER, "GET /v1/disputes/:id"));
  // session → DisputeView
  app.post("/v1/disputes/:id/actions", notImplemented(OWNER, "POST /v1/disputes/:id/actions"));
  // session → DisputeView
  app.post("/v1/demo/disputes/:purchaseId/simulate", notImplemented(OWNER, "POST /v1/demo/disputes/:purchaseId/simulate"));
};
