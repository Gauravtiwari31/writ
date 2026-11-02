// Gateway configuration from the environment (plan §14 .env.example). Sandbox only (§22 rule 21):
// the gateway refuses to start unless PAYPAL_ENV is exactly "sandbox". Everything optional degrades
// visibly instead of failing (plan decisions 7 and 8): no PayPal credentials → webhooks answer 503
// and a checkout fails at AUTHORIZE with paypal_unconfigured; no MODEL_* → AI roles are null.
//
// Production (APP_ENV=production, or Render's RENDER=true when APP_ENV is unset) additionally
// requires SESSION_SECRET and a postgres:// DATABASE_URL. Secrets sit behind accessor functions in
// `config.secrets` (and PayPal's secret is non-enumerable), so logging, spreading or
// JSON-serializing the config never prints them.
//
// FROZEN for the parallel build (docs/ARCHITECTURE.md): ask the architect for a new variable.
import { randomBytes } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDER_KEY_ENV, ROLES, roleEnvName } from "@writ/ai";
import { loadPayPalConfig, type EnvSource, type PayPalConfig } from "@writ/paypal";
import type { DatabaseSpec } from "./db/client";
import { spikesEnabled } from "./spikes/passkey";

export class GatewayConfigError extends Error {
  override readonly name = "GatewayConfigError";
}

export type AppEnv = "production" | "development" | "test";

export interface WebAuthnConfig {
  /** RP ID = the Wallet host (plan §6.6): onrender.com is a public suffix, so it is the exact host. */
  readonly rpId: string;
  readonly rpName: string;
  /** expectedOrigin for every assertion: the Wallet origin (APP_BASE_URL). */
  readonly origin: string;
}

export interface SessionConfig {
  /** True when SESSION_SECRET was missing in development: sessions die with the process. */
  readonly ephemeral: boolean;
  readonly cookieName: string;
  readonly ttlSeconds: number;
  readonly judgeTtlSeconds: number;
  /** Secure cookie flag: on when the Wallet origin is https. */
  readonly secure: boolean;
}

export interface JudgeConfig {
  /** JUDGE_MODE=true mounts the one-click judge path (plan §18). */
  readonly enabled: boolean;
  readonly heroRunsPerHour: number;
  /** Global daily LLM call budget across all tenants. */
  readonly llmCallsPerDay: number;
  /** A real sandbox Vault payment token id (from Spike S1) seeded for judge tenants; null = none. */
  readonly demoVaultId: string | null;
}

export interface JobsConfig {
  /** Start the outbox poller in server.ts (tests drive jobs directly). */
  readonly enabled: boolean;
  readonly pollIntervalMs: number;
}

/** Accessors, not values: JSON.stringify skips functions, and a spread copies the same accessors. */
export interface GatewaySecrets {
  /** HMAC-SHA256 key for the session cookie (SESSION_SECRET, or an ephemeral random key in development). */
  sessionSecret(): Uint8Array;
  /** CHANNEL3_API_KEY; null = search falls back to labeled fixtures. */
  channel3ApiKey(): string | null;
  /** MODEL_<ROLE> lists and provider keys, the env @writ/ai's router reads. */
  aiEnv(): Readonly<Record<string, string | undefined>>;
}

export interface GatewayConfig {
  readonly env: "sandbox";
  readonly appEnv: AppEnv;
  readonly host: string;
  readonly port: number;
  readonly logLevel: string;
  /** ENABLE_SPIKES=true mounts the Day-1 spike routes (passkey S6, webhook S3 status). */
  readonly enableSpikes: boolean;
  /** null until PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are set. The secret is non-enumerable. */
  readonly paypal: PayPalConfig | null;
  /** The sandbox webhook subscription id (scripts/spike-webhooks.ts register prints it). */
  readonly webhookId: string | null;
  /** PAYPAL_SANDBOX_BUYER_EMAIL: buyer for sandbox dispute simulation (PayPal-Auth-Assertion). */
  readonly buyerEmail: string | null;
  /** Only the variables the passkey spike reads; never the whole environment (it holds secrets). */
  readonly passkeyEnv: Readonly<Record<string, string | undefined>>;
  /** The Wallet origin (APP_BASE_URL). null only in production when unset: passkey routes answer 503. */
  readonly appBaseUrl: string | null;
  /** This gateway's public origin (GATEWAY_BASE_URL, else Render's RENDER_EXTERNAL_URL). */
  readonly gatewayBaseUrl: string | null;
  /** Where built-in agents reach the public agent API from inside the process (loopback by default). */
  readonly gatewayInternalUrl: string;
  readonly database: DatabaseSpec;
  /** null when APP_BASE_URL is unknown or WEBAUTHN_RP_ID does not fit it: passkey routes answer 503. */
  readonly webauthn: WebAuthnConfig | null;
  /** Why webauthn is null (logged at boot), or null. */
  readonly webauthnProblem: string | null;
  readonly session: SessionConfig;
  readonly judge: JudgeConfig;
  readonly jobs: JobsConfig;
  readonly secrets: GatewaySecrets;
}

/** Render injects PORT (default 10000) and needs the server on 0.0.0.0. */
export const DEFAULT_PORT = 10_000;
export const DEFAULT_HOST = "0.0.0.0";
export const DEFAULT_APP_BASE_URL = "http://localhost:3000";
/** Relative to the process working directory; .data/ is git-ignored. */
export const DEFAULT_PGLITE_DIR = ".data/gateway";
/**
 * <repo>/fixtures: the security test fixture sites (§22 rule 22), e.g. fixtures/deals-outlet with its
 * pages and catalog.json (FixtureCatalogSchema in @writ/core). The gateway runs from the repo
 * checkout locally and on Render, so the path is fixed relative to this file.
 */
export const FIXTURES_DIR = fileURLToPath(new URL("../../../fixtures", import.meta.url));
export const SESSION_COOKIE_NAME = "writ_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 3600;
export const JUDGE_SESSION_TTL_SECONDS = 24 * 3600;
export const MIN_SESSION_SECRET_LENGTH = 32;

const LOG_LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);
const APP_ENVS: ReadonlySet<string> = new Set(["production", "development", "test"]);
const PASSKEY_ENV_NAMES = ["WEBAUTHN_RP_ID", "WEBAUTHN_RP_NAME", "APP_BASE_URL", "GATEWAY_BASE_URL", "RENDER_EXTERNAL_URL"] as const;
const RP_ID_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const VAULT_ID_RE = /^[0-9a-zA-Z_-]{1,255}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function parseInt(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new GatewayConfigError(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  const value = Number(raw);
  if (value < min || value > max) throw new GatewayConfigError(`${name} must be between ${min} and ${max}, got ${value}`);
  return value;
}

function parseBool(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new GatewayConfigError(`${name} must be "true" or "false", got ${JSON.stringify(raw)}`);
}

/** An http(s) URL reduced to its origin (no path, no trailing slash). */
function parseOrigin(name: string, raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GatewayConfigError(`${name} must be an absolute URL such as https://writ-web.onrender.com`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new GatewayConfigError(`${name} must be an http(s) URL`);
  return url.origin;
}

function parseAppEnv(env: EnvSource): AppEnv {
  const raw = read(env, "APP_ENV");
  if (raw === undefined) return read(env, "RENDER") === "true" ? "production" : "development";
  if (!APP_ENVS.has(raw)) throw new GatewayConfigError(`APP_ENV must be production, development or test, got ${JSON.stringify(raw)}`);
  return raw as AppEnv;
}

/** DATABASE_URL: postgres://… | postgresql://… | pglite:<dir> | pglite:memory. */
export function parseDatabaseUrl(raw: string | undefined, appEnv: AppEnv, cwd: string = process.cwd()): DatabaseSpec {
  if (raw === undefined) {
    if (appEnv === "production") throw new GatewayConfigError("DATABASE_URL is required in production (a postgres:// URL).");
    return { kind: "pglite", dataDir: resolve(cwd, DEFAULT_PGLITE_DIR) };
  }
  if (raw.startsWith("postgres://") || raw.startsWith("postgresql://")) return { kind: "postgres", url: raw };
  if (raw.startsWith("pglite:")) {
    if (appEnv === "production") throw new GatewayConfigError("DATABASE_URL must be a postgres:// URL in production; pglite: is for local runs only.");
    const target = raw.slice("pglite:".length);
    if (target === "memory") return { kind: "pglite", dataDir: null };
    if (target === "") throw new GatewayConfigError("DATABASE_URL=pglite:<dir> needs a directory (or pglite:memory).");
    return { kind: "pglite", dataDir: isAbsolute(target) ? target : resolve(cwd, target) };
  }
  throw new GatewayConfigError("DATABASE_URL must start with postgres://, postgresql:// or pglite: (the value is not printed).");
}

function loadSession(env: EnvSource, appEnv: AppEnv, appBaseUrl: string | null): { session: SessionConfig; secret: Uint8Array } {
  const raw = read(env, "SESSION_SECRET");
  if (raw !== undefined && raw.length < MIN_SESSION_SECRET_LENGTH) {
    throw new GatewayConfigError(`SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters.`);
  }
  if (raw === undefined && appEnv === "production") {
    throw new GatewayConfigError("SESSION_SECRET is required in production (render.yaml generates one).");
  }
  const session: SessionConfig = {
    ephemeral: raw === undefined,
    cookieName: SESSION_COOKIE_NAME,
    ttlSeconds: SESSION_TTL_SECONDS,
    judgeTtlSeconds: JUDGE_SESSION_TTL_SECONDS,
    secure: appBaseUrl?.startsWith("https:") ?? false,
  };
  const secret = raw === undefined ? new Uint8Array(randomBytes(32)) : new TextEncoder().encode(raw);
  return { session, secret };
}

/**
 * Not fatal on purpose: during the Day-1 spikes WEBAUTHN_RP_ID names the gateway host (S6), and a
 * deploy must not fail because of it. A mismatch makes product passkey routes unavailable until
 * WEBAUTHN_RP_ID is the Wallet host (plan decision 2).
 */
function loadWebAuthn(env: EnvSource, appBaseUrl: string | null): { webauthn: WebAuthnConfig | null; problem: string | null } {
  if (appBaseUrl === null) return { webauthn: null, problem: "APP_BASE_URL is not set" };
  const host = new URL(appBaseUrl).hostname;
  const rpId = read(env, "WEBAUTHN_RP_ID") ?? host;
  if (!RP_ID_RE.test(rpId)) {
    return { webauthn: null, problem: `WEBAUTHN_RP_ID must be a bare lowercase hostname (no scheme, port or path), got ${JSON.stringify(rpId)}` };
  }
  if (host !== rpId && !host.endsWith(`.${rpId}`)) {
    return { webauthn: null, problem: `WEBAUTHN_RP_ID (${rpId}) is not the Wallet host (${host}) or a registrable parent of it` };
  }
  return { webauthn: { rpId, rpName: read(env, "WEBAUTHN_RP_NAME") ?? "Writ", origin: appBaseUrl }, problem: null };
}

function loadAiEnv(env: EnvSource): Readonly<Record<string, string | undefined>> {
  const names = [...ROLES.map((role) => roleEnvName(role)), ...Object.values(PROVIDER_KEY_ENV)];
  const out: Record<string, string | undefined> = {};
  for (const name of names) out[name] = read(env, name);
  return Object.freeze(out);
}

export function loadGatewayConfig(env: EnvSource = process.env): GatewayConfig {
  const mode = read(env, "PAYPAL_ENV");
  if (mode !== "sandbox") {
    throw new GatewayConfigError(
      `PAYPAL_ENV must be "sandbox" (${mode === undefined ? "it is not set" : `got ${JSON.stringify(mode)}`}). Writ runs on the PayPal sandbox only (plan §22 rule 21).`,
    );
  }
  const appEnv = parseAppEnv(env);
  const logLevel = read(env, "LOG_LEVEL") ?? "info";
  if (!LOG_LEVELS.has(logLevel)) throw new GatewayConfigError(`LOG_LEVEL must be one of ${[...LOG_LEVELS].join(", ")}`);
  const port = parsePort(read(env, "PORT"));

  const hasId = read(env, "PAYPAL_CLIENT_ID") !== undefined;
  const hasSecret = read(env, "PAYPAL_CLIENT_SECRET") !== undefined;
  if (hasId !== hasSecret) throw new GatewayConfigError("Set both PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET, or neither.");
  const paypal = hasId ? loadPayPalConfig(env) : null;

  const webhookId = read(env, "PAYPAL_WEBHOOK_ID") ?? null;
  if (webhookId !== null && !/^[A-Za-z0-9]{1,50}$/.test(webhookId)) {
    throw new GatewayConfigError("PAYPAL_WEBHOOK_ID must be the webhook id PayPal returned (letters and digits, at most 50).");
  }
  const buyerEmail = read(env, "PAYPAL_SANDBOX_BUYER_EMAIL") ?? null;
  if (buyerEmail !== null && !EMAIL_RE.test(buyerEmail)) throw new GatewayConfigError("PAYPAL_SANDBOX_BUYER_EMAIL must be an email address.");

  const passkeyEnv: Record<string, string | undefined> = {};
  for (const name of PASSKEY_ENV_NAMES) passkeyEnv[name] = read(env, name);

  const appBaseUrl = parseOrigin("APP_BASE_URL", read(env, "APP_BASE_URL")) ?? (appEnv === "production" ? null : DEFAULT_APP_BASE_URL);
  const gatewayBaseUrl =
    parseOrigin("GATEWAY_BASE_URL", read(env, "GATEWAY_BASE_URL")) ??
    parseOrigin("RENDER_EXTERNAL_URL", read(env, "RENDER_EXTERNAL_URL")) ??
    (appEnv === "production" ? null : `http://localhost:${port}`);
  const gatewayInternalUrl = parseOrigin("GATEWAY_INTERNAL_URL", read(env, "GATEWAY_INTERNAL_URL")) ?? `http://127.0.0.1:${port}`;

  const demoVaultId = read(env, "DEMO_PAYPAL_VAULT_ID") ?? null;
  if (demoVaultId !== null && !VAULT_ID_RE.test(demoVaultId)) {
    throw new GatewayConfigError("DEMO_PAYPAL_VAULT_ID must be a Vault payment token id (letters, digits, _ and -).");
  }

  const { session, secret } = loadSession(env, appEnv, appBaseUrl);
  const { webauthn, problem: webauthnProblem } = loadWebAuthn(env, appBaseUrl);
  const channel3ApiKey = read(env, "CHANNEL3_API_KEY") ?? null;
  const aiEnv = loadAiEnv(env);
  const secrets: GatewaySecrets = Object.freeze({
    sessionSecret: () => secret.slice(),
    channel3ApiKey: () => channel3ApiKey,
    aiEnv: () => aiEnv,
  });

  return {
    env: "sandbox",
    appEnv,
    host: read(env, "HOST") ?? DEFAULT_HOST,
    port,
    logLevel,
    enableSpikes: spikesEnabled(env),
    paypal,
    webhookId,
    buyerEmail,
    passkeyEnv,
    appBaseUrl,
    gatewayBaseUrl,
    gatewayInternalUrl,
    database: parseDatabaseUrl(read(env, "DATABASE_URL"), appEnv),
    webauthn,
    webauthnProblem,
    session,
    judge: {
      enabled: parseBool("JUDGE_MODE", read(env, "JUDGE_MODE"), false),
      heroRunsPerHour: parseInt("DEMO_HERO_RUNS_PER_HOUR", read(env, "DEMO_HERO_RUNS_PER_HOUR"), 5, 0, 1000),
      llmCallsPerDay: parseInt("DEMO_LLM_CALLS_PER_DAY", read(env, "DEMO_LLM_CALLS_PER_DAY"), 1000, 0, 1_000_000),
      demoVaultId,
    },
    jobs: {
      enabled: parseBool("JOBS_ENABLED", read(env, "JOBS_ENABLED"), true),
      pollIntervalMs: parseInt("JOB_POLL_INTERVAL_MS", read(env, "JOB_POLL_INTERVAL_MS"), 1000, 50, 60_000),
    },
    secrets,
  };
}
