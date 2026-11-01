import { commitPre, sha256, toCustomId } from "@writ/core";
import { describe, expect, it } from "vitest";
import { PayPalApiError, PayPalFlowError } from "../src/errors";
import {
  authorizeWithVault,
  buildMerchantInitiatedOrder,
  firstAuthorization,
  getOrder,
  MERCHANT_INITIATED_STORED_CREDENTIAL,
  type MerchantInitiatedOrderInput,
} from "../src/orders";
import { bodyOf, jsonResponse, makeHttp } from "./fake";

const CUSTOM_ID = toCustomId("hero01", commitPre(sha256("writ"), sha256("cart"), sha256("policy")));

const HERO: MerchantInitiatedOrderInput = {
  purchaseId: "pur_01hero",
  amountMinor: 4400n,
  currency: "USD",
  itemName: "Hand-thrown ceramic pour-over set",
  vaultId: "8kk8451t",
  customId: CUSTOM_ID,
};

const AUTHORIZATION = {
  id: "7X550106NA4440028",
  status: "CREATED",
  amount: { currency_code: "USD", value: "44.00" },
  expiration_time: "2026-11-30T10:00:00Z",
};

function orderWith(status: string, withAuthorization: boolean) {
  return {
    id: "8K832279M55989614",
    status,
    intent: "AUTHORIZE",
    purchase_units: [
      {
        reference_id: HERO.purchaseId,
        custom_id: CUSTOM_ID,
        amount: { currency_code: "USD", value: "44.00" },
        ...(withAuthorization ? { payments: { authorizations: [AUTHORIZATION] } } : {}),
      },
    ],
    links: [{ href: "https://api-m.sandbox.paypal.com/v2/checkout/orders/8K832279M55989614", rel: "self", method: "GET" }],
  };
}

describe("buildMerchantInitiatedOrder", () => {
  it("emits the documented AUTHORIZE body with items and a breakdown that add up", () => {
    expect(buildMerchantInitiatedOrder(HERO)).toEqual({
      intent: "AUTHORIZE",
      purchase_units: [
        {
          reference_id: "pur_01hero",
          custom_id: CUSTOM_ID,
          amount: { currency_code: "USD", value: "44.00", breakdown: { item_total: { currency_code: "USD", value: "44.00" } } },
          items: [{ name: "Hand-thrown ceramic pour-over set", quantity: "1", unit_amount: { currency_code: "USD", value: "44.00" } }],
        },
      ],
      payment_source: {
        paypal: {
          vault_id: "8kk8451t",
          stored_credential: { payment_initiator: "MERCHANT", usage: "SUBSEQUENT", usage_pattern: "IMMEDIATE" },
        },
      },
    });
  });

  it("formats minor units exactly", () => {
    const value = (amountMinor: bigint) => buildMerchantInitiatedOrder({ ...HERO, amountMinor }).purchase_units[0]?.amount.value;
    expect(value(5n)).toBe("0.05");
    expect(value(100n)).toBe("1.00");
    expect(value(123456n)).toBe("1234.56");
  });

  it("serializes to JSON (no bigint leaks into the body)", () => {
    expect(() => JSON.stringify(buildMerchantInitiatedOrder(HERO))).not.toThrow();
  });

  it("can omit stored_credential for S1 diagnosis", () => {
    const body = buildMerchantInitiatedOrder({ ...HERO, storedCredential: null });
    expect(body.payment_source.paypal).toEqual({ vault_id: "8kk8451t" });
  });

  it("uses the merchant-initiated stored credential by default", () => {
    expect(buildMerchantInitiatedOrder(HERO).payment_source.paypal.stored_credential).toBe(MERCHANT_INITIATED_STORED_CREDENTIAL);
  });

  it.each([
    ["zero amount", { amountMinor: 0n }, RangeError],
    ["negative amount", { amountMinor: -1n }, RangeError],
    ["empty item name", { itemName: " " }, TypeError],
    ["item name over 127", { itemName: "x".repeat(128) }, TypeError],
    ["empty custom_id", { customId: "" }, TypeError],
    ["custom_id over 127", { customId: "c".repeat(128) }, TypeError],
    ["vault id with spaces", { vaultId: "abc def" }, TypeError],
    ["empty purchase id", { purchaseId: "" }, TypeError],
  ] as const)("rejects %s", (_label, patch, errorType) => {
    expect(() => buildMerchantInitiatedOrder({ ...HERO, ...patch })).toThrow(errorType);
  });
});

describe("authorizeWithVault", () => {
  it("reads the authorization straight from a single-step create", async () => {
    const { http, apiCalls } = makeHttp(() => jsonResponse(201, orderWith("COMPLETED", true), "dbg-create"));
    const result = await authorizeWithVault(http, HERO);
    expect(result.flow).toBe("single-step");
    expect(result.createdStatus).toBe("COMPLETED");
    expect(result.authorization.id).toBe("7X550106NA4440028");
    expect(result.order.id).toBe("8K832279M55989614");
    expect(result.debugIds).toEqual({ createOrder: "dbg-create", authorizeOrder: null });
    const calls = apiCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/v2/checkout/orders");
    expect(calls[0]?.headers["paypal-request-id"]).toBe("pur_01hero:authorize");
    expect(calls[0]?.headers.prefer).toBe("return=representation");
    expect(bodyOf(calls[0])).toEqual(buildMerchantInitiatedOrder(HERO));
  });

  it("authorizes explicitly when the order comes back CREATED", async () => {
    const { http, apiCalls } = makeHttp((call) =>
      call.path.endsWith("/authorize") ? jsonResponse(201, orderWith("COMPLETED", true), "dbg-auth") : jsonResponse(201, orderWith("CREATED", false), "dbg-create"),
    );
    const result = await authorizeWithVault(http, HERO);
    expect(result.flow).toBe("order-authorize");
    expect(result.createdStatus).toBe("CREATED");
    expect(result.order.status).toBe("COMPLETED");
    expect(result.authorization.id).toBe("7X550106NA4440028");
    expect(result.debugIds).toEqual({ createOrder: "dbg-create", authorizeOrder: "dbg-auth" });
    const second = apiCalls()[1];
    expect(second?.path).toBe("/v2/checkout/orders/8K832279M55989614/authorize");
    expect(second?.headers["paypal-request-id"]).toBe("pur_01hero:order-authorize");
    expect(bodyOf(second)).toEqual({});
  });

  it("re-reads a COMPLETED order that came back without payments", async () => {
    const { http, apiCalls } = makeHttp((call) =>
      call.method === "GET" ? jsonResponse(200, orderWith("COMPLETED", true)) : jsonResponse(201, orderWith("COMPLETED", false)),
    );
    const result = await authorizeWithVault(http, HERO);
    expect(result.authorization.id).toBe("7X550106NA4440028");
    expect(apiCalls().map((c) => c.method)).toEqual(["POST", "GET"]);
  });

  it("stops with PayPalFlowError when PayPal wants the buyer (PAYER_ACTION_REQUIRED)", async () => {
    const body = {
      ...orderWith("PAYER_ACTION_REQUIRED", false),
      links: [{ href: "https://www.sandbox.paypal.com/checkoutnow?token=8K8", rel: "payer-action", method: "GET" }],
    };
    const { http, apiCalls } = makeHttp(() => jsonResponse(200, body, "dbg-par"));
    const error = await authorizeWithVault(http, HERO).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayPalFlowError);
    const flow = error as PayPalFlowError;
    expect(flow.status).toBe("PAYER_ACTION_REQUIRED");
    expect(flow.resourceId).toBe("8K832279M55989614");
    expect(flow.debugId).toBe("dbg-par");
    expect(flow.message).toContain("payer-action");
    expect(apiCalls()).toHaveLength(1);
  });

  it("propagates PayPal's error (with debug id) when the vault charge is refused", async () => {
    const { http } = makeHttp(() =>
      jsonResponse(422, { name: "UNPROCESSABLE_ENTITY", message: "failed", details: [{ issue: "PAYEE_NOT_ENABLED_FOR_VAULT" }] }, "dbg-422"),
    );
    const error = await authorizeWithVault(http, HERO).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayPalApiError);
    expect((error as PayPalApiError).debugId).toBe("dbg-422");
    expect((error as PayPalApiError).issues).toEqual(["PAYEE_NOT_ENABLED_FOR_VAULT"]);
  });
});

describe("getOrder and firstAuthorization", () => {
  it("GETs the order by encoded id", async () => {
    const { http, apiCalls } = makeHttp(() => jsonResponse(200, orderWith("COMPLETED", true)));
    const res = await getOrder(http, "8K832279M55989614");
    expect(apiCalls()[0]?.path).toBe("/v2/checkout/orders/8K832279M55989614");
    expect(res.data.purchase_units?.[0]?.custom_id).toBe(CUSTOM_ID);
    expect(firstAuthorization(res.data)?.status).toBe("CREATED");
  });

  it("returns null when there is no authorization", () => {
    expect(firstAuthorization({ id: "O", status: "CREATED" })).toBeNull();
  });
});
