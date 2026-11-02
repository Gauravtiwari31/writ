// `pnpm dev`: the gateway and the Wallet together, locally, with no external services (plan
// decision 4). The gateway runs on file-backed PGlite under <repo>/.data/gateway (migrations apply
// at startup); the Wallet proxies /gw/* to it. PayPal, model providers and Channel3 stay
// unconfigured unless .env sets them, and every such feature degrades visibly (GET /v1/meta).
//
// Owner: judge stream (local dev launcher). Values come from .env when present; nothing is printed
// except which optional integrations are configured.
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { optionalEnv, REPO_ROOT } from "./lib/env";

const gatewayPort = optionalEnv("PORT") ?? "10000";
const webPort = "3000";

const env: NodeJS.ProcessEnv = {
  ...process.env,
  PAYPAL_ENV: optionalEnv("PAYPAL_ENV") ?? "sandbox",
  APP_ENV: optionalEnv("APP_ENV") ?? "development",
  APP_BASE_URL: optionalEnv("APP_BASE_URL") ?? `http://localhost:${webPort}`,
  GATEWAY_BASE_URL: optionalEnv("GATEWAY_BASE_URL") ?? `http://localhost:${gatewayPort}`,
  DATABASE_URL: optionalEnv("DATABASE_URL") ?? `pglite:${resolve(REPO_ROOT, ".data/gateway")}`,
  HOST: optionalEnv("HOST") ?? "127.0.0.1",
  PORT: gatewayPort,
  JUDGE_MODE: optionalEnv("JUDGE_MODE") ?? "true",
  NEXT_TELEMETRY_DISABLED: "1",
};

const integrations = ["PAYPAL_CLIENT_ID", "PAYPAL_WEBHOOK_ID", "CHANNEL3_API_KEY", "MODEL_COMPILER", "MODEL_AGENT", "MODEL_VERIFIER"];
console.log(`writ dev: gateway http://localhost:${gatewayPort} · wallet http://localhost:${webPort}`);
console.log(`writ dev: database ${env.DATABASE_URL?.startsWith("pglite:") === true ? env.DATABASE_URL : "postgres (from .env)"}`);
console.log(`writ dev: ${integrations.map((name) => `${name}=${optionalEnv(name) === undefined ? "unset" : "set"}`).join("  ")}`);

const children: ChildProcess[] = [];

function start(name: string, filter: string): void {
  const child = spawn("pnpm", ["--filter", filter, "dev"], {
    cwd: REPO_ROOT,
    env,
    // pnpm is a .cmd shim on Windows.
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const prefix = (chunk: Buffer, write: (text: string) => void) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) if (line.trim() !== "") write(`[${name}] ${line}\n`);
  };
  child.stdout?.on("data", (chunk: Buffer) => prefix(chunk, (text) => process.stdout.write(text)));
  child.stderr?.on("data", (chunk: Buffer) => prefix(chunk, (text) => process.stderr.write(text)));
  child.on("exit", (code) => {
    console.log(`[${name}] exited with ${code ?? "a signal"}`);
    stopAll(code ?? 1);
  });
  children.push(child);
}

let stopping = false;
function stopAll(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null || child.pid === undefined) continue;
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 500).unref();
}

process.once("SIGINT", () => stopAll(0));
process.once("SIGTERM", () => stopAll(0));

start("gateway", "@writ/gateway");
start("web", "@writ/web");
