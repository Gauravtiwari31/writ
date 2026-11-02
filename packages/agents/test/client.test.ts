// AgentApiClient against a fetch fake: auth header, Idempotency-Key, contract parsing, a 403 policy
// BLOCK as a typed answer, and typed errors.
import { newId } from "@writ/core";
import type { CheckoutResponse } from "@writ/core/api";
import { describe, expect, it } from "vitest";
import { AgentApiClient, AgentApiError, type FetchLike } from "../src/index";

const KEY = `wak_${"k".repeat(43)}`;

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(status: number, body: unknown): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  };
  return { fetch, calls };
}

function blocked(): CheckoutResponse {
  return {
    purchase_id: newId("pur"),
    status: "BLOCKED",
    state_reason: "policy_blocked",
    verdict: "BLOCK",
    reasons: [{ stage: "policy", code: "KIND_DENIED", message: "Protection plans are not allowed by this Writ." }],
    policy_reasons: [],
    amount_minor: "8500",
    paypal: { order_id: null, authorization_id: null, capture_id: null },
    approval: null,
    money_moved: false,
    receipt_path: "/receipts/pur_x",
    replayed: false,
  };
}

describe("AgentApiClient", () => {
  it("sends the bearer key and the Idempotency-Key, and returns a 403 BLOCK as a typed answer", async () => {
    const { fetch, calls } = fakeFetch(403, blocked());
    const client = new AgentApiClient({ baseUrl: "http://127.0.0.1:10000/ignored/path", apiKey: KEY, fetch });
    const cartId = newId("crt");
    const outcome = await client.checkout({ cart_id: cartId }, "run-1:checkout:1");
    expect(outcome.httpStatus).toBe(403);
    expect(outcome.result.money_moved).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:10000/v1/agent/checkout");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(headers["idempotency-key"]).toBe("run-1:checkout:1");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ cart_id: cartId });
  });

  it("refuses a malformed Idempotency-Key before sending anything", async () => {
    const { fetch, calls } = fakeFetch(200, {});
    const client = new AgentApiClient({ baseUrl: "http://127.0.0.1:10000", apiKey: KEY, fetch });
    await expect(client.checkout({ cart_id: newId("crt") }, "has space")).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("maps error envelopes and contract drift to AgentApiError", async () => {
    const unauthorized = new AgentApiClient({ baseUrl: "http://gw.test", apiKey: KEY, fetch: fakeFetch(401, { error: "unauthorized", message: "bad key" }).fetch });
    await expect(unauthorized.listWrits()).rejects.toMatchObject({ name: "AgentApiError", status: 401, code: "unauthorized" });
    const drift = new AgentApiClient({ baseUrl: "http://gw.test", apiKey: KEY, fetch: fakeFetch(200, { writs: "nope" }).fetch });
    await expect(drift.listWrits()).rejects.toMatchObject({ code: "invalid_response" });
    const html = new AgentApiClient({ baseUrl: "http://gw.test", apiKey: KEY, fetch: fakeFetch(502, undefined).fetch });
    await expect(html.getPurchase(newId("pur"))).rejects.toBeInstanceOf(AgentApiError);
  });

  it("parses a search response and encodes path segments", async () => {
    const { fetch, calls } = fakeFetch(200, { source: "unavailable", results: [], notice: "Channel3 is not configured" });
    const client = new AgentApiClient({ baseUrl: "http://gw.test", apiKey: KEY, fetch });
    expect((await client.search({ query: "pottery gift" })).source).toBe("unavailable");
    await expect(client.getProduct("a/b")).rejects.toMatchObject({ code: "invalid_response" });
    expect(calls[1]?.url).toBe("http://gw.test/v1/agent/products/a%2Fb");
  });
});
