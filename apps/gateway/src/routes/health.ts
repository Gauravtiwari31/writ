// GET /healthz: Render's HTTP health check (render.yaml healthCheckPath). Cheap and dependency-free on
// purpose, so a slow PayPal or database never takes the instance out of rotation.
import type { FastifyPluginAsync } from "fastify";

export const HEALTH_PATH = "/healthz";

export const HEALTH_BODY = { ok: true, service: "writ-gateway", env: "sandbox" } as const;

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get(HEALTH_PATH, async (_request, reply) => {
    void reply.header("cache-control", "no-store");
    return HEALTH_BODY;
  });
};
