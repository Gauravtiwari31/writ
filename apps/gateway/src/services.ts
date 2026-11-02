// Builds the services container (deps.ts) from the config: database, clock, ids, event bus, unit
// of work, sessions, PayPal clients (one token cache), the AI runtime with the LLM budget hook,
// Channel3, the page reader, judge limits, and the stream-owned services (saga, agent runner, job
// runner) through their frozen factories. Nothing here calls PayPal, a model, Channel3 or a web page.
//
// FROZEN for the parallel build (docs/ARCHITECTURE.md).
import { createPageReader } from "@writ/agents";
import { channel3Search, createAiRuntime } from "@writ/ai";
import { PayPalHttp, PayPalMultipartClient, PayPalTokenProvider, type PayPalLogger } from "@writ/paypal";
import type { FastifyBaseLogger } from "fastify";
import { createSessionManager } from "./auth/session";
import type { GatewayConfig } from "./config";
import type { JobRunner } from "./contracts/index";
import type { AppDb } from "./db/client";
import { newRowId, type RowKind } from "./db/ids";
import type { CoreServices, PayPalClients, ProductSearch, ServiceOverrides, Services } from "./deps";
import { disputeJobs } from "./disputes/index";
import { createEventBus } from "./events/bus";
import { createJobRunner } from "./jobs/index";
import { createRateLimits } from "./judge/index";
import { createAgentRunner } from "./runs/index";
import { createPurchaseSaga, sagaJobs } from "./saga/index";
import { createUnitOfWork } from "./tx/unit-of-work";
import { writJobs } from "./writs/index";

export interface CreateServicesOptions {
  db: AppDb | null;
  log: FastifyBaseLogger;
  overrides?: ServiceOverrides;
}

function buildPayPalClients(config: GatewayConfig, log: FastifyBaseLogger): PayPalClients | null {
  if (config.paypal === null) return null;
  // One exchange log line per PayPal call, with its PayPal-Debug-Id (never headers, bodies or tokens).
  const logger: PayPalLogger = (entry) => log.info({ paypal: entry }, "paypal exchange");
  const tokens = new PayPalTokenProvider({ config: config.paypal, logger });
  return {
    http: new PayPalHttp({ config: config.paypal, tokens, logger }),
    multipart: new PayPalMultipartClient({ config: config.paypal, tokens, logger }),
    clientId: config.paypal.clientId,
    webhookId: config.webhookId,
    buyerEmail: config.buyerEmail,
  };
}

function buildChannel3(config: GatewayConfig): ProductSearch | null {
  const apiKey = config.secrets.channel3ApiKey();
  if (apiKey === null) return null;
  return { search: (request) => channel3Search(apiKey, request) };
}

export function createServices(config: GatewayConfig, options: CreateServicesOptions): Services {
  const overrides = options.overrides ?? {};
  const { db, log } = options;
  const clock = overrides.clock ?? (() => new Date());
  const ids = overrides.ids ?? ((kind: RowKind) => newRowId(kind, () => clock().getTime()));
  const events =
    overrides.events ??
    createEventBus({
      clock,
      onInvalid: (detail) => log.error({ event: detail }, "dropped an SSE event that does not match StreamEventSchema"),
    });
  const jobsRef: { current: JobRunner | null } = { current: null };
  const uow = createUnitOfWork({ db, events, clock, ids, onEnqueued: () => jobsRef.current?.kick() });
  const sessions = createSessionManager({ session: config.session, secret: config.secrets.sessionSecret(), clock });
  const limits = overrides.limits ?? createRateLimits({ config, db, clock, log });
  const ai =
    overrides.ai ??
    createAiRuntime({ env: config.secrets.aiEnv(), now: clock, beforeModelCall: () => limits.tryConsumeLlmCall() });

  const core: CoreServices = {
    config,
    db,
    clock,
    ids,
    log,
    events,
    uow,
    sessions,
    paypal: overrides.paypal !== undefined ? overrides.paypal : buildPayPalClients(config, log),
    ai,
    channel3: overrides.channel3 !== undefined ? overrides.channel3 : buildChannel3(config),
    // The Wallet origin is the only loopback target allowed: it serves the Deals Outlet fixture pages in local runs.
    pages: overrides.pages ?? createPageReader({ allowedOrigins: config.appBaseUrl === null ? [] : [config.appBaseUrl] }),
    limits,
  };
  const saga = overrides.saga ?? createPurchaseSaga(core);
  const runs = overrides.runs ?? createAgentRunner(core);
  const jobs =
    overrides.jobs ??
    createJobRunner({ ...core, registrations: [sagaJobs({ ...core, saga }), disputeJobs({ ...core, saga }), writJobs({ ...core, saga })] });
  jobsRef.current = jobs;
  return { ...core, saga, runs, jobs };
}
