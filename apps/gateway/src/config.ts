// Gateway configuration from the environment. Sandbox only (§22 rule 21): the gateway refuses to start
// unless PAYPAL_ENV is exactly "sandbox". PayPal credentials and the webhook id may be missing on a
// first deploy; the webhook route then answers 503 so PayPal keeps retrying until they are set.
import { loadPayPalConfig, type EnvSource, type PayPalConfig } from "@writ/paypal";
import { spikesEnabled } from "./spikes/passkey";

export class GatewayConfigError extends Error {
  override readonly name = "GatewayConfigError";
}

export interface GatewayConfig {
  readonly env: "sandbox";
  readonly host: string;
  readonly port: number;
  readonly logLevel: string;
  /** ENABLE_SPIKES=true mounts the Day-1 spike routes (passkey S6, webhook S3 status). */
  readonly enableSpikes: boolean;
  /** null until PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are set. The secret is non-enumerable. */
  readonly paypal: PayPalConfig | null;
  /** The sandbox webhook subscription id (scripts/spike-webhooks.ts register prints it). */
  readonly webhookId: string | null;
  /** Only the variables the passkey spike reads; never the whole environment (it holds secrets). */
  readonly passkeyEnv: Readonly<Record<string, string | undefined>>;
}

/** Render injects PORT (default 10000) and needs the server on 0.0.0.0. */
export const DEFAULT_PORT = 10_000;
export const DEFAULT_HOST = "0.0.0.0";
const LOG_LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);
const PASSKEY_ENV_NAMES = ["WEBAUTHN_RP_ID", "WEBAUTHN_RP_NAME", "APP_BASE_URL", "GATEWAY_BASE_URL", "RENDER_EXTERNAL_URL"] as const;

function read(env: EnvSource, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;
  if (!/^\d+$/.test(raw)) throw new GatewayConfigError(`PORT must be an integer, got ${JSON.stringify(raw)}`);
  const port = Number(raw);
  if (port < 1 || port > 65_535) throw new GatewayConfigError(`PORT must be between 1 and 65535, got ${port}`);
  return port;
}

export function loadGatewayConfig(env: EnvSource = process.env): GatewayConfig {
  const mode = read(env, "PAYPAL_ENV");
  if (mode !== "sandbox") {
    throw new GatewayConfigError(
      `PAYPAL_ENV must be "sandbox" (${mode === undefined ? "it is not set" : `got ${JSON.stringify(mode)}`}). Writ runs on the PayPal sandbox only (plan §22 rule 21).`,
    );
  }
  const logLevel = read(env, "LOG_LEVEL") ?? "info";
  if (!LOG_LEVELS.has(logLevel)) throw new GatewayConfigError(`LOG_LEVEL must be one of ${[...LOG_LEVELS].join(", ")}`);

  const hasId = read(env, "PAYPAL_CLIENT_ID") !== undefined;
  const hasSecret = read(env, "PAYPAL_CLIENT_SECRET") !== undefined;
  if (hasId !== hasSecret) throw new GatewayConfigError("Set both PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET, or neither.");
  const paypal = hasId ? loadPayPalConfig(env) : null;

  const webhookId = read(env, "PAYPAL_WEBHOOK_ID") ?? null;
  if (webhookId !== null && !/^[A-Za-z0-9]{1,50}$/.test(webhookId)) {
    throw new GatewayConfigError("PAYPAL_WEBHOOK_ID must be the webhook id PayPal returned (letters and digits, at most 50).");
  }

  const passkeyEnv: Record<string, string | undefined> = {};
  for (const name of PASSKEY_ENV_NAMES) passkeyEnv[name] = read(env, name);

  return {
    env: "sandbox",
    host: read(env, "HOST") ?? DEFAULT_HOST,
    port: parsePort(read(env, "PORT")),
    logLevel,
    enableSpikes: spikesEnabled(env),
    paypal,
    webhookId,
    passkeyEnv,
  };
}
