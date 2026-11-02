// GET /v1/meta: what this gateway can do right now (MetaResponse in @writ/core/api), so the Wallet
// degrades visibly (manual Writ editor without a compiler model, "PayPal not configured", ...).
// Public and cheap: no secrets, no database query.
import type { MetaResponse } from "@writ/core/api";
import type { FastifyPluginAsync } from "fastify";
import { databaseKind } from "../db/client";

export const META_PATH = "/v1/meta";

export const metaRoutes: FastifyPluginAsync = async (app) => {
  app.get(META_PATH, async (_request, reply) => {
    const { config, db, paypal, ai, channel3 } = app.services;
    void reply.header("cache-control", "no-store");
    const body: MetaResponse = {
      service: "writ-gateway",
      env: "sandbox",
      app_env: config.appEnv,
      judge_mode: config.judge.enabled,
      database: db === null ? "none" : databaseKind(db),
      paypal: { configured: paypal !== null, webhook_configured: paypal !== null && paypal.webhookId !== null },
      ai: {
        compiler: ai.compiler !== null,
        sentinel: ai.status.sentinel === "configured",
        verifier: ai.verifier !== null,
        reader: ai.reader !== null,
        analyst: ai.analyst !== null,
        agent: ai.agentModels !== null,
      },
      channel3: channel3 !== null,
      webauthn: config.webauthn === null ? null : { rp_id: config.webauthn.rpId, rp_name: config.webauthn.rpName, origin: config.webauthn.origin },
    };
    return body;
  });
};
