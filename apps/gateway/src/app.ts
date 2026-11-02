// Fastify factory. Everything the server needs comes in through config and deps, so tests drive the
// real routes with app.inject() and fakes, and server.ts only adds the database, listen and
// shutdown. Every stream's route plugin is registered here (routes/table.ts lists the contract);
// a stream fills in its own plugin file and never edits this one.
//
// FROZEN for the parallel build (docs/ARCHITECTURE.md).
import fastifyCookie from "@fastify/cookie";
import fastifyRateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyPluginAsync, type FastifyServerOptions } from "fastify";
import { installAuthHooks } from "./auth/guards";
import type { GatewayConfig } from "./config";
import type { AppDb } from "./db/client";
import type { ServiceOverrides } from "./deps";
import { installErrorHandling } from "./http/errors";
import { lazySchemaController } from "./http/fastify";
import { agentApiRoutes } from "./routes/agent-api";
import { agentRoutes } from "./routes/agents";
import { approvalRoutes } from "./routes/approvals";
import { authRoutes } from "./routes/auth";
import { consoleRoutes } from "./routes/console";
import { demoRoutes } from "./routes/demo";
import { disputeRoutes } from "./routes/disputes";
import { evidenceRoutes } from "./routes/evidence";
import { healthRoutes } from "./routes/health";
import { metaRoutes } from "./routes/meta";
import { paypalRoutes } from "./routes/paypal";
import { purchaseRoutes } from "./routes/purchases";
import { runRoutes } from "./routes/runs";
import { streamRoutes } from "./routes/stream";
import { InMemoryWebhookDedupe, paypalWebhookVerifier, webhookRoutes, type WebhookDedupe, type WebhookVerifier } from "./routes/webhooks";
import { writRoutes } from "./routes/writs";
import { createServices } from "./services";
import { passkeySpikePlugin } from "./spikes/passkey";
import { durableWebhookDedupe } from "./webhooks/index";

export interface GatewayDeps {
  /** undefined: PayPal postback verifier built from config; null: none (deliveries get 503). */
  readonly verifyWebhook?: WebhookVerifier | null;
  readonly webhookDedupe?: WebhookDedupe;
  /** Fastify logger option; default is JSON logs at config.logLevel. Tests pass false. */
  readonly logger?: FastifyServerOptions["logger"];
  /** The migrated database (server.ts opens it). Omitted: DB-backed routes answer 503 database_unavailable. */
  readonly db?: AppDb | null;
  /** Test and eval seams (fake saga, AI mock models, PayPal on a fetch fake inside evals/ and unit tests only). */
  readonly services?: ServiceOverrides;
}

/** Stream route plugins, in route-table order. */
const STREAM_ROUTES: readonly FastifyPluginAsync[] = [
  authRoutes,
  writRoutes,
  agentRoutes,
  agentApiRoutes,
  purchaseRoutes,
  streamRoutes,
  approvalRoutes,
  paypalRoutes,
  runRoutes,
  evidenceRoutes,
  disputeRoutes,
  consoleRoutes,
  demoRoutes,
];

export async function buildApp(config: GatewayConfig, deps: GatewayDeps = {}): Promise<FastifyInstance> {
  // Bodies are parsed with Zod (http/errors.ts parseWith), so Fastify's JSON-schema compilers load
  // only if a route ever declares a JSON schema (http/fastify.ts: ~190 ms off every cold start).
  const app = Fastify({ logger: deps.logger ?? { level: config.logLevel }, schemaController: lazySchemaController() });
  const services = createServices(config, { db: deps.db ?? null, log: app.log, overrides: deps.services ?? {} });
  app.decorate("services", services);

  installErrorHandling(app);
  await app.register(fastifyCookie);
  // Opt-in per route (config.rateLimit): judge-mode and capability-link endpoints use it.
  await app.register(fastifyRateLimit, { global: false });
  installAuthHooks(app, { sessions: services.sessions, appOrigin: config.appBaseUrl });

  let verifier: WebhookVerifier | null;
  if (deps.verifyWebhook !== undefined) {
    verifier = deps.verifyWebhook;
  } else if (services.paypal !== null && services.paypal.webhookId !== null) {
    verifier = paypalWebhookVerifier(services.paypal.http, services.paypal.webhookId);
  } else {
    verifier = null;
    app.log.warn("PayPal webhook verification is not configured (PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID); deliveries will get 503");
  }

  await app.register(healthRoutes);
  await app.register(metaRoutes);
  await app.register(webhookRoutes, {
    verifier,
    dedupe: deps.webhookDedupe ?? (deps.db ? durableWebhookDedupe(services) : new InMemoryWebhookDedupe()),
    exposeRecent: config.enableSpikes,
  });
  for (const plugin of STREAM_ROUTES) await app.register(plugin);

  if (config.enableSpikes) {
    await app.register(passkeySpikePlugin, { env: config.passkeyEnv });
    app.log.warn("ENABLE_SPIKES=true: Day-1 spike routes are mounted (/spikes/passkey, /spikes/webhooks/recent)");
  }
  if (config.session.ephemeral) {
    app.log.warn("SESSION_SECRET is not set: using an EPHEMERAL random session key (development only); sessions end when the process restarts");
  }
  if (config.webauthn === null) {
    app.log.warn({ problem: config.webauthnProblem }, "passkey verification is not configured; passkey routes answer 503 webauthn_unconfigured");
  }
  if (services.paypal === null) app.log.warn("PayPal is not configured: checkouts that pass policy fail at AUTHORIZE with paypal_unconfigured");
  for (const [role, status] of Object.entries(services.ai.status)) {
    if (status === "invalid") app.log.warn({ role }, `MODEL_${role.toUpperCase()} is set but invalid (bad spec or missing provider key); the role is unavailable`);
  }
  return app;
}
