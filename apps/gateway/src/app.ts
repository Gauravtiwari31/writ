// Fastify factory. Everything the server needs comes in through config and deps, so tests drive the
// real routes with app.inject() and a fake verifier, and server.ts only adds listen + shutdown.
import { PayPalHttp } from "@writ/paypal";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { GatewayConfig } from "./config";
import { healthRoutes } from "./routes/health";
import { InMemoryWebhookDedupe, paypalWebhookVerifier, webhookRoutes, type WebhookDedupe, type WebhookVerifier } from "./routes/webhooks";
import { passkeySpikePlugin } from "./spikes/passkey";

export interface GatewayDeps {
  /** undefined: PayPal postback verifier built from config; null: none (deliveries get 503). */
  readonly verifyWebhook?: WebhookVerifier | null;
  readonly webhookDedupe?: WebhookDedupe;
  /** Fastify logger option; default is JSON logs at config.logLevel. Tests pass false. */
  readonly logger?: FastifyServerOptions["logger"];
}

export async function buildApp(config: GatewayConfig, deps: GatewayDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? { level: config.logLevel } });

  let verifier: WebhookVerifier | null;
  if (deps.verifyWebhook !== undefined) {
    verifier = deps.verifyWebhook;
  } else if (config.paypal !== null && config.webhookId !== null) {
    // One exchange log line per PayPal call, with its PayPal-Debug-Id (never headers, bodies or tokens).
    const http = new PayPalHttp({ config: config.paypal, logger: (entry) => app.log.info({ paypal: entry }, "paypal exchange") });
    verifier = paypalWebhookVerifier(http, config.webhookId);
  } else {
    verifier = null;
    app.log.warn("PayPal webhook verification is not configured (PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID); deliveries will get 503");
  }

  await app.register(healthRoutes);
  await app.register(webhookRoutes, {
    verifier,
    dedupe: deps.webhookDedupe ?? new InMemoryWebhookDedupe(),
    exposeRecent: config.enableSpikes,
  });

  if (config.enableSpikes) {
    await app.register(passkeySpikePlugin, { env: config.passkeyEnv });
    app.log.warn("ENABLE_SPIKES=true: Day-1 spike routes are mounted (/spikes/passkey, /spikes/webhooks/recent)");
  }
  return app;
}
