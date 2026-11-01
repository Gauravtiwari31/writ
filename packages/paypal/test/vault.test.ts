import { describe, expect, it } from "vitest";
import {
  buildPaymentTokenRequest,
  buildPayPalSetupTokenRequest,
  createPaymentToken,
  createSetupToken,
  deletePaymentToken,
  getPaymentToken,
  getSetupToken,
  listPaymentTokens,
  setupTokenApproveUrl,
} from "../src/vault";
import { bodyOf, jsonResponse, makeHttp } from "./fake";

const SETUP_TOKEN = {
  id: "5C991763VB2781612",
  customer: { id: "customer_4029352050" },
  status: "PAYER_ACTION_REQUIRED",
  payment_source: { paypal: { usage_type: "MERCHANT" } },
  links: [
    { href: "https://www.sandbox.paypal.com/agreements/approve?approval_session_id=5C991763VB2781612", rel: "approve", method: "GET" },
    { href: "https://api-m.sandbox.paypal.com/v3/vault/setup-tokens/5C991763VB2781612", rel: "self", method: "GET" },
  ],
};

const PAYMENT_TOKEN = {
  id: "8kk8451t",
  customer: { id: "customer_4029352050" },
  payment_source: { paypal: { email_address: "buyer@example.com", payer_id: "XQHSN372NGSP2" } },
};

describe("buildPayPalSetupTokenRequest", () => {
  it("builds a merchant-usage, consumer, save-without-purchase body", () => {
    expect(
      buildPayPalSetupTokenRequest({
        returnUrl: "http://localhost:8787/return",
        cancelUrl: "http://localhost:8787/cancel",
        brandName: "Writ",
        description: "Writ agents pay within limits you sign",
      }),
    ).toEqual({
      payment_source: {
        paypal: {
          description: "Writ agents pay within limits you sign",
          usage_pattern: "IMMEDIATE",
          usage_type: "MERCHANT",
          customer_type: "CONSUMER",
          permit_multiple_payment_tokens: false,
          experience_context: { return_url: "http://localhost:8787/return", cancel_url: "http://localhost:8787/cancel", brand_name: "Writ" },
        },
      },
    });
  });

  it("adds customer, locale and shipping preference when given", () => {
    const body = buildPayPalSetupTokenRequest({
      returnUrl: "https://writ.example/return",
      cancelUrl: "https://writ.example/cancel",
      customerId: "customer_4029352050",
      locale: "en-US",
      shippingPreference: "NO_SHIPPING",
      usagePattern: "DEFERRED",
    });
    expect(body.customer).toEqual({ id: "customer_4029352050" });
    expect(body.payment_source.paypal.usage_pattern).toBe("DEFERRED");
    expect(body.payment_source.paypal.experience_context).toMatchObject({ locale: "en-US", shipping_preference: "NO_SHIPPING" });
  });

  it.each([
    ["relative return URL", { returnUrl: "/return" }],
    ["non-http cancel URL", { cancelUrl: "javascript:alert(1)" }],
    ["bad customer id", { customerId: "cust id" }],
    ["description over 128", { description: "d".repeat(129) }],
    ["brand name over 127", { brandName: "b".repeat(128) }],
  ])("rejects %s", (_label, patch) => {
    expect(() =>
      buildPayPalSetupTokenRequest({ returnUrl: "http://localhost:8787/return", cancelUrl: "http://localhost:8787/cancel", ...patch }),
    ).toThrow(TypeError);
  });
});

describe("setup tokens", () => {
  it("POSTs the setup token with PayPal-Request-Id and exposes the approve link", async () => {
    const { http, apiCalls } = makeHttp(() => jsonResponse(201, SETUP_TOKEN, "dbg-setup"));
    const body = buildPayPalSetupTokenRequest({ returnUrl: "http://localhost:8787/return", cancelUrl: "http://localhost:8787/cancel" });
    const res = await createSetupToken(http, body, { requestId: "user_1:setup-token:abc" });
    expect(res.debugId).toBe("dbg-setup");
    expect(setupTokenApproveUrl(res.data)).toBe("https://www.sandbox.paypal.com/agreements/approve?approval_session_id=5C991763VB2781612");
    const call = apiCalls()[0];
    expect(call?.path).toBe("/v3/vault/setup-tokens");
    expect(call?.headers["paypal-request-id"]).toBe("user_1:setup-token:abc");
    expect(bodyOf(call)).toEqual(body);
  });

  it("throws when the approve link is missing", () => {
    expect(() => setupTokenApproveUrl({ id: "S1", status: "APPROVED", links: [] })).toThrow(/no approve link/);
  });

  it("GETs a setup token", async () => {
    const { http, apiCalls } = makeHttp(() => jsonResponse(200, { ...SETUP_TOKEN, status: "APPROVED" }));
    const res = await getSetupToken(http, "5C991763VB2781612");
    expect(res.data.status).toBe("APPROVED");
    expect(apiCalls()[0]?.path).toBe("/v3/vault/setup-tokens/5C991763VB2781612");
  });
});

describe("payment tokens", () => {
  it("creates the payment token from the setup token (type SETUP_TOKEN)", async () => {
    expect(buildPaymentTokenRequest("5C991763VB2781612")).toEqual({ payment_source: { token: { id: "5C991763VB2781612", type: "SETUP_TOKEN" } } });
    expect(() => buildPaymentTokenRequest("")).toThrow(TypeError);
    const { http, apiCalls } = makeHttp(() => jsonResponse(201, PAYMENT_TOKEN, "dbg-pt"));
    const res = await createPaymentToken(http, "5C991763VB2781612", { requestId: "user_1:payment-token:abc" });
    expect(res.data.id).toBe("8kk8451t");
    expect(res.data.customer?.id).toBe("customer_4029352050");
    expect(res.data.payment_source?.paypal?.payer_id).toBe("XQHSN372NGSP2");
    expect(apiCalls()[0]?.path).toBe("/v3/vault/payment-tokens");
    expect(apiCalls()[0]?.headers["paypal-request-id"]).toBe("user_1:payment-token:abc");
  });

  it("gets, lists and deletes payment tokens", async () => {
    const { http, apiCalls } = makeHttp((call) => {
      if (call.method === "DELETE") return jsonResponse(204, undefined, "dbg-del");
      if (call.search !== "") return jsonResponse(200, { customer: { id: "customer_4029352050" }, payment_tokens: [PAYMENT_TOKEN] });
      return jsonResponse(200, PAYMENT_TOKEN);
    });
    expect((await getPaymentToken(http, "8kk8451t")).data.id).toBe("8kk8451t");
    expect((await listPaymentTokens(http, "customer_4029352050")).data.payment_tokens?.[0]?.id).toBe("8kk8451t");
    expect(await deletePaymentToken(http, "8kk8451t")).toEqual({ status: 204, data: null, debugId: "dbg-del" });
    expect(apiCalls().map((c) => `${c.method} ${c.path}${c.search}`)).toEqual([
      "GET /v3/vault/payment-tokens/8kk8451t",
      "GET /v3/vault/payment-tokens?customer_id=customer_4029352050",
      "DELETE /v3/vault/payment-tokens/8kk8451t",
    ]);
    expect(() => listPaymentTokens(http, "bad id")).toThrow(TypeError);
  });
});
