// The typed services container every route plugin and stream module receives (app.services).
// Types only plus requireDb, so stream modules can import it without import cycles; the wiring is
// in services.ts.
//
// FROZEN for the parallel build (docs/ARCHITECTURE.md §3): a stream that needs a new shared
// service asks the architect.
import type { PageReader } from "@writ/agents";
import type { AiRuntime, Channel3SearchOutcome, Channel3SearchRequest } from "@writ/ai";
import type { PayPalHttp, PayPalMultipartClient } from "@writ/paypal";
import type { FastifyBaseLogger } from "fastify";
import type { SessionManager } from "./auth/session";
import type { GatewayConfig } from "./config";
import type { AgentRunner, JobRunner, PurchaseSaga, RateLimits } from "./contracts/index";
import type { AppDb } from "./db/client";
import type { RowKind } from "./db/ids";
import type { EventBus } from "./events/bus";
import { httpError } from "./http/errors";
import type { UnitOfWork } from "./tx/unit-of-work";

/** Sandbox PayPal clients sharing one OAuth token cache. Only the saga (money) and the dispute engine (evidence) call money endpoints. */
export interface PayPalClients {
  readonly http: PayPalHttp;
  readonly multipart: PayPalMultipartClient;
  /** Public by design (JS SDK v6 createInstance). */
  readonly clientId: string;
  readonly webhookId: string | null;
  /** PAYPAL_SANDBOX_BUYER_EMAIL, for sandbox dispute simulation only. */
  readonly buyerEmail: string | null;
}

/** Channel3 product search bound to CHANNEL3_API_KEY (the key never leaves this object). */
export interface ProductSearch {
  search(request: Channel3SearchRequest): Promise<Channel3SearchOutcome>;
}

export interface CoreServices {
  readonly config: GatewayConfig;
  /** null only when the app is built without a database (some unit tests); DB routes then answer 503. */
  readonly db: AppDb | null;
  readonly clock: () => Date;
  /** newRowId with the injected clock. */
  readonly ids: (kind: RowKind) => string;
  readonly log: FastifyBaseLogger;
  readonly events: EventBus;
  /** The only way to write state + ledger + outbox (§22 rule 14). */
  readonly uow: UnitOfWork;
  readonly sessions: SessionManager;
  /** null without PAYPAL_CLIENT_ID/SECRET (plan decision 8: checkouts then fail at AUTHORIZE, typed). */
  readonly paypal: PayPalClients | null;
  /** Roles are null when their MODEL_* is unset (plan decision 7); calls consult limits.tryConsumeLlmCall. */
  readonly ai: AiRuntime;
  /** null without CHANNEL3_API_KEY. */
  readonly channel3: ProductSearch | null;
  /**
   * The ONE way gateway code fetches an untrusted web page (SSRF rules in @writ/agents PageReader):
   * the built-in agents' read_page tool (agents) and the Sentinel's tainted page sources (api).
   */
  readonly pages: PageReader;
  readonly limits: RateLimits;
}

export interface Services extends CoreServices {
  readonly saga: PurchaseSaga;
  readonly runs: AgentRunner;
  readonly jobs: JobRunner;
}

/** Test and eval seams: replace any service (e.g. a PayPalHttp on a fetch fake inside evals/ and unit tests only). */
export type ServiceOverrides = Partial<
  Pick<Services, "clock" | "ids" | "events" | "paypal" | "ai" | "channel3" | "pages" | "limits" | "saga" | "runs" | "jobs">
>;

export function requireDb(services: Pick<CoreServices, "db">): AppDb {
  if (services.db === null) throw httpError.unavailable("database_unavailable", "The gateway has no database configured.");
  return services.db;
}

declare module "fastify" {
  interface FastifyInstance {
    services: Services;
  }
}
