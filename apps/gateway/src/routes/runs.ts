// Built-in agent runs started from the Wallet (P0-3): delegate to services.runs.
// Owner: agents stream. Paths and auth are frozen in routes/table.ts; bodies are the named
// @writ/core/api schemas. Every route answers 501 not_implemented until the owner fills it in.
import type { FastifyPluginAsync } from "fastify";
import { notImplemented } from "../http/errors";

const OWNER = "agents";

export const runRoutes: FastifyPluginAsync = async (app) => {
  // session → RunView (202)
  app.post("/v1/runs", notImplemented(OWNER, "POST /v1/runs"));
  // session → ListRunsResponse
  app.get("/v1/runs", notImplemented(OWNER, "GET /v1/runs"));
  // session → RunDetailResponse
  app.get("/v1/runs/:id", notImplemented(OWNER, "GET /v1/runs/:id"));
  // session → RunView
  app.post("/v1/runs/:id/stop", notImplemented(OWNER, "POST /v1/runs/:id/stop"));
};
