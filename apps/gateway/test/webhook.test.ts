// POST /v1/webhooks/paypal through app.inject(): a fake verifier stands in for PayPal's postback API,
// and one test drives the real verifier against a fetch fake to check what would be sent to PayPal.
import { makePayPalConfig, PayPalApiError, PayPalHttp, type FetchLike, type WebhookVerification } from "@writ/paypal";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { loadGatewayConfig, type GatewayConfig } from "../src/config";
import { PAYPAL_WEBHOOK_PATH, paypalWebhookVerifier, WEBHOOK_SPIKE_STATUS_PATH, type WebhookVerifier, type WebhookVerifyRequest } from "../src/routes/webhooks";

const WEBHOOK_ID = "8PT597110X687430LKGECATA";
const SIGNED_HEADERS = {
  "content-type": "application/json",
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77",
  "paypal-transmission-id": "69cd13f0-d67a-11e5-baa3-778b53f4ae55",
  "paypal-transmission-sig": "c2lnbmF0dXJl",
  "paypal-transmission-time": "2026-11-01T09:22:15Z",
};

// Whitespace and a number with a trailing zero: both must reach the verifier exactly as sent.
const RAW_EVENT = `{ "id": "WH-58D329510W468432D-8HN650336L201105X", "event_type": "PAYMENT.CAPTURE.COMPLETED",
  "resource_type": "capture", "resource": { "id": "2GG279541U471931P", "amount": { "currency_code": "USD", "value": "44.00" }, "rate": 1.50 } }`;

function config(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return { ...loadGatewayConfig({ PAYPAL_ENV: "sandbox" }), ...overrides };
}

interface FakeVerifier {
  readonly verify: WebhookVerifier;
  readonly calls: WebhookVerifyRequest[];
}

function fakeVerifier(result: Partial<WebhookVerification> | (() => Promise<WebhookVerification>) = {}): FakeVerifier {
  const calls: WebhookVerifyRequest[] = [];
  const verify: WebhookVerifier = (request) => {
    calls.push(request);
    if (typeof result === "function") return result();
    return Promise.resolve({ verificationStatus: "SUCCESS", paypalStatus: "SUCCESS", debugId: "dbg-verify", ...result });
  };
  return { verify, calls };
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(verifier: WebhookVerifier | null, overrides: Partial<GatewayConfig> = {}): Promise<FastifyInstance> {
  app = await buildApp(config(overrides), { logger: false, verifyWebhook: verifier });
  return app;
}

function deliver(instance: FastifyInstance, body: string = RAW_EVENT, headers: Record<string, string> = SIGNED_HEADERS) {
  return instance.inject({ method: "POST", url: PAYPAL_WEBHOOK_PATH, headers, payload: body });
}

describe("POST /v1/webhooks/paypal", () => {
  it("answers 200 when PayPal verifies the signature", async () => {
    const fake = fakeVerifier();
    const res = await deliver(await start(fake.verify));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, event_id: "WH-58D329510W468432D-8HN650336L201105X", verification_status: "SUCCESS" });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.headers).toEqual({
      authAlgo: "SHA256withRSA",
      certUrl: SIGNED_HEADERS["paypal-cert-url"],
      transmissionId: SIGNED_HEADERS["paypal-transmission-id"],
      transmissionSig: SIGNED_HEADERS["paypal-transmission-sig"],
      transmissionTime: SIGNED_HEADERS["paypal-transmission-time"],
    });
  });

  it("hands the verifier the raw body unchanged", async () => {
    const fake = fakeVerifier();
    await deliver(await start(fake.verify));
    expect(fake.calls[0]?.rawBody).toBe(RAW_EVENT);
    expect(JSON.stringify(fake.calls[0]?.verbatim)).toContain('"rate":1.50');
  });

  it("keeps the raw body for any content type PayPal might send", async () => {
    const fake = fakeVerifier();
    const res = await deliver(await start(fake.verify), RAW_EVENT, { ...SIGNED_HEADERS, "content-type": "application/json; charset=utf-8" });
    expect(res.statusCode).toBe(200);
    expect(fake.calls[0]?.rawBody).toBe(RAW_EVENT);
  });

  it("answers 400 when PayPal reports FAILURE, and does not remember the event", async () => {
    const fake = fakeVerifier({ verificationStatus: "FAILURE", paypalStatus: "FAILURE" });
    const instance = await start(fake.verify);
    const res = await deliver(instance);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "signature_verification_failed" });
    // A forged copy must never mark the real event id as seen: the next delivery is verified again.
    await deliver(instance);
    expect(fake.calls).toHaveLength(2);
  });

  it("answers 400 without calling PayPal when a transmission header is missing", async () => {
    const fake = fakeVerifier();
    const { "paypal-transmission-sig": _sig, ...unsigned } = SIGNED_HEADERS;
    const res = await deliver(await start(fake.verify), RAW_EVENT, unsigned);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "missing_transmission_headers", missing: ["paypal-transmission-sig"] });
    expect(fake.calls).toHaveLength(0);
  });

  it("answers 400 for a body that is not a PayPal event", async () => {
    const fake = fakeVerifier();
    const instance = await start(fake.verify);
    expect((await deliver(instance, "not json")).statusCode).toBe(400);
    expect((await deliver(instance, '{"event_type":"PAYMENT.CAPTURE.COMPLETED"}')).statusCode).toBe(400);
    expect((await deliver(instance, "")).statusCode).toBe(400);
    expect(fake.calls).toHaveLength(0);
  });

  it("answers 200 to a duplicate without verifying or processing it again", async () => {
    const fake = fakeVerifier();
    const instance = await start(fake.verify);
    expect((await deliver(instance)).statusCode).toBe(200);
    const again = await deliver(instance, RAW_EVENT, { ...SIGNED_HEADERS, "paypal-transmission-id": "7a1c0e40-d67a-11e5-baa3-778b53f4ae55" });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ received: true, duplicate: true, event_id: "WH-58D329510W468432D-8HN650336L201105X" });
    expect(fake.calls).toHaveLength(1);
  });

  it("answers 503 (PayPal retries) when verification is not configured", async () => {
    const res = await deliver(await start(null));
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "webhook_verification_unavailable" });
  });

  it("answers 503 when the PayPal call fails, and verifies the retry", async () => {
    let fail = true;
    const fake = fakeVerifier(() => {
      if (fail) {
        fail = false;
        return Promise.reject(new PayPalApiError({ method: "POST", path: "/v1/notifications/verify-webhook-signature", status: 500, name: "INTERNAL_SERVICE_ERROR", paypalMessage: "x", details: [], debugId: "dbg-500" }));
      }
      return Promise.resolve({ verificationStatus: "SUCCESS", paypalStatus: "SUCCESS", debugId: "dbg-ok" });
    });
    const instance = await start(fake.verify);
    expect((await deliver(instance)).statusCode).toBe(503);
    expect((await deliver(instance)).statusCode).toBe(200);
    expect(fake.calls).toHaveLength(2);
  });

  it("records deliveries for the S3 status route, ids and statuses only", async () => {
    const fake = fakeVerifier();
    const instance = await start(fake.verify, { enableSpikes: true });
    await deliver(instance);
    await deliver(instance, RAW_EVENT, { "content-type": "application/json" });
    const recent = await instance.inject({ method: "GET", url: WEBHOOK_SPIKE_STATUS_PATH });
    const deliveries = (recent.json() as { deliveries: Record<string, unknown>[] }).deliveries;
    expect(deliveries.map((d) => d.outcome)).toEqual(["rejected", "verified"]);
    expect(deliveries[1]).toMatchObject({
      event_id: "WH-58D329510W468432D-8HN650336L201105X",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource_id: "2GG279541U471931P",
      verification_status: "SUCCESS",
      paypal_debug_id: "dbg-verify",
    });
    expect(recent.body).not.toContain("44.00");
    expect(recent.body).not.toContain(SIGNED_HEADERS["paypal-transmission-sig"]);
  });
});

describe("paypalWebhookVerifier", () => {
  it("posts the event to PayPal's verify API with numbers verbatim and maps the answer", async () => {
    const sent: { path: string; body: string; requestId: string | null }[] = [];
    const fetch: FetchLike = (url, init) => {
      const path = new URL(url).pathname;
      if (path === "/v1/oauth2/token") {
        return Promise.resolve(new Response(JSON.stringify({ access_token: "A21AA-test", token_type: "Bearer", expires_in: 32_400 }), { status: 200 }));
      }
      sent.push({ path, body: String(init.body), requestId: new Headers(init.headers).get("paypal-request-id") });
      return Promise.resolve(new Response(JSON.stringify({ verification_status: "SUCCESS" }), { status: 200, headers: { "paypal-debug-id": "dbg-real" } }));
    };
    const http = new PayPalHttp({ config: makePayPalConfig("client-id", "client-secret"), fetch, logger: () => undefined });
    const instance = await start(paypalWebhookVerifier(http, WEBHOOK_ID));
    const res = await deliver(instance);
    expect(res.statusCode).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.path).toBe("/v1/notifications/verify-webhook-signature");
    expect(sent[0]?.requestId).toMatch(/^wh-verify:69cd13f0-d67a-11e5-baa3-778b53f4ae55:[0-9a-f]{24}$/);
    const body = JSON.parse(sent[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body).toMatchObject({ webhook_id: WEBHOOK_ID, transmission_id: SIGNED_HEADERS["paypal-transmission-id"], auth_algo: "SHA256withRSA" });
    expect(body.webhook_event).toEqual(JSON.parse(RAW_EVENT) as unknown);
    expect(sent[0]?.body).toContain('"rate":1.50');
  });
});
