// Process entry point (`pnpm --filter @writ/gateway start`). Render sets PORT and needs 0.0.0.0;
// on deploy it sends SIGTERM and waits, so in-flight requests finish before the process exits.
import { buildApp } from "./app";
import { loadGatewayConfig } from "./config";

async function main(): Promise<void> {
  const config = loadGatewayConfig(process.env);
  const app = await buildApp(config);
  let closing = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, "shutting down");
    app.close().then(
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
}

main().catch((error: unknown) => {
  // Config errors never contain secret values (see config.ts and @writ/paypal loadPayPalConfig).
  console.error(`writ-gateway failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
