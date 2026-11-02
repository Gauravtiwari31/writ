// Gateway factory and configuration: health check, sandbox-only config, Fastify's JSON-schema
// compilers loaded only on first use, and spike routes mounted only behind ENABLE_SPIKES=true.
// Everything runs through app.inject(); nothing listens or calls PayPal.
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { DEFAULT_HOST, DEFAULT_PORT, GatewayConfigError, loadGatewayConfig, type GatewayConfig } from "../src/config";
import { lazySchemaController } from "../src/http/fastify";
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

describe("Fastify JSON-schema compilers (src/http/fastify.ts)", () => {
  // Counts calls through a Proxy, so the factory keeps its exact type.
  function counted<F extends (...args: never[]) => unknown>(fn: F, counter: { calls: number }): F {
    return new Proxy(fn, {
      apply(target, thisArg, args) {
        counter.calls += 1;
        return Reflect.apply(target, thisArg, args);
      },
    });
  }

  function countedController() {
    const { compilersFactory } = lazySchemaController();
    if (compilersFactory?.buildValidator === undefined || compilersFactory.buildSerializer === undefined) {
      throw new Error("lazySchemaController must provide both factories");
    }
    const validator = { calls: 0 };
    const serializer = { calls: 0 };
    const controller = {
      compilersFactory: {
        buildValidator: counted(compilersFactory.buildValidator, validator),
        buildSerializer: counted(compilersFactory.buildSerializer, serializer),
      },
    };
    return { controller, validator, serializer };
  }

  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((instance) => instance.close()));
  });

  // Loading ajv and fast-json-stringify is a one-time ~200 ms module cost per process. Pay it here,
  // through a default (eager) Fastify, so the tests below time only the behavior they check.
  beforeAll(async () => {
    const warm = Fastify({ logger: false });
    warm.post("/warm", { schema: { body: { type: "object" }, response: { 200: { type: "object" } } } }, async () => ({}));
    await warm.ready();
    await warm.close();
  });

  it("are never built for routes without a JSON schema (every gateway route: bodies are parsed with Zod)", async () => {
    const { controller, validator, serializer } = countedController();
    const instance = Fastify({ logger: false, schemaController: controller });
    apps.push(instance);
    instance.post("/zod-only", async (request) => ({ echoed: request.body }));
    await instance.ready();
    const res = await instance.inject({ method: "POST", url: "/zod-only", payload: { a: 1 } });
    expect(res.json()).toEqual({ echoed: { a: 1 } });
    expect(validator.calls).toBe(0);
    expect(serializer.calls).toBe(0);
  });

  it("load Fastify's defaults on first use and still validate and serialize a route that declares one", async () => {
    const { controller, validator, serializer } = countedController();
    const instance = Fastify({ logger: false, schemaController: controller });
    apps.push(instance);
    instance.post(
      "/json-schema",
      {
        schema: {
          body: { type: "object", required: ["n"], properties: { n: { type: "integer" } } },
          response: { 200: { type: "object", properties: { n: { type: "integer" } } } },
        },
      },
      async (request) => ({ ...(request.body as { n: number }), leaked: "dropped by the response schema" }),
    );
    await instance.ready();
    expect(validator.calls).toBe(1);
    expect(serializer.calls).toBe(1);
    expect((await instance.inject({ method: "POST", url: "/json-schema", payload: { n: "x" } })).statusCode).toBe(400);
    const ok = await instance.inject({ method: "POST", url: "/json-schema", payload: { n: 7 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ n: 7 });
  });

  it("are wired into buildApp: a JSON-schema route on the gateway answers 400 invalid_request", async () => {
    app = await buildApp(config(), { logger: false, verifyWebhook: null });
    app.post("/__t/json-schema", { schema: { body: { type: "object", required: ["n"] } } }, async () => ({ ok: true }));
    const res = await app.inject({ method: "POST", url: "/__t/json-schema", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_request" });
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
