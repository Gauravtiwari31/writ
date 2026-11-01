import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PayPalApiError, PayPalNetworkError, PayPalResponseError, PayPalTimeoutError } from "../src/errors";
import { MAX_REQUEST_ID_LENGTH, PayPalHttp, purchaseRequestId, seg } from "../src/http";
import { ACCESS_TOKEN, bodyOf, fakeFetch, jsonResponse, makeHttp, testConfig, tokenResponse } from "./fake";

const Thing = z.looseObject({ id: z.string(), status: z.string() });

describe("PayPalHttp.post", () => {
  it("sends PayPal-Request-Id, bearer token, JSON body and Prefer, and returns status/data/debugId", async () => {
    const { http, apiCalls } = makeHttp(() => jsonResponse(201, { id: "X1", status: "CREATED", extra: { kept: true } }, "dbg-post"));
    const res = await http.post("/v2/things", { amount: "44.00" }, Thing, { requestId: "pur_1:authorize", prefer: "return=representation" });
    expect(res).toEqual({ status: 201, data: { id: "X1", status: "CREATED", extra: { kept: true } }, debugId: "dbg-post" });
    const call = apiCalls()[0];
    expect(call?.url).toBe("https://api-m.sandbox.paypal.com/v2/things");
    expect(call?.method).toBe("POST");
    expect(call?.headers["paypal-request-id"]).toBe("pur_1:authorize");
    expect(call?.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(call?.headers["content-type"]).toBe("application/json");
    expect(call?.headers.prefer).toBe("return=representation");
    expect(bodyOf(call)).toEqual({ amount: "44.00" });
  });

  it("refuses an empty or over-long PayPal-Request-Id before any network call", async () => {
    const { http, calls } = makeHttp(() => jsonResponse(200, { id: "X", status: "S" }));
    expect(() => http.post("/v2/things", {}, Thing, { requestId: "  " })).toThrow(TypeError);
    expect(() => http.post("/v2/things", {}, Thing, { requestId: "x".repeat(MAX_REQUEST_ID_LENGTH + 1) })).toThrow(/at most 108/);
    expect(calls).toHaveLength(0);
  });

  it("omits Content-Type and body when there is no body (void)", async () => {
    const { http, apiCalls } = makeHttp(() => jsonResponse(204, undefined, "dbg-void"));
    const res = await http.post("/v2/things/1/void", undefined, Thing.nullable(), { requestId: "p:void" });
    expect(res).toEqual({ status: 204, data: null, debugId: "dbg-void" });
    expect(apiCalls()[0]?.body).toBeUndefined();
    expect(apiCalls()[0]?.headers["content-type"]).toBeUndefined();
  });
});

describe("PayPalHttp.get and delete", () => {
  it("GET sends no PayPal-Request-Id and encodes the query", async () => {
    const { http, apiCalls } = makeHttp(() => jsonResponse(200, { id: "X", status: "OK" }));
    await http.get("/v3/vault/payment-tokens", Thing, { query: { customer_id: "cust 1&x" } });
    const call = apiCalls()[0];
    expect(call?.method).toBe("GET");
    expect(call?.search).toBe("?customer_id=cust+1%26x");
    expect(call?.headers["paypal-request-id"]).toBeUndefined();
  });

  it("DELETE accepts a 204", async () => {
    const { http, apiCalls } = makeHttp(() => jsonResponse(204, undefined));
    const res = await http.delete("/v3/vault/payment-tokens/abc", z.null());
    expect(res.data).toBeNull();
    expect(apiCalls()[0]?.method).toBe("DELETE");
  });
});

describe("PayPalHttp errors", () => {
  it("turns a PayPal error body into PayPalApiError with name, details and the header debug id", async () => {
    const { http } = makeHttp(() =>
      jsonResponse(
        422,
        {
          name: "UNPROCESSABLE_ENTITY",
          message: "The requested action could not be performed, semantically incorrect, or failed business validation.",
          debug_id: "dbg-body",
          details: [{ issue: "DUPLICATE_INVOICE_ID", field: "/invoice_id", value: "wv-abc", location: "body", description: "Duplicate Invoice ID detected." }],
        },
        "dbg-header",
      ),
    );
    const error = await http.post("/v2/payments/authorizations/A1/capture", {}, Thing, { requestId: "p:capture" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayPalApiError);
    const e = error as PayPalApiError;
    expect(e.status).toBe(422);
    expect(e.name).toBe("UNPROCESSABLE_ENTITY");
    expect(e.debugId).toBe("dbg-header");
    expect(e.path).toBe("/v2/payments/authorizations/A1/capture");
    expect(e.method).toBe("POST");
    expect(e.issues).toEqual(["DUPLICATE_INVOICE_ID"]);
    expect(e.hasIssue("DUPLICATE_INVOICE_ID")).toBe(true);
    expect(e.details[0]).toMatchObject({ field: "/invoice_id", value: "wv-abc", description: "Duplicate Invoice ID detected." });
    expect(e.message).toContain("PayPal-Debug-Id dbg-header");
    expect(e.message).toContain("[DUPLICATE_INVOICE_ID]");
    expect(e.message).not.toContain(ACCESS_TOKEN);
  });

  it("falls back to the body debug_id and to raw text for non-JSON errors", async () => {
    const { http } = makeHttp((call) =>
      call.path === "/a"
        ? jsonResponse(400, { name: "INVALID_REQUEST", message: "bad", debug_id: "dbg-from-body" }, null)
        : new Response("<html>Bad gateway</html>", { status: 502 }),
    );
    const a = (await http.get("/a", Thing).catch((e: unknown) => e)) as PayPalApiError;
    expect(a.debugId).toBe("dbg-from-body");
    const b = (await http.get("/b", Thing).catch((e: unknown) => e)) as PayPalApiError;
    expect(b).toBeInstanceOf(PayPalApiError);
    expect(b.name).toBe("HTTP_502");
    expect(b.paypalMessage).toBe("<html>Bad gateway</html>");
    expect(b.debugId).toBeNull();
  });

  it("fails closed on a 2xx body that does not match the schema, reporting paths only", async () => {
    const { http } = makeHttp(() => jsonResponse(200, { id: 42, status: "x", email: "buyer@example.com" }));
    const error = await http.get("/v2/x", Thing).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayPalResponseError);
    expect((error as PayPalResponseError).problems).toEqual(["id: invalid_type"]);
    expect((error as PayPalResponseError).debugId).toBe("dbg-test");
    expect((error as Error).message).not.toContain("buyer@example.com");
  });

  it("fails closed on a 2xx body that is not JSON", async () => {
    const { http } = makeHttp(() => new Response("not json", { status: 200 }));
    await expect(http.get("/v2/x", Thing)).rejects.toThrow(PayPalResponseError);
  });

  it("refreshes the token once on 401 and replays the same PayPal-Request-Id", async () => {
    let tokenCalls = 0;
    let apiCallCount = 0;
    const fake = fakeFetch(
      (call) => {
        if (call.path === "/v1/oauth2/token") return tokenResponse(`token-${++tokenCalls}`);
        apiCallCount += 1;
        return apiCallCount === 1 ? jsonResponse(401, { name: "AUTHENTICATION_FAILURE", message: "expired" }) : jsonResponse(200, { id: "X", status: "OK" });
      },
      { autoToken: false },
    );
    const http = new PayPalHttp({ config: testConfig(), fetch: fake.fetch, logger: () => undefined });
    await expect(http.post("/v2/x", {}, Thing, { requestId: "p:capture" })).resolves.toMatchObject({ status: 200 });
    const api = fake.apiCalls();
    expect(api.map((c) => c.headers.authorization)).toEqual(["Bearer token-1", "Bearer token-2"]);
    expect(api.map((c) => c.headers["paypal-request-id"])).toEqual(["p:capture", "p:capture"]);
  });

  it("gives up after a second 401", async () => {
    const { http, apiCalls } = makeHttp(() => jsonResponse(401, { name: "AUTHENTICATION_FAILURE", message: "no" }));
    await expect(http.get("/v2/x", Thing)).rejects.toMatchObject({ status: 401, name: "AUTHENTICATION_FAILURE" });
    expect(apiCalls()).toHaveLength(2);
  });

  it("times out (15 s in production) as PayPalTimeoutError with an unknown outcome", async () => {
    const { http, logs } = makeHttp(
      (_call, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
      { timeoutMs: 20 },
    );
    const error = await http.post("/v2/slow", {}, Thing, { requestId: "p:capture" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayPalTimeoutError);
    expect((error as PayPalTimeoutError).outcomeUnknown).toBe(true);
    expect((error as PayPalTimeoutError).timeoutMs).toBe(20);
    expect(logs.at(-1)).toMatchObject({ path: "/v2/slow", status: null, outcome: "timeout", requestId: "p:capture" });
  });

  it("maps a connection failure to PayPalNetworkError", async () => {
    const { http, logs } = makeHttp(() => Promise.reject(new TypeError("fetch failed")));
    const error = await http.get("/v2/x", Thing).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayPalNetworkError);
    expect((error as Error).message).toContain("fetch failed");
    expect(logs.at(-1)?.outcome).toBe("network");
  });
});

describe("logging", () => {
  it("logs every exchange with its PayPal-Debug-Id and request id, never the token", async () => {
    const { http, logs } = makeHttp((call) =>
      call.method === "POST" ? jsonResponse(201, { id: "X", status: "S" }, "dbg-a") : jsonResponse(404, { name: "RESOURCE_NOT_FOUND", message: "nope" }, "dbg-b"),
    );
    await http.post("/v2/x", {}, Thing, { requestId: "p:authorize" });
    await http.get("/v2/x/missing", Thing).catch(() => undefined);
    expect(logs[0]?.requestId).toMatch(/^oauth:/);
    expect(logs.map((l) => [l.method, l.path, l.status, l.debugId, l.path === "/v1/oauth2/token" ? "oauth" : l.requestId, l.outcome])).toEqual([
      ["POST", "/v1/oauth2/token", 200, "dbg-token", "oauth", "ok"],
      ["POST", "/v2/x", 201, "dbg-a", "p:authorize", "ok"],
      ["GET", "/v2/x/missing", 404, "dbg-b", null, "error"],
    ]);
    expect(JSON.stringify(logs)).not.toContain(ACCESS_TOKEN);
  });
});

describe("helpers", () => {
  it("purchaseRequestId follows <purchase_id>:<step> (plan §6.8)", () => {
    expect(purchaseRequestId("pur_01abc", "authorize")).toBe("pur_01abc:authorize");
    expect(purchaseRequestId("pur_01abc", "capture")).toBe("pur_01abc:capture");
    expect(() => purchaseRequestId("p".repeat(110), "void")).toThrow(/at most 108/);
    expect(() => purchaseRequestId(" ", "capture")).toThrow(/purchaseId/);
  });

  it("seg encodes path segments and rejects empty ids", () => {
    expect(seg("A/B?c")).toBe("A%2FB%3Fc");
    expect(() => seg("")).toThrow(TypeError);
  });
});
