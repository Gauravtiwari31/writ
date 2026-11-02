// Judge mode: per-visitor tenant, status, one-click hero run (P0-13).
// Owner: judge stream. Paths and auth are frozen in routes/table.ts; bodies are the named
// @writ/core/api schemas. Every route answers 501 not_implemented until the owner fills it in.
import type { FastifyPluginAsync } from "fastify";
import { notImplemented } from "../http/errors";

const OWNER = "judge";

export const demoRoutes: FastifyPluginAsync = async (app) => {
  // none → DemoSessionResponse + Set-Cookie
  app.post("/v1/demo/session", notImplemented(OWNER, "POST /v1/demo/session"));
  // none → DemoStatusResponse
  app.get("/v1/demo/status", notImplemented(OWNER, "GET /v1/demo/status"));
  // judge-session → RunView (202; 429 over the hourly limit)
  app.post("/v1/demo/hero-run", notImplemented(OWNER, "POST /v1/demo/hero-run"));
};
