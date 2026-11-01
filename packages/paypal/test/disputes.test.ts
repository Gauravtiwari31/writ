import { describe, expect, it } from "vitest";
import { fromBase64Url } from "@writ/core";
import { PayPalTokenProvider } from "../src/auth";
import { PayPalConfigError, type PayPalConfig } from "../src/config";
import {
  acceptClaim,
  adjudicate,
  buildBuyerAuthAssertion,
  buildProvideEvidenceParts,
  createSandboxDispute,
  disputeActions,
  disputeIdFromLinks,
  encodeMultipart,
  escalateDispute,
  getDispute,
  hasDisputeAction,
  listDisputes,
  PayPalMultipartClient,
  provideEvidence,
  requireEvidence,
  type EvidenceFile,
} from "../src/disputes";
import { PayPalApiError } from "../src/errors";
import type { PayPalHttp } from "../src/http";
import type { PayPalLogEntry } from "../src/transport";
import { ACCESS_TOKEN, bodyOf, CLIENT_ID, fakeFetch, jsonResponse, makeHttp, testConfig, tokenResponse, type Handler } from "./fake";

const DISPUTE_ID = "PP-D-27803";
const BASE = "https://api-m.sandbox.paypal.com/v1/customer/disputes";
const SELF_LINK = { href: `${BASE}/${DISPUTE_ID}`, rel: "self", method: "GET" };

// %PDF header, a line of text, and bytes that are not valid UTF-8, which must pass through untouched.
const PDF_BYTES = new Uint8Array([...new TextEncoder().encode("%PDF-1.4\n%"), 0xe2, 0xe3, 0xcf, 0xd3, 0x0a, 0x00, 0xff, 0x80]);
const PDF: EvidenceFile = { filename: "writ-evidence.pdf", contentType: "application/pdf", data: PDF_BYTES };

function makeMultipart(handler: Handler) {
  const fake = fakeFetch(handler);
  const logs: PayPalLogEntry[] = [];
  const config = testConfig();
  const logger = (entry: PayPalLogEntry): void => {
    logs.push(entry);
  };
  const tokens = new PayPalTokenProvider({ config, fetch: fake.fetch, logger });
  return { client: new PayPalMultipartClient({ config, tokens, fetch: fake.fetch, logger }), logs, ...fake };
}

/** Splits a multipart body into parts: headers (lowercased names) and raw bytes. */
function parseMultipart(body: Uint8Array, contentType: string): { headers: Record<string, string>; data: Uint8Array }[] {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
  if (boundary === undefined) throw new Error("no boundary");
  const text = Buffer.from(body).toString("latin1");
  expect(text.endsWith(`--${boundary}--\r\n`)).toBe(true);
  const sections = text.split(`--${boundary}`).slice(1, -1);
  return sections.map((section) => {
    expect(section.startsWith("\r\n")).toBe(true);
    expect(section.endsWith("\r\n")).toBe(true);
    const inner = section.slice(2, -2);
    const split = inner.indexOf("\r\n\r\n");
    const headers: Record<string, string> = {};
    for (const line of inner.slice(0, split).split("\r\n")) {
      const colon = line.indexOf(":");
      headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
    }
    return { headers, data: new Uint8Array(Buffer.from(inner.slice(split + 4), "latin1")) };
  });
}

function sentBody(init: RequestInit): Uint8Array {
  expect(init.body).toBeInstanceOf(Uint8Array);
  return init.body as Uint8Array;
}

describe("encodeMultipart", () => {
  it("writes a JSON part without filename and a file part with filename, bytes unchanged", () => {
    const encoded = encodeMultipart(
      [
        { name: "input", contentType: "application/json", data: '{"evidences":[]}' },
        { name: "file1", filename: "writ-evidence.pdf", contentType: "application/pdf", data: PDF_BYTES },
      ],
      "----writ-test",
    );
    expect(encoded.contentType).toBe("multipart/form-data; boundary=----writ-test");
    const text = Buffer.from(encoded.body).toString("latin1");
    expect(text.startsWith('------writ-test\r\nContent-Disposition: form-data; name="input"\r\nContent-Type: application/json\r\n\r\n{"evidences":[]}\r\n')).toBe(true);
    const parts = parseMultipart(encoded.body, encoded.contentType);
    expect(parts).toHaveLength(2);
    expect(parts[0]?.headers["content-disposition"]).toBe('form-data; name="input"');
    expect(parts[1]?.headers["content-disposition"]).toBe('form-data; name="file1"; filename="writ-evidence.pdf"');
    expect(parts[1]?.headers["content-type"]).toBe("application/pdf");
    expect([...(parts[1]?.data ?? [])]).toEqual([...PDF_BYTES]);
  });

  it("uses a fresh random boundary per body", () => {
    const parts = [{ name: "input", contentType: "application/json", data: "{}" }];
    expect(encodeMultipart(parts).boundary).not.toBe(encodeMultipart(parts).boundary);
  });

  it("refuses header injection and data containing the boundary", () => {
    expect(() => encodeMultipart([{ name: 'in"put', contentType: "application/json", data: "{}" }])).toThrow(TypeError);
    expect(() => encodeMultipart([{ name: "file1", filename: "a\r\nb.pdf", contentType: "application/pdf", data: "x" }])).toThrow(TypeError);
    expect(() => encodeMultipart([{ name: "input", contentType: "application/json", data: "x--b1y" }], "b1")).toThrow(/boundary/);
    expect(() => encodeMultipart([])).toThrow(TypeError);
  });
});

describe("buildProvideEvidenceParts", () => {
  it("puts the evidences in the input part and names files file1..fileN", () => {
    const parts = buildProvideEvidenceParts({
      evidences: [
        { evidenceType: "OTHER", notes: '{"writ_evidence":{"capture_id":"2GG279541U471931P"}}' },
        { evidenceType: "PROOF_OF_FULFILLMENT", evidenceInfo: { tracking_info: [{ carrier_name: "OTHER", tracking_number: "SIM-1" }] } },
      ],
      files: [PDF, { filename: "receipt.png", contentType: "image/png", data: new Uint8Array([0x89, 0x50]) }],
    });
    expect(parts.map((p) => [p.name, p.filename, p.contentType])).toEqual([
      ["input", undefined, "application/json"],
      ["file1", "writ-evidence.pdf", "application/pdf"],
      ["file2", "receipt.png", "image/png"],
    ]);
    expect(JSON.parse(String(parts[0]?.data))).toEqual({
      evidences: [
        { evidence_type: "OTHER", notes: '{"writ_evidence":{"capture_id":"2GG279541U471931P"}}' },
        { evidence_type: "PROOF_OF_FULFILLMENT", evidence_info: { tracking_info: [{ carrier_name: "OTHER", tracking_number: "SIM-1" }] } },
      ],
    });
  });

  it("enforces PayPal's evidence rules", () => {
    const ok = { evidenceType: "OTHER", notes: "n" };
    expect(() => buildProvideEvidenceParts({ evidences: [] })).toThrow(RangeError);
    expect(() => buildProvideEvidenceParts({ evidences: [{ evidenceType: "other" }] })).toThrow(TypeError);
    expect(() => buildProvideEvidenceParts({ evidences: [{ evidenceType: "OTHER", notes: "x".repeat(2001) }] })).toThrow(/2000/);
    expect(() => buildProvideEvidenceParts({ evidences: [ok], files: [{ ...PDF, filename: "evidence.exe" }] })).toThrow(/extension/);
    expect(() => buildProvideEvidenceParts({ evidences: [ok], files: [{ ...PDF, filename: "../evidence.pdf" }] })).toThrow(TypeError);
    expect(() => buildProvideEvidenceParts({ evidences: [ok], files: [{ ...PDF, data: new Uint8Array(0) }] })).toThrow(/empty/);
    expect(() => buildProvideEvidenceParts({ evidences: [ok], files: [{ ...PDF, data: new Uint8Array(10 * 1024 * 1024) }] })).toThrow(/10 MB/);
    const nine = { ...PDF, data: new Uint8Array(9 * 1024 * 1024) };
    expect(() => buildProvideEvidenceParts({ evidences: [ok], files: [nine, nine, nine, nine, nine, nine] })).toThrow(/50 MB/);
  });
});

describe("provideEvidence", () => {
  it("POSTs multipart with bearer token, PayPal-Request-Id and no JSON content type", async () => {
    let init: RequestInit | undefined;
    const { client, apiCalls, logs } = makeMultipart((_call, i) => {
      init = i;
      return jsonResponse(200, { links: [SELF_LINK] }, "dbg-evidence");
    });
    const response = await provideEvidence(client, {
      disputeId: DISPUTE_ID,
      evidences: [{ evidenceType: "OTHER", notes: "Signed Writ evidence (sandbox)" }],
      files: [PDF],
      requestId: `${DISPUTE_ID}:provide-evidence:1`,
    });
    expect(response.status).toBe(200);
    expect(response.debugId).toBe("dbg-evidence");

    const call = apiCalls()[0];
    expect(call?.method).toBe("POST");
    expect(call?.path).toBe(`/v1/customer/disputes/${DISPUTE_ID}/provide-evidence`);
    expect(call?.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(call?.headers["paypal-request-id"]).toBe(`${DISPUTE_ID}:provide-evidence:1`);
    expect(call?.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=----writ-[0-9a-f]{24}$/);
    if (init === undefined) throw new Error("no request");
    const parts = parseMultipart(sentBody(init), call?.headers["content-type"] ?? "");
    expect(parts.map((p) => p.headers["content-disposition"])).toEqual(['form-data; name="input"', 'form-data; name="file1"; filename="writ-evidence.pdf"']);
    expect(JSON.parse(new TextDecoder().decode(parts[0]?.data))).toEqual({ evidences: [{ evidence_type: "OTHER", notes: "Signed Writ evidence (sandbox)" }] });
    expect([...(parts[1]?.data ?? [])]).toEqual([...PDF_BYTES]);
    expect(logs.find((l) => l.path.endsWith("/provide-evidence"))).toMatchObject({ debugId: "dbg-evidence", requestId: `${DISPUTE_ID}:provide-evidence:1`, outcome: "ok" });
  });

  it("retries once with a fresh token after 401, keeping the request id and body", async () => {
    let tokenCalls = 0;
    const bodies: Uint8Array[] = [];
    const fake = fakeFetch(
      (call, init) => {
        if (call.path === "/v1/oauth2/token") {
          tokenCalls += 1;
          return tokenResponse(`token-${tokenCalls}`);
        }
        bodies.push(sentBody(init));
        return call.headers.authorization === "Bearer token-1" ? jsonResponse(401, { error: "invalid_token" }) : jsonResponse(200, { links: [SELF_LINK] });
      },
      { autoToken: false },
    );
    const config = testConfig();
    const logger = (): void => undefined;
    const client = new PayPalMultipartClient({ config, tokens: new PayPalTokenProvider({ config, fetch: fake.fetch, logger }), fetch: fake.fetch, logger });
    await provideEvidence(client, { disputeId: DISPUTE_ID, evidences: [{ evidenceType: "OTHER", notes: "n" }], requestId: "r-1" });
    const api = fake.apiCalls();
    expect(api.map((c) => c.headers.authorization)).toEqual(["Bearer token-1", "Bearer token-2"]);
    expect(api.map((c) => c.headers["paypal-request-id"])).toEqual(["r-1", "r-1"]);
    expect(Buffer.from(bodies[1] ?? []).equals(Buffer.from(bodies[0] ?? []))).toBe(true);
  });

  it("surfaces PayPal's error with its debug id", async () => {
    const { client } = makeMultipart(() =>
      jsonResponse(422, { name: "UNPROCESSABLE_ENTITY", message: "The requested action could not be performed.", details: [{ issue: "ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE" }] }, "dbg-422"),
    );
    const error = await provideEvidence(client, { disputeId: DISPUTE_ID, evidences: [{ evidenceType: "OTHER", notes: "n" }], requestId: "r" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayPalApiError);
    expect((error as PayPalApiError).hasIssue("ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE")).toBe(true);
    expect((error as PayPalApiError).debugId).toBe("dbg-422");
  });
});

describe("reading disputes", () => {
  const DISPUTE = {
    dispute_id: DISPUTE_ID,
    status: "UNDER_REVIEW",
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    dispute_life_cycle_stage: "INQUIRY",
    dispute_amount: { currency_code: "USD", value: "44.00" },
    disputed_transactions: [{ seller_transaction_id: "2GG279541U471931P" }],
    links: [
      SELF_LINK,
      { href: `${BASE}/${DISPUTE_ID}/send-message`, rel: "send_message", method: "POST" },
      { href: `${BASE}/${DISPUTE_ID}/require-evidence`, rel: "require_evidence", method: "POST" },
      { href: `${BASE}/${DISPUTE_ID}/adjudicate`, rel: "adjudicate", method: "POST" },
      { href: `${BASE}/${DISPUTE_ID}/accept-claim`, rel: "accept_claim" },
      { href: "not a url", rel: "provide_evidence", method: "POST" },
      { href: `${BASE}/${DISPUTE_ID}/evidences`, rel: "evidences", method: "GET" },
    ],
  };

  it("exposes the available actions from the HATEOAS links", async () => {
    const { http, apiCalls } = makeHttp(() => jsonResponse(200, DISPUTE, "dbg-get"));
    const view = await getDispute(http, DISPUTE_ID);
    expect(apiCalls()[0]?.path).toBe(`/v1/customer/disputes/${DISPUTE_ID}`);
    expect(view.debugId).toBe("dbg-get");
    expect(view.actions).toEqual(["send-message", "require-evidence", "adjudicate", "accept-claim", "provide-evidence"]);
    expect(hasDisputeAction(view.dispute, "adjudicate")).toBe(true);
    expect(hasDisputeAction(view.dispute, "escalate")).toBe(false);
    expect(disputeActions(undefined)).toEqual([]);
  });

  it("lists disputes by disputed transaction id", async () => {
    const { http, apiCalls } = makeHttp(() => jsonResponse(200, { items: [DISPUTE], links: [] }));
    const list = await listDisputes(http, { disputedTransactionId: "2GG279541U471931P", pageSize: 5 });
    expect(list.data.items?.[0]?.dispute_id).toBe(DISPUTE_ID);
    expect(apiCalls()[0]?.search).toBe("?disputed_transaction_id=2GG279541U471931P&page_size=5");
  });

  it("reads the dispute id from a self link", () => {
    expect(disputeIdFromLinks([{ href: `${BASE}/PP-R-TOW-10161582`, rel: "self", method: "GET" }])).toBe("PP-R-TOW-10161582");
    expect(disputeIdFromLinks([])).toBeNull();
    expect(disputeIdFromLinks([{ href: "https://api-m.sandbox.paypal.com/v2/checkout/orders/1", rel: "self" }])).toBeNull();
  });
});

describe("accept-claim", () => {
  it("posts JSON with a note and a replayable request id", async () => {
    const { http, apiCalls } = makeHttp(() => jsonResponse(200, { links: [SELF_LINK] }));
    await acceptClaim(http, { disputeId: DISPUTE_ID, note: "Platform error: full refund.", acceptClaimType: "REFUND" });
    const call = apiCalls()[0];
    expect(call?.path).toBe(`/v1/customer/disputes/${DISPUTE_ID}/accept-claim`);
    expect(call?.headers["content-type"]).toBe("application/json");
    expect(call?.headers["paypal-request-id"]).toBe(`${DISPUTE_ID}:accept-claim`);
    expect(bodyOf(call)).toEqual({ note: "Platform error: full refund.", accept_claim_type: "REFUND" });
  });
});

describe("escalate", () => {
  it("posts the merchant note as JSON with a replayable request id", async () => {
    const { http, apiCalls } = makeHttp(() => jsonResponse(200, { links: [SELF_LINK] }));
    const res = await escalateDispute(http, { disputeId: DISPUTE_ID, note: "Escalating to a claim for review." });
    expect(res.status).toBe(200);
    const call = apiCalls()[0];
    expect(call?.method).toBe("POST");
    expect(call?.path).toBe(`/v1/customer/disputes/${DISPUTE_ID}/escalate`);
    expect(call?.headers["paypal-request-id"]).toBe(`${DISPUTE_ID}:escalate`);
    expect(bodyOf(call)).toEqual({ note: "Escalating to a claim for review." });
  });

  it("refuses an empty or over-long note before any call", () => {
    const { http, calls } = makeHttp(() => jsonResponse(200, {}));
    expect(() => escalateDispute(http, { disputeId: DISPUTE_ID, note: " " })).toThrow(TypeError);
    expect(() => escalateDispute(http, { disputeId: DISPUTE_ID, note: "n".repeat(2001) })).toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });
});

describe("sandbox-only simulation", () => {
  it("builds the buyer PayPal-Auth-Assertion as an unsigned JWT", () => {
    const token = buildBuyerAuthAssertion(CLIENT_ID, "buyer@personal.example.com");
    const [header, payload, signature] = token.split(".");
    expect(signature).toBe("");
    const decode = (part: string | undefined): unknown => JSON.parse(new TextDecoder().decode(fromBase64Url(part ?? "")));
    expect(decode(header)).toEqual({ alg: "none", typ: "JWT" });
    expect(decode(payload)).toEqual({ iss: CLIENT_ID, email: "buyer@personal.example.com" });
    expect(() => buildBuyerAuthAssertion(CLIENT_ID, "not-an-email")).toThrow(TypeError);
  });

  it("creates a dispute as the buyer: multipart input part + PayPal-Auth-Assertion", async () => {
    let init: RequestInit | undefined;
    const { client, apiCalls } = makeMultipart((_call, i) => {
      init = i;
      return jsonResponse(201, { links: [{ href: `${BASE}/PP-D-99001`, rel: "self", method: "GET" }] }, "dbg-create");
    });
    const created = await createSandboxDispute(client, {
      buyerEmail: "buyer@personal.example.com",
      transaction: { buyerTransactionId: "2NJ45340EV624100G" },
      reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      amountMinor: 4400n,
      currency: "USD",
      requestId: "s2-create:1",
    });
    expect(created.disputeId).toBe("PP-D-99001");
    expect(created.debugId).toBe("dbg-create");
    const call = apiCalls()[0];
    expect(call?.path).toBe("/v1/customer/disputes");
    expect(call?.headers["paypal-auth-assertion"]).toBe(buildBuyerAuthAssertion(CLIENT_ID, "buyer@personal.example.com"));
    expect(call?.headers["paypal-request-id"]).toBe("s2-create:1");
    if (init === undefined) throw new Error("no request");
    const parts = parseMultipart(sentBody(init), call?.headers["content-type"] ?? "");
    expect(parts).toHaveLength(1);
    expect(parts[0]?.headers["content-disposition"]).toBe('form-data; name="input"');
    expect(JSON.parse(new TextDecoder().decode(parts[0]?.data))).toEqual({
      disputed_transactions: [{ buyer_transaction_id: "2NJ45340EV624100G" }],
      reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      dispute_amount: { currency_code: "USD", value: "44.00" },
      extensions: { merchant_contacted: true, merchant_contacted_outcome: "NO_RESPONSE", merchandize_dispute_properties: { issue_type: "PRODUCT" } },
    });
  });

  it("posts require-evidence and adjudicate with their documented bodies", async () => {
    const { http, apiCalls } = makeHttp(() => jsonResponse(200, { links: [SELF_LINK] }));
    await requireEvidence(http, { disputeId: DISPUTE_ID, action: "SELLER_EVIDENCE" });
    await adjudicate(http, { disputeId: DISPUTE_ID, outcome: "SELLER_FAVOR" });
    const [req, adj] = apiCalls();
    expect(req?.path).toBe(`/v1/customer/disputes/${DISPUTE_ID}/require-evidence`);
    expect(bodyOf(req)).toEqual({ action: "SELLER_EVIDENCE" });
    expect(req?.headers["paypal-request-id"]).toBe(`${DISPUTE_ID}:require-evidence:SELLER_EVIDENCE`);
    expect(adj?.path).toBe(`/v1/customer/disputes/${DISPUTE_ID}/adjudicate`);
    expect(bodyOf(adj)).toEqual({ adjudication_outcome: "SELLER_FAVOR" });
    expect(adj?.headers["paypal-request-id"]).toBe(`${DISPUTE_ID}:adjudicate:SELLER_FAVOR`);
  });

  it("refuses to run any sandbox-only call outside the sandbox, before any request", async () => {
    // A hand-built config pointing at live PayPal; the real constructors would already refuse it.
    const live = { env: "live", baseUrl: "https://api-m.paypal.com", clientId: CLIENT_ID, clientSecret: "s" } as unknown as PayPalConfig;
    let posted = 0;
    const liveHttp = {
      config: live,
      post: () => {
        posted += 1;
        return Promise.resolve({ status: 200, data: {}, debugId: null });
      },
    } as unknown as PayPalHttp;
    const liveMultipart = Object.create(PayPalMultipartClient.prototype, { config: { value: live } }) as PayPalMultipartClient;

    expect(() => requireEvidence(liveHttp, { disputeId: DISPUTE_ID, action: "SELLER_EVIDENCE" })).toThrow(PayPalConfigError);
    expect(() => adjudicate(liveHttp, { disputeId: DISPUTE_ID, outcome: "SELLER_FAVOR" })).toThrow(/sandbox-only/);
    await expect(
      createSandboxDispute(liveMultipart, {
        buyerEmail: "buyer@personal.example.com",
        transaction: { buyerTransactionId: "2NJ45340EV624100G" },
        reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
        amountMinor: 100n,
        currency: "USD",
        requestId: "r",
      }),
    ).rejects.toThrow(PayPalConfigError);
    expect(posted).toBe(0);
    expect(() => new PayPalMultipartClient({ config: live, tokens: { getAccessToken: () => Promise.resolve("t"), invalidate: () => undefined } })).toThrow(PayPalConfigError);
  });
});
