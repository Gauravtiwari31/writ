import { describe, expect, it } from "vitest";
import { PayPalApiError } from "../src/errors";
import {
  buildCreateWebhookRequest,
  buildSimulateEventRequest,
  buildVerifyWebhookSignatureRequest,
  createWebhook,
  extractTransmissionHeaders,
  listWebhookEvents,
  listWebhooks,
  missingTransmissionHeaders,
  parseJsonVerbatim,
  parseWebhookEvent,
  resendWebhookEvent,
  simulateEvent,
  verifyRequestId,
  verifyWebhookSignature,
  webhookResourceId,
  WRIT_WEBHOOK_EVENT_TYPES,
  type TransmissionHeaders,
} from "../src/webhooks";
import { bodyOf, jsonResponse, makeHttp } from "./fake";

const WEBHOOK_ID = "8PT597110X687430LKGECATA";

const HEADERS = {
  "PAYPAL-AUTH-ALGO": "SHA256withRSA",
  "Paypal-Cert-Url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77",
  "paypal-transmission-id": "69cd13f0-d67a-11e5-baa3-778b53f4ae55",
  "paypal-transmission-sig": "lmI95Jx3Y9nhR5SJWlHVIWpg4AgFk7n9bCHSRxbrd8A9zrhdu2rMyFrmz+Zjh3s3boXB07VXCXUZy/UFzUlnGJn0wDugt7FlSvdKeIJenLRemUxYCPVoEZzg9VFNqOa48gMkvF+XTpxBeUx/kWy6B5cp7GkT2+pOowfRK7OGynuxUoKW3JcMWw272VKjLTtTAShncla7tGF+55rxyt2KNZIIqxNMJ48RDZheGU5w1npu9dZHnPgTXB9iomeVRoD8O/jhRpnKsGrDschyNdkeh81BJJMH4Ctc6lnCCquoP/GzCzz33MMsNdid7vL/NIWaCsekQpW26FpWPi/tfj8nLA==",
  "paypal-transmission-time": "2026-11-01T09:22:15Z",
};

const TRANSMISSION: TransmissionHeaders = {
  authAlgo: "SHA256withRSA",
  certUrl: HEADERS["Paypal-Cert-Url"],
  transmissionId: HEADERS["paypal-transmission-id"],
  transmissionSig: HEADERS["paypal-transmission-sig"],
  transmissionTime: HEADERS["paypal-transmission-time"],
};

// Formatted the way PayPal sends it, with a number whose text a plain parse/stringify would change.
const RAW_EVENT = `{"id":"WH-58D329510W468432D-8HN650336L201105X","event_version":"1.0","create_time":"2026-11-01T09:22:14.000Z","resource_type":"capture","resource_version":"2.0","event_type":"PAYMENT.CAPTURE.COMPLETED","summary":"Payment completed for $ 44.00 USD","resource":{"id":"2GG279541U471931P","status":"COMPLETED","amount":{"currency_code":"USD","value":"44.00"},"final_capture":true,"seller_receivable_breakdown":{"exchange_rate":1.50,"big":12345678901234567890}},"links":[{"href":"https://api.sandbox.paypal.com/v1/notifications/webhooks-events/WH-58D329510W468432D-8HN650336L201105X","rel":"self","method":"GET"}]}`;

describe("extractTransmissionHeaders", () => {
  it("reads all five headers case-insensitively from a header record", () => {
    expect(extractTransmissionHeaders(HEADERS)).toEqual(TRANSMISSION);
  });

  it("reads a fetch Headers object", () => {
    expect(extractTransmissionHeaders(new Headers(HEADERS))).toEqual(TRANSMISSION);
  });

  it("returns null and names the header when one is missing, so callers fail closed", () => {
    const { "paypal-transmission-sig": _sig, ...rest } = HEADERS;
    expect(extractTransmissionHeaders(rest)).toBeNull();
    expect(missingTransmissionHeaders(rest)).toEqual(["paypal-transmission-sig"]);
  });

  it("treats empty, whitespace-only, repeated and over-long values as missing", () => {
    expect(extractTransmissionHeaders({ ...HEADERS, "paypal-transmission-id": "  " })).toBeNull();
    expect(extractTransmissionHeaders({ ...HEADERS, "paypal-transmission-id": ["a", "b"] })).toBeNull();
    expect(extractTransmissionHeaders({ ...HEADERS, "PAYPAL-AUTH-ALGO": undefined, "paypal-auth-algo": undefined })).toBeNull();
    expect(missingTransmissionHeaders({ ...HEADERS, "paypal-transmission-id": "x".repeat(51) })).toEqual(["paypal-transmission-id"]);
  });

  it("returns null for an empty header set", () => {
    expect(extractTransmissionHeaders({})).toBeNull();
    expect(missingTransmissionHeaders(new Headers())).toHaveLength(5);
  });
});

describe("parseWebhookEvent", () => {
  it("validates the event and keeps a verbatim copy for postback", () => {
    const parsed = parseWebhookEvent(RAW_EVENT);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.event.id).toBe("WH-58D329510W468432D-8HN650336L201105X");
    expect(parsed.value.event.event_type).toBe("PAYMENT.CAPTURE.COMPLETED");
    expect(webhookResourceId(parsed.value.event)).toBe("2GG279541U471931P");
    // Re-serializing the verbatim copy reproduces the body byte for byte (it was compact JSON).
    expect(JSON.stringify(parsed.value.verbatim)).toBe(RAW_EVENT);
  });

  it("keeps number text that a plain JSON round-trip would change", () => {
    expect(JSON.stringify(JSON.parse('{"a":1.50}'))).toBe('{"a":1.5}');
    expect(JSON.stringify(parseJsonVerbatim('{"a":1.50,"b":[1e2,-0.0],"c":"1.50"}'))).toBe('{"a":1.50,"b":[1e2,-0.0],"c":"1.50"}');
  });

  it("reads the dispute id of dispute events", () => {
    const parsed = parseWebhookEvent('{"id":"WH-1","event_type":"CUSTOMER.DISPUTE.RESOLVED","resource":{"dispute_id":"PP-D-27803","status":"RESOLVED"}}');
    if (!parsed.ok) throw new Error(parsed.error);
    expect(webhookResourceId(parsed.value.event)).toBe("PP-D-27803");
  });

  it("rejects invalid JSON and events without id or event_type", () => {
    expect(parseWebhookEvent("not json")).toEqual({ ok: false, error: "body is not valid JSON" });
    expect(parseWebhookEvent("")).toMatchObject({ ok: false });
    const missing = parseWebhookEvent('{"event_type":"PAYMENT.CAPTURE.COMPLETED"}');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("id");
    expect(parseWebhookEvent('{"id":"WH-1","event_type":""}').ok).toBe(false);
    expect(parseWebhookEvent("[]").ok).toBe(false);
  });
});

describe("verifyWebhookSignature", () => {
  it("posts every transmission field, the webhook id and the event exactly as received", async () => {
    const { http, apiCalls } = makeHttp(() => jsonResponse(200, { verification_status: "SUCCESS" }, "dbg-verify"));
    const result = await verifyWebhookSignature(http, { webhookId: WEBHOOK_ID, headers: TRANSMISSION, event: RAW_EVENT });
    expect(result).toEqual({ verificationStatus: "SUCCESS", paypalStatus: "SUCCESS", debugId: "dbg-verify" });

    const call = apiCalls()[0];
    expect(call?.method).toBe("POST");
    expect(call?.path).toBe("/v1/notifications/verify-webhook-signature");
    expect(call?.headers["content-type"]).toBe("application/json");
    expect(bodyOf(call)).toEqual({
      auth_algo: TRANSMISSION.authAlgo,
      cert_url: TRANSMISSION.certUrl,
      transmission_id: TRANSMISSION.transmissionId,
      transmission_sig: TRANSMISSION.transmissionSig,
      transmission_time: TRANSMISSION.transmissionTime,
      webhook_id: WEBHOOK_ID,
      webhook_event: JSON.parse(RAW_EVENT) as unknown,
    });
    // The event is spliced in with its original number text, not re-formatted.
    expect(call?.body).toContain(`"webhook_event":${RAW_EVENT}`);
    expect(call?.body).toContain('"exchange_rate":1.50');
    expect(call?.body).toContain('"big":12345678901234567890');
  });

  it("accepts the verbatim copy from parseWebhookEvent the same way as the raw string", () => {
    const parsed = parseWebhookEvent(RAW_EVENT);
    if (!parsed.ok) throw new Error(parsed.error);
    const fromVerbatim = buildVerifyWebhookSignatureRequest({ webhookId: WEBHOOK_ID, headers: TRANSMISSION, event: parsed.value.verbatim });
    const fromRaw = buildVerifyWebhookSignatureRequest({ webhookId: WEBHOOK_ID, headers: TRANSMISSION, event: RAW_EVENT });
    expect(JSON.stringify(fromVerbatim)).toBe(JSON.stringify(fromRaw));
  });

  it("sends a PayPal-Request-Id derived from the transmission id and the request content", async () => {
    const { http, apiCalls } = makeHttp(() => jsonResponse(200, { verification_status: "SUCCESS" }));
    await verifyWebhookSignature(http, { webhookId: WEBHOOK_ID, headers: TRANSMISSION, event: RAW_EVENT });
    await verifyWebhookSignature(http, { webhookId: WEBHOOK_ID, headers: TRANSMISSION, event: RAW_EVENT });
    await verifyWebhookSignature(http, { webhookId: WEBHOOK_ID, headers: TRANSMISSION, event: RAW_EVENT.replace("44.00", "4400.00") });
    const ids = apiCalls().map((c) => c.headers["paypal-request-id"]);
    expect(ids[0]).toMatch(/^wh-verify:69cd13f0-d67a-11e5-baa3-778b53f4ae55:[0-9a-f]{24}$/);
    // Same transmission + same body replays; a forged body under a known transmission id never does.
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(ids[2]?.startsWith("wh-verify:69cd13f0-d67a-11e5-baa3-778b53f4ae55:")).toBe(true);
  });

  it("does not put an odd transmission id into the request id", () => {
    const body = buildVerifyWebhookSignatureRequest({ webhookId: WEBHOOK_ID, headers: { ...TRANSMISSION, transmissionId: "a b\"c" }, event: RAW_EVENT });
    expect(verifyRequestId(body)).toMatch(/^wh-verify:x:[0-9a-f]{24}$/);
  });

  it("maps FAILURE, and any status other than SUCCESS, to FAILURE", async () => {
    for (const status of ["FAILURE", "success", "PENDING", ""]) {
      const { http } = makeHttp(() => jsonResponse(200, { verification_status: status }));
      const result = await verifyWebhookSignature(http, { webhookId: WEBHOOK_ID, headers: TRANSMISSION, event: RAW_EVENT });
      expect(result.verificationStatus).toBe("FAILURE");
      expect(result.paypalStatus).toBe(status);
    }
  });

  it("throws on a PayPal error so the caller can answer non-2xx and PayPal retries", async () => {
    const { http } = makeHttp(() =>
      jsonResponse(400, { name: "VALIDATION_ERROR", message: "Invalid request", details: [{ field: "webhook_id", issue: "INVALID_RESOURCE_ID" }] }, "dbg-bad"),
    );
    const error = await verifyWebhookSignature(http, { webhookId: WEBHOOK_ID, headers: TRANSMISSION, event: RAW_EVENT }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayPalApiError);
    expect((error as PayPalApiError).debugId).toBe("dbg-bad");
  });

  it("rejects a malformed webhook id before calling PayPal", async () => {
    const { http, apiCalls } = makeHttp(() => jsonResponse(200, { verification_status: "SUCCESS" }));
    await expect(verifyWebhookSignature(http, { webhookId: "WH id!", headers: TRANSMISSION, event: RAW_EVENT })).rejects.toThrow(TypeError);
    expect(apiCalls()).toHaveLength(0);
  });
});

describe("webhook management", () => {
  it("creates a webhook with the plan §7 events and a deterministic request id", async () => {
    const { http, apiCalls } = makeHttp((call) => jsonResponse(201, { id: "0EH40505U7160970P", ...(bodyOf(call) as object) }));
    const url = "https://writ-gateway.onrender.com/v1/webhooks/paypal";
    const created = await createWebhook(http, { url, eventTypes: WRIT_WEBHOOK_EVENT_TYPES });
    expect(created.data.id).toBe("0EH40505U7160970P");
    const call = apiCalls()[0];
    expect(call?.path).toBe("/v1/notifications/webhooks");
    expect(bodyOf(call)).toEqual({ url, event_types: WRIT_WEBHOOK_EVENT_TYPES.map((name) => ({ name })) });
    await createWebhook(http, { url, eventTypes: WRIT_WEBHOOK_EVENT_TYPES });
    expect(apiCalls()[1]?.headers["paypal-request-id"]).toBe(call?.headers["paypal-request-id"]);
    expect(call?.headers["paypal-request-id"]).toMatch(/^wh-create:[0-9a-f]{40}$/);
  });

  it("subscribes to the dispute, capture, authorization and vault events", () => {
    for (const name of ["CUSTOMER.DISPUTE.CREATED", "CUSTOMER.DISPUTE.UPDATED", "CUSTOMER.DISPUTE.RESOLVED", "PAYMENT.CAPTURE.COMPLETED", "PAYMENT.AUTHORIZATION.VOIDED", "VAULT.PAYMENT-TOKEN.CREATED"]) {
      expect(WRIT_WEBHOOK_EVENT_TYPES).toContain(name);
    }
  });

  it("refuses non-https listener URLs and empty subscriptions", () => {
    expect(() => buildCreateWebhookRequest({ url: "http://writ.example/hook", eventTypes: ["PAYMENT.CAPTURE.COMPLETED"] })).toThrow(/https/);
    expect(() => buildCreateWebhookRequest({ url: "not a url", eventTypes: ["PAYMENT.CAPTURE.COMPLETED"] })).toThrow(TypeError);
    expect(() => buildCreateWebhookRequest({ url: "https://writ.example/hook", eventTypes: [] })).toThrow(TypeError);
  });

  it("lists webhooks and events", async () => {
    const { http, apiCalls } = makeHttp((call) =>
      call.path === "/v1/notifications/webhooks"
        ? jsonResponse(200, { webhooks: [{ id: "0EH40505U7160970P", url: "https://writ.example/hook", event_types: [{ name: "*" }] }] })
        : jsonResponse(200, { events: [JSON.parse(RAW_EVENT) as unknown], count: 1 }),
    );
    expect((await listWebhooks(http)).data.webhooks?.[0]?.id).toBe("0EH40505U7160970P");
    const events = await listWebhookEvents(http, { pageSize: 5, eventType: "PAYMENT.CAPTURE.COMPLETED" });
    expect(events.data.events?.[0]?.event_type).toBe("PAYMENT.CAPTURE.COMPLETED");
    expect(apiCalls()[1]?.search).toBe("?page_size=5&event_type=PAYMENT.CAPTURE.COMPLETED");
  });

  it("resends a real event to the given webhook", async () => {
    const { http, apiCalls } = makeHttp(() => jsonResponse(202, JSON.parse(RAW_EVENT) as unknown));
    await resendWebhookEvent(http, { eventId: "WH-58D329510W468432D-8HN650336L201105X", webhookIds: [WEBHOOK_ID], requestId: "wh-resend:1" });
    const call = apiCalls()[0];
    expect(call?.path).toBe("/v1/notifications/webhooks-events/WH-58D329510W468432D-8HN650336L201105X/resend");
    expect(bodyOf(call)).toEqual({ webhook_ids: [WEBHOOK_ID] });
    expect(call?.headers["paypal-request-id"]).toBe("wh-resend:1");
  });

  it("simulates an event for exactly one of webhook id or url", async () => {
    const { http, apiCalls } = makeHttp(() => jsonResponse(202, { id: "WH-MOCK-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "MOCK" } }));
    const response = await simulateEvent(http, { eventType: "PAYMENT.CAPTURE.COMPLETED", webhookId: WEBHOOK_ID, requestId: "wh-simulate:1" });
    expect(response.data.id).toBe("WH-MOCK-1");
    expect(bodyOf(apiCalls()[0])).toEqual({ webhook_id: WEBHOOK_ID, event_type: "PAYMENT.CAPTURE.COMPLETED" });
    expect(() => buildSimulateEventRequest({ eventType: "PAYMENT.CAPTURE.COMPLETED" })).toThrow(/exactly one/);
    expect(() => buildSimulateEventRequest({ eventType: "PAYMENT.CAPTURE.COMPLETED", webhookId: WEBHOOK_ID, url: "https://writ.example/hook" })).toThrow(/exactly one/);
    expect(buildSimulateEventRequest({ eventType: "CUSTOMER.DISPUTE.CREATED", url: "https://writ.example/hook", resourceVersion: "1.0" })).toEqual({
      url: "https://writ.example/hook",
      event_type: "CUSTOMER.DISPUTE.CREATED",
      resource_version: "1.0",
    });
  });
});
