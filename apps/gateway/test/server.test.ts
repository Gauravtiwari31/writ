// Gateway factory and configuration: health check, sandbox-only config, and spike routes mounted only
// behind ENABLE_SPIKES=true. Everything runs through app.inject(); nothing listens or calls PayPal.
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { DEFAULT_HOST, DEFAULT_PORT, GatewayConfigError, loadGatewayConfig, type GatewayConfig } from "../src/config";
import { HEALTH_BODY } from "../src/routes/health";
import { WEBHOOK_SPIKE_STATUS_PATH } from "../src/routes/webhooks";
import { PASSKEY_SPIKE_PREFIX } from "../src/spikes/passkey";

const SECRET = "client-secret-never-in-logs";
const BASE_ENV = { PAYPAL_ENV: "sandbox" } as const;

function config(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return { ...loadGatewayConfig(BASE_ENV), ...overrides };
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("loadGatewayConfig", () => {
  it("refuses to start unless PAYPAL_ENV is exactly sandbox", () => {
    expect(() => loadGatewayConfig({})).toThrow(GatewayConfigError);
    expect(() => loadGatewayConfig({ PAYPAL_ENV: "live" })).toThrow(/sandbox/);
    expect(() => loadGatewayConfig({ PAYPAL_ENV: "production" })).toThrow(GatewayConfigError);
  });

  it("defaults to Render's port on 0.0.0.0 and reads PORT, HOST and LOG_LEVEL", () => {
    const defaults = loadGatewayConfig(BASE_ENV);
    expect(defaults).toMatchObject({ env: "sandbox", host: DEFAULT_HOST, port: DEFAULT_PORT, logLevel: "info", enableSpikes: false, paypal: null, webhookId: null });
    expect(DEFAULT_HOST).toBe("0.0.0.0");
    expect(loadGatewayConfig({ ...BASE_ENV, PORT: "8080", HOST: "127.0.0.1", LOG_LEVEL: "debug" })).toMatchObject({ port: 8080, host: "127.0.0.1", logLevel: "debug" });
    expect(() => loadGatewayConfig({ ...BASE_ENV, PORT: "80a" })).toThrow(/PORT/);
    expect(() => loadGatewayConfig({ ...BASE_ENV, PORT: "70000" })).toThrow(/PORT/);
    expect(() => loadGatewayConfig({ ...BASE_ENV, LOG_LEVEL: "loud" })).toThrow(/LOG_LEVEL/);
  });

  it("loads PayPal credentials only as a pair and never exposes the secret", () => {
    expect(() => loadGatewayConfig({ ...BASE_ENV, PAYPAL_CLIENT_ID: "id" })).toThrow(/both/);
    const loaded = loadGatewayConfig({ ...BASE_ENV, PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: SECRET, PAYPAL_WEBHOOK_ID: "8PT597110X687430LKGECATA" });
    expect(loaded.paypal?.clientId).toBe("id");
    expect(loaded.paypal?.clientSecret).toBe(SECRET);
    expect(loaded.webhookId).toBe("8PT597110X687430LKGECATA");
    expect(JSON.stringify(loaded)).not.toContain(SECRET);
  });

  it("validates PAYPAL_WEBHOOK_ID", () => {
    expect(() => loadGatewayConfig({ ...BASE_ENV, PAYPAL_WEBHOOK_ID: "not an id" })).toThrow(/PAYPAL_WEBHOOK_ID/);
  });

  it("passes the passkey spike only the variables it reads, never the whole environment", () => {
    const loaded = loadGatewayConfig({ ...BASE_ENV, WEBAUTHN_RP_ID: "writ-gateway.onrender.com", PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: SECRET });
    expect(Object.keys(loaded.passkeyEnv).sort()).toEqual(["APP_BASE_URL", "GATEWAY_BASE_URL", "RENDER_EXTERNAL_URL", "WEBAUTHN_RP_ID", "WEBAUTHN_RP_NAME"]);
    expect(loaded.passkeyEnv.WEBAUTHN_RP_ID).toBe("writ-gateway.onrender.com");
  });

  it("enables spikes only for ENABLE_SPIKES=true", () => {
    expect(loadGatewayConfig({ ...BASE_ENV, ENABLE_SPIKES: "true" }).enableSpikes).toBe(true);
    expect(loadGatewayConfig({ ...BASE_ENV, ENABLE_SPIKES: "1" }).enableSpikes).toBe(false);
    expect(loadGatewayConfig({ ...BASE_ENV, ENABLE_SPIKES: "TRUE" }).enableSpikes).toBe(false);
  });
});

describe("GET /healthz", () => {
  it("answers 200 with the service identity, uncached", async () => {
    app = await buildApp(config(), { logger: false, verifyWebhook: null });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, service: "writ-gateway", env: "sandbox" });
    expect(res.json()).toEqual(HEALTH_BODY);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("stays healthy without PayPal credentials (webhooks then answer 503)", async () => {
    app = await buildApp(config(), { logger: false });
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
  });
});

describe("spike routes", () => {
  it("are absent unless ENABLE_SPIKES=true", async () => {
    app = await buildApp(config({ enableSpikes: false }), { logger: false, verifyWebhook: null });
    expect((await app.inject({ method: "GET", url: PASSKEY_SPIKE_PREFIX })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `${PASSKEY_SPIKE_PREFIX}/report` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: WEBHOOK_SPIKE_STATUS_PATH })).statusCode).toBe(404);
  });

  it("are mounted with ENABLE_SPIKES=true", async () => {
    app = await buildApp(loadGatewayConfig({ ...BASE_ENV, ENABLE_SPIKES: "true" }), { logger: false, verifyWebhook: null });
    expect((await app.inject({ method: "GET", url: PASSKEY_SPIKE_PREFIX })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `${PASSKEY_SPIKE_PREFIX}/report` })).statusCode).toBe(200);
    const recent = await app.inject({ method: "GET", url: WEBHOOK_SPIKE_STATUS_PATH });
    expect(recent.statusCode).toBe(200);
    expect(recent.json()).toMatchObject({ spike: "S3", deliveries: [] });
  });

  it("leave ordinary JSON parsing intact outside the webhook scope", async () => {
    app = await buildApp(loadGatewayConfig({ ...BASE_ENV, ENABLE_SPIKES: "true" }), { logger: false, verifyWebhook: null });
    // The passkey spike's JSON routes still get parsed objects (an empty object fails its schema with 400, not 415/500).
    const res = await app.inject({ method: "POST", url: `${PASSKEY_SPIKE_PREFIX}/sign/verify`, payload: {} });
    expect(res.statusCode).toBe(400);
  });
});
