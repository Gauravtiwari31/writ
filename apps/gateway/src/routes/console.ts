// AG Studio console data (constrained filter DSL, never SQL) and the /api/ai/studio proxy (P0-11).
// Owner: console stream. Paths and auth are frozen in routes/table.ts; bodies are the named
// @writ/core/api schemas. Every route answers 501 not_implemented until the owner fills it in.
import type { FastifyPluginAsync } from "fastify";
import { notImplemented } from "../http/errors";

const OWNER = "console";

export const consoleRoutes: FastifyPluginAsync = async (app) => {
  // session → ConsoleDatasetResponse
  app.get("/api/console/datasets/:name", notImplemented(OWNER, "GET /api/console/datasets/:name"));
  // session → ConsoleQueryResponse
  app.post("/api/console/query", notImplemented(OWNER, "POST /api/console/query"));
  // session → provider response (proxied)
  app.post("/api/ai/studio", notImplemented(OWNER, "POST /api/ai/studio"));
};
