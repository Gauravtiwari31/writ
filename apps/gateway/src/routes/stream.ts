// GET /v1/stream: tenant-scoped SSE fed from committed events (use http/sse.ts openSse + services.events).
// Owner: api stream. Paths and auth are frozen in routes/table.ts; bodies are the named
// @writ/core/api schemas. Every route answers 501 not_implemented until the owner fills it in.
import type { FastifyPluginAsync } from "fastify";
import { notImplemented } from "../http/errors";

const OWNER = "api";

export const streamRoutes: FastifyPluginAsync = async (app) => {
  // session → text/event-stream of StreamMessage
  app.get("/v1/stream", notImplemented(OWNER, "GET /v1/stream"));
};
