// Shared test helpers for every stream's gateway tests (FROZEN; add your own helpers under
// test/<stream>/). PGlite in memory with migrations applied: no external services, no PayPal, no
// model provider. PayPal fakes stay in unit tests and evals only (§22 rule 41).
import type { FastifyInstance } from "fastify";
import { buildApp, type GatewayDeps } from "../../src/app";
import { loadGatewayConfig, type GatewayConfig } from "../../src/config";
import { closeDb, createPgliteDb, runMigrations, type AppDb } from "../../src/db/client";
import type { ServiceOverrides } from "../../src/deps";

export const TEST_ENV: Readonly<Record<string, string>> = {
  PAYPAL_ENV: "sandbox",
  APP_ENV: "test",
  APP_BASE_URL: "http://localhost:3000",
  DATABASE_URL: "pglite:memory",
  SESSION_SECRET: "test-session-secret-0123456789abcdef",
  JOBS_ENABLED: "false",
};

export function testConfig(env: Readonly<Record<string, string | undefined>> = {}): GatewayConfig {
  return loadGatewayConfig({ ...TEST_ENV, ...env });
}

/** In-memory PGlite with every migration applied. Close it with closeDb in afterAll. */
export async function createTestDb(): Promise<AppDb> {
  const db = await createPgliteDb();
  await runMigrations(db);
  return db;
}

export interface TestAppOptions {
  env?: Readonly<Record<string, string | undefined>>;
  /** Share one migrated DB across a file's tests; null = no database. Default: a fresh in-memory DB. */
  db?: AppDb | null;
  services?: ServiceOverrides;
  deps?: Omit<GatewayDeps, "db" | "services" | "logger">;
  /** Register extra (test-only) routes before the app is sealed by ready(). */
  beforeReady?: (app: FastifyInstance) => void | Promise<void>;
}

export interface TestApp {
  app: FastifyInstance;
  db: AppDb | null;
  close(): Promise<void>;
}

export async function buildTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const ownsDb = options.db === undefined;
  const db = options.db === undefined ? await createTestDb() : options.db;
  const app = await buildApp(testConfig(options.env), {
    ...options.deps,
    logger: false,
    db,
    ...(options.services === undefined ? {} : { services: options.services }),
  });
  await options.beforeReady?.(app);
  await app.ready();
  return {
    app,
    db,
    async close() {
      await app.close();
      if (ownsDb && db !== null) await closeDb(db);
    },
  };
}
