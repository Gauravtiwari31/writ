// Writ lifecycle: compile, create, sign, revoke, list/get, kill switch (P0-1).
// Owner: api stream. Paths and auth are frozen in routes/table.ts; bodies are the named
// @writ/core/api schemas. Every route answers 501 not_implemented until the owner fills it in.
import type { FastifyPluginAsync } from "fastify";
import { notImplemented } from "../http/errors";

const OWNER = "api";

export const writRoutes: FastifyPluginAsync = async (app) => {
  // session → CompileResponse (503 ai_unavailable)
  app.post("/v1/writs/compile", notImplemented(OWNER, "POST /v1/writs/compile"));
  // session → CreateWritResponse
  app.post("/v1/writs", notImplemented(OWNER, "POST /v1/writs"));
  // session → ListWritsResponse
  app.get("/v1/writs", notImplemented(OWNER, "GET /v1/writs"));
  // session → WritView
  app.get("/v1/writs/:id", notImplemented(OWNER, "GET /v1/writs/:id"));
  // session → WritView
  app.post("/v1/writs/:id/sign", notImplemented(OWNER, "POST /v1/writs/:id/sign"));
  // session → WritView
  app.post("/v1/writs/:id/revoke", notImplemented(OWNER, "POST /v1/writs/:id/revoke"));
  // session → KillSwitchResponse
  app.post("/v1/kill-switch", notImplemented(OWNER, "POST /v1/kill-switch"));
};
