// GET /v1/stream: tenant-scoped SSE fed only from committed events.
import type { FastifyPluginAsync } from "fastify";
import { sessionOf } from "../auth/guards";
import { openSse } from "../http/sse";

export const streamRoutes: FastifyPluginAsync = async (app) => {
  app.get("/v1/stream", async (request, reply) => {
    const session = sessionOf(request);
    const channel = openSse(request, reply);
    const lastEventId = request.headers["last-event-id"];
    if (typeof lastEventId === "string") {
      for (const message of app.services.events.since(session.tenantId, lastEventId) ?? []) channel.send(message);
    }
    const unsubscribe = app.services.events.subscribe(session.tenantId, (message) => channel.send(message));
    channel.onClose(unsubscribe);
    return reply;
  });
};
