import { commitPost, commitPre, sha256, toInvoiceId } from "@writ/core";
import { describe, expect, it } from "vitest";
import {
  buildCaptureRequest,
  buildRefundRequest,
  captureAuthorization,
  getAuthorization,
  getCapture,
  getRefund,
  refundCapture,
  voidAuthorization,
} from "../src/payments";
import { moneyToMinor } from "../src/schemas";
import { bodyOf, jsonResponse, makeHttp } from "./fake";

const INVOICE_ID = toInvoiceId(commitPost(commitPre(sha256("w"), sha256("c"), sha256("p")), sha256("v"), null));

const CAPTURE = {
  id: "2GG279541U471931P",
  status: "COMPLETED",
  amount: { currency_code: "USD", value: "44.00" },
  final_capture: true,
  invoice_id: INVOICE_ID,
  custom_id: "writ:hero01:0123456789abcdef0123456789abcdef01234567",
  supplementary_data: { related_ids: { order_id: "8K832279M55989614", authorization_id: "7X550106NA4440028" } },
};

describe("buildCaptureRequest", () => {
  it("captures the exact amount with invoice_id and final_capture: true", () => {
    expect(buildCaptureRequest({ amountMinor: 4400n, currency: "USD", invoiceId: INVOICE_ID })).toEqual({
      amount: { currency_code: "USD", value: "44.00" },
      invoice_id: INVOICE_ID,
      final_capture: true,
    });
  });

  it("formats odd amounts exactly", () => {
    expect(buildCaptureRequest({ amountMinor: 1n, currency: "USD", invoiceId: "wv-1" }).amount.value).toBe("0.01");
    expect(buildCaptureRequest({ amountMinor: 999999n, currency: "USD", invoiceId: "wv-1" }).amount.value).toBe("9999.99");
  });

  it("adds note_to_payer only when given", () => {
    expect(buildCaptureRequest({ amountMinor: 1n, currency: "USD", invoiceId: "wv-1", noteToPayer: "Writ purchase" })).toMatchObject({
      note_to_payer: "Writ purchase",
    });
  });

  it.each([
    ["zero amount", { amountMinor: 0n, currency: "USD", invoiceId: "wv-1" }, RangeError],
    ["negative amount", { amountMinor: -5n, currency: "USD", invoiceId: "wv-1" }, RangeError],
    ["empty invoice_id", { amountMinor: 1n, currency: "USD", invoiceId: "" }, TypeError],
    ["invoice_id over 127", { amountMinor: 1n, currency: "USD", invoiceId: "i".repeat(128) }, TypeError],
    ["note over 255", { amountMinor: 1n, currency: "USD", invoiceId: "wv-1", noteToPayer: "n".repeat(256) }, TypeError],
  ] as const)("rejects %s", (_label, input, errorType) => {
    expect(() => buildCaptureRequest(input)).toThrow(errorType);
  });
});

describe("captureAuthorization", () => {
  it("POSTs the capture with <purchase_id>:capture and returns the capture with its debug id", async () => {
    const { http, apiCalls } = makeHttp(() => jsonResponse(201, CAPTURE, "dbg-cap"));
    const res = await captureAuthorization(http, {
      authorizationId: "7X550106NA4440028",
      purchaseId: "pur_01hero",
      amountMinor: 4400n,
      currency: "USD",
      invoiceId: INVOICE_ID,
    });
    expect(res.debugId).toBe("dbg-cap");
    expect(res.data.id).toBe("2GG279541U471931P");
    expect(res.data.supplementary_data?.related_ids?.order_id).toBe("8K832279M55989614");
    const call = apiCalls()[0];
    expect(call?.path).toBe("/v2/payments/authorizations/7X550106NA4440028/capture");
    expect(call?.headers["paypal-request-id"]).toBe("pur_01hero:capture");
    expect(call?.headers.prefer).toBe("return=representation");
    expect(bodyOf(call)).toEqual({ amount: { currency_code: "USD", value: "44.00" }, invoice_id: INVOICE_ID, final_capture: true });
  });
});

describe("voidAuthorization", () => {
  it("accepts PayPal's default 204 with no body", async () => {
    const { http, apiCalls } = makeHttp(() => jsonResponse(204, undefined, "dbg-void"));
    const res = await voidAuthorization(http, { authorizationId: "7X5", purchaseId: "pur_01hero" });
    expect(res).toEqual({ status: 204, data: null, debugId: "dbg-void" });
    const call = apiCalls()[0];
    expect(call?.path).toBe("/v2/payments/authorizations/7X5/void");
    expect(call?.headers["paypal-request-id"]).toBe("pur_01hero:void");
    expect(call?.body).toBeUndefined();
  });

  it("accepts the 200 representation", async () => {
    const { http } = makeHttp(() => jsonResponse(200, { id: "7X5", status: "VOIDED" }));
    const res = await voidAuthorization(http, { authorizationId: "7X5", purchaseId: "pur_01hero" });
    expect(res.data?.status).toBe("VOIDED");
  });
});

describe("refunds", () => {
  it("sends an empty body for a full refund", () => {
    expect(buildRefundRequest({})).toEqual({});
  });

  it("sends the exact amount for a partial refund", () => {
    expect(buildRefundRequest({ amount: { minor: 1250n, currency: "USD" }, invoiceId: "wv-r", noteToPayer: "Platform error" })).toEqual({
      amount: { currency_code: "USD", value: "12.50" },
      invoice_id: "wv-r",
      note_to_payer: "Platform error",
    });
    expect(() => buildRefundRequest({ amount: { minor: 0n, currency: "USD" } })).toThrow(RangeError);
  });

  it("POSTs the refund with <purchase_id>:refund", async () => {
    const { http, apiCalls } = makeHttp(() => jsonResponse(201, { id: "1JU08902781691411", status: "COMPLETED" }));
    const res = await refundCapture(http, { captureId: "2GG279541U471931P", purchaseId: "pur_01hero" });
    expect(res.data.status).toBe("COMPLETED");
    expect(apiCalls()[0]?.path).toBe("/v2/payments/captures/2GG279541U471931P/refund");
    expect(apiCalls()[0]?.headers["paypal-request-id"]).toBe("pur_01hero:refund");
    expect(bodyOf(apiCalls()[0])).toEqual({});
  });
});

describe("reads", () => {
  it("GETs authorization, capture and refund by id", async () => {
    const { http, apiCalls } = makeHttp((call) =>
      call.path.startsWith("/v2/payments/captures/") ? jsonResponse(200, CAPTURE) : jsonResponse(200, { id: "X", status: "CAPTURED" }),
    );
    await getAuthorization(http, "7X5");
    const capture = await getCapture(http, "2GG279541U471931P");
    await getRefund(http, "R1");
    expect(apiCalls().map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /v2/payments/authorizations/7X5",
      "GET /v2/payments/captures/2GG279541U471931P",
      "GET /v2/payments/refunds/R1",
    ]);
    expect(capture.data.invoice_id).toBe(INVOICE_ID);
    expect(capture.data.final_capture).toBe(true);
  });
});

describe("moneyToMinor", () => {
  it("converts PayPal values back to minor units and refuses a currency mismatch", () => {
    expect(moneyToMinor({ currency_code: "USD", value: "44.00" }, "USD")).toBe(4400n);
    expect(() => moneyToMinor({ currency_code: "EUR", value: "44.00" }, "USD")).toThrow(/expected USD/);
  });
});
