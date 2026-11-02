// Config for the parallel build: APP_ENV, DATABASE_URL (postgres | pglite), sessions, WebAuthn,
// judge limits, jobs, and secrets that never serialize.
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PGLITE_DIR, FIXTURES_DIR, GatewayConfigError, loadGatewayConfig, parseDatabaseUrl } from "../src/config";

const BASE = { PAYPAL_ENV: "sandbox" } as const;
const SECRET = "x".repeat(40);

describe("APP_ENV and production requirements", () => {
  it("defaults to development, and to production on Render", () => {
    expect(loadGatewayConfig(BASE).appEnv).toBe("development");
    expect(() => loadGatewayConfig({ ...BASE, RENDER: "true" })).toThrow(/SESSION_SECRET is required in production/);
    expect(loadGatewayConfig({ ...BASE, APP_ENV: "test" }).appEnv).toBe("test");
    expect(() => loadGatewayConfig({ ...BASE, APP_ENV: "staging" })).toThrow(GatewayConfigError);
  });

  it("requires SESSION_SECRET and a postgres DATABASE_URL in production", () => {
    const prod = { ...BASE, APP_ENV: "production" };
    expect(() => loadGatewayConfig(prod)).toThrow(/SESSION_SECRET/);
    expect(() => loadGatewayConfig({ ...prod, SESSION_SECRET: SECRET })).toThrow(/DATABASE_URL is required/);
    expect(() => loadGatewayConfig({ ...prod, SESSION_SECRET: SECRET, DATABASE_URL: "pglite:.data/x" })).toThrow(/postgres/);
    const ok = loadGatewayConfig({ ...prod, SESSION_SECRET: SECRET, DATABASE_URL: "postgres://writ:pw@db.internal/writ" });
    expect(ok.database).toEqual({ kind: "postgres", url: "postgres://writ:pw@db.internal/writ" });
    expect(ok.session.ephemeral).toBe(false);
    // No Wallet URL in production: boot anyway, passkeys unavailable (visible, not a crash).
    expect(ok.appBaseUrl).toBeNull();
    expect(ok.webauthn).toBeNull();
  });

  it("refuses short session secrets", () => {
    expect(() => loadGatewayConfig({ ...BASE, SESSION_SECRET: "short" })).toThrow(/at least 32/);
  });
});

describe("DATABASE_URL", () => {
  it("parses postgres, pglite:<dir>, pglite:memory and the local default", () => {
    expect(parseDatabaseUrl("postgresql://a@b/c", "development")).toEqual({ kind: "postgres", url: "postgresql://a@b/c" });
    expect(parseDatabaseUrl("pglite:memory", "test")).toEqual({ kind: "pglite", dataDir: null });
    expect(parseDatabaseUrl("pglite:.data/gw", "development", "/repo")).toEqual({ kind: "pglite", dataDir: resolve("/repo", ".data/gw") });
    expect(parseDatabaseUrl(undefined, "development", "/repo")).toEqual({ kind: "pglite", dataDir: resolve("/repo", DEFAULT_PGLITE_DIR) });
    expect(() => parseDatabaseUrl("pglite:", "development")).toThrow(GatewayConfigError);
    expect(() => parseDatabaseUrl("mysql://x", "development")).toThrow(/not printed/);
  });
});

describe("FIXTURES_DIR", () => {
  it("is <repo>/fixtures, next to plan.md, wherever the process starts", () => {
    expect(basename(FIXTURES_DIR)).toBe("fixtures");
    expect(existsSync(join(FIXTURES_DIR, "..", "plan.md"))).toBe(true);
    expect(existsSync(join(FIXTURES_DIR, "..", "apps", "gateway", "package.json"))).toBe(true);
  });
});

describe("URLs, WebAuthn and sessions", () => {
  it("defaults to the local Wallet and gateway origins in development", () => {
    const config = loadGatewayConfig({ ...BASE, PORT: "10001" });
    expect(config.appBaseUrl).toBe("http://localhost:3000");
    expect(config.gatewayBaseUrl).toBe("http://localhost:10001");
    expect(config.gatewayInternalUrl).toBe("http://127.0.0.1:10001");
    expect(config.webauthn).toEqual({ rpId: "localhost", rpName: "Writ", origin: "http://localhost:3000" });
    expect(config.session).toMatchObject({ ephemeral: true, secure: false, cookieName: "writ_session" });
  });

  it("uses the Wallet host as RP ID and degrades (not crashes) on a mismatch", () => {
    const deployed = loadGatewayConfig({ ...BASE, APP_BASE_URL: "https://writ-web.onrender.com/some/path" });
    expect(deployed.appBaseUrl).toBe("https://writ-web.onrender.com");
    expect(deployed.webauthn?.rpId).toBe("writ-web.onrender.com");
    expect(deployed.session.secure).toBe(true);
    const spike = loadGatewayConfig({ ...BASE, APP_BASE_URL: "https://writ-web.onrender.com", WEBAUTHN_RP_ID: "writ-gateway.onrender.com" });
    expect(spike.webauthn).toBeNull();
    expect(spike.webauthnProblem).toMatch(/not the Wallet host/);
    expect(() => loadGatewayConfig({ ...BASE, APP_BASE_URL: "ftp://x" })).toThrow(/http/);
  });
});

describe("judge mode, jobs and secrets", () => {
  it("reads judge limits and job settings", () => {
    const config = loadGatewayConfig({
      ...BASE,
      JUDGE_MODE: "true",
      DEMO_HERO_RUNS_PER_HOUR: "7",
      DEMO_LLM_CALLS_PER_DAY: "250",
      DEMO_PAYPAL_VAULT_ID: "8kk8451t",
      JOBS_ENABLED: "false",
      JOB_POLL_INTERVAL_MS: "250",
    });
    expect(config.judge).toEqual({ enabled: true, heroRunsPerHour: 7, llmCallsPerDay: 250, demoVaultId: "8kk8451t" });
    expect(config.jobs).toEqual({ enabled: false, pollIntervalMs: 250 });
    expect(loadGatewayConfig(BASE).judge).toMatchObject({ enabled: false, heroRunsPerHour: 5 });
    expect(() => loadGatewayConfig({ ...BASE, JUDGE_MODE: "yes" })).toThrow(/JUDGE_MODE/);
    expect(() => loadGatewayConfig({ ...BASE, DEMO_PAYPAL_VAULT_ID: "bad id!" })).toThrow(/DEMO_PAYPAL_VAULT_ID/);
  });

  it("keeps every secret out of JSON and spreads", () => {
    const config = loadGatewayConfig({
      ...BASE,
      SESSION_SECRET: SECRET,
      CHANNEL3_API_KEY: "c3-secret-value",
      GROQ_API_KEY: "gsk_secretvalue",
      MODEL_VERIFIER: "groq:some-model",
      PAYPAL_CLIENT_ID: "client-id",
      PAYPAL_CLIENT_SECRET: "pp-secret-value",
    });
    const serialized = JSON.stringify({ ...config });
    for (const secret of [SECRET, "c3-secret-value", "gsk_secretvalue", "pp-secret-value"]) expect(serialized).not.toContain(secret);
    expect(config.secrets.channel3ApiKey()).toBe("c3-secret-value");
    expect(config.secrets.aiEnv()).toMatchObject({ GROQ_API_KEY: "gsk_secretvalue", MODEL_VERIFIER: "groq:some-model" });
    expect(new TextDecoder().decode(config.secrets.sessionSecret())).toBe(SECRET);
    // Spreading keeps the accessors (tests build configs with { ...config, ...overrides }).
    expect({ ...config }.secrets.channel3ApiKey()).toBe("c3-secret-value");
  });
});
