// "@writ/gateway": what other workspace packages (evals, scripts) may import. FROZEN barrel.
export { buildApp, type GatewayDeps } from "./app";
export {
  DEFAULT_APP_BASE_URL,
  DEFAULT_HOST,
  DEFAULT_PGLITE_DIR,
  DEFAULT_PORT,
  FIXTURES_DIR,
  GatewayConfigError,
  loadGatewayConfig,
  parseDatabaseUrl,
  type AppEnv,
  type GatewayConfig,
  type GatewaySecrets,
} from "./config";
export { createServices, type CreateServicesOptions } from "./services";
export { requireDb, type CoreServices, type PayPalClients, type ProductSearch, type ServiceOverrides, type Services } from "./deps";
export * from "./contracts/index";
export { closeDb, createPgDb, createPgliteDb, databaseKind, openDatabase, runMigrations, type AppDb, type DatabaseSpec, type Db } from "./db/client";
export { createEventBus, type EventBus } from "./events/bus";
export { createUnitOfWork, type TxContext, type UnitOfWork } from "./tx/unit-of-work";
export { ledgerEventFromRow, ledgerEventView, loadChain } from "./tx/ledger";
export { mintAgentKey, hashAgentKey, parseBearer, findAgentByKey, type AgentPrincipal } from "./auth/agent-keys";
export { decodeSession, encodeSession, type SessionClaims, type SessionManager } from "./auth/session";
export { ROUTE_TABLE, type RouteSpec } from "./routes/table";
export { HEALTH_BODY, HEALTH_PATH } from "./routes/health";
export { META_PATH } from "./routes/meta";
export {
  InMemoryWebhookDedupe,
  PAYPAL_WEBHOOK_PATH,
  paypalWebhookVerifier,
  WEBHOOK_SPIKE_STATUS_PATH,
  type DeliveryOutcome,
  type WebhookDedupe,
  type WebhookDelivery,
  type WebhookVerifier,
  type WebhookVerifyRequest,
} from "./routes/webhooks";
