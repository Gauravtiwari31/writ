// Process entry point (`pnpm --filter @writ/gateway start`). Opens the database DATABASE_URL names
// (Postgres in production; file-backed PGlite for local runs, plan decision 4), applies migrations,
// builds the app, listens, then starts the outbox job runner. Render sets PORT and needs 0.0.0.0;
// on deploy it sends SIGTERM and waits, so in-flight work finishes before the process exits.
//
// FROZEN for the parallel build (docs/ARCHITECTURE.md).
import { buildApp } from "./app";
import { loadGatewayConfig } from "./config";
import { closeDb, openDatabase, runMigrations } from "./db/client";

async function main(): Promise<void> {
  const config = loadGatewayConfig(process.env);
  const db = await openDatabase(config.database);
  await runMigrations(db);
  const app = await buildApp(config, { db });
  // Never log a postgres URL (it carries the password); the PGlite directory is harmless.
  app.log.info(
    { database: config.database.kind, ...(config.database.kind === "pglite" ? { dataDir: config.database.dataDir ?? "memory" } : {}) },
    "database ready (migrations applied)",
  );
  await app.services.runs.recoverOnStartup();

  let closing = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, "shutting down");
    const close = async (): Promise<void> => {
      await app.services.jobs.stop();
      await app.services.runs.shutdown();
      await app.close();
      await closeDb(db);
    };
    close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.log.error({ err: error }, "shutdown failed");
        process.exit(1);
      },
    );
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  await app.listen({ host: config.host, port: config.port });
  if (config.jobs.enabled) app.services.jobs.start();
}

main().catch((error: unknown) => {
  // Config errors never contain secret values (see config.ts and @writ/paypal loadPayPalConfig).
  console.error(`writ-gateway failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
