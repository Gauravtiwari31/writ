// Payments v2: the second key of two-key settlement. Capture always sends the exact verified amount
// and final_capture: true (§22 rule 11), so the remainder of a hold can never be captured later.
import { minorToPayPalValue, type Currency } from "@writ/core";
import { purchaseRequestId, seg, type PayPalHttp, type PayPalResponse } from "./http";
import type { MoneyBody } from "./orders";
import { AuthorizationSchema, CaptureSchema, RefundSchema, type Authorization, type Capture, type Refund } from "./schemas";

export const AUTHORIZATIONS_PATH = "/v2/payments/authorizations";
export const CAPTURES_PATH = "/v2/payments/captures";
export const REFUNDS_PATH = "/v2/payments/refunds";

/** Payments v2 caps capture and refund invoice_id at 127 chars; ours is "wv-" + 40 hex. */
export const MAX_INVOICE_ID_LENGTH = 127;
const MAX_NOTE_TO_PAYER_LENGTH = 255;

export interface CaptureBody {
  readonly amount: MoneyBody;
  readonly invoice_id: string;
  readonly final_capture: true;
  readonly note_to_payer?: string;
}

export interface CaptureInput {
  readonly authorizationId: string;
  readonly purchaseId: string;
  /** The verified total. Never more than verified, even where PayPal would allow it. */
  readonly amountMinor: bigint;
  readonly currency: Currency;
  /** "wv-<C_post 40 hex>" from toInvoiceId (plan §6.7); unique per merchant. */
  readonly invoiceId: string;
  readonly noteToPayer?: string;
}

function checkInvoiceId(invoiceId: string): string {
  if (invoiceId.trim() === "") throw new TypeError("invoiceId must be non-empty");
  if (invoiceId.length > MAX_INVOICE_ID_LENGTH) {
    throw new TypeError(`invoiceId must be at most ${MAX_INVOICE_ID_LENGTH} chars (got ${invoiceId.length})`);
  }
  return invoiceId;
}

function checkNote(note: string): string {
  if (note.trim() === "" || note.length > MAX_NOTE_TO_PAYER_LENGTH) {
    throw new TypeError(`noteToPayer must be 1-${MAX_NOTE_TO_PAYER_LENGTH} chars`);
  }
  return note;
}

export function buildCaptureRequest(input: Pick<CaptureInput, "amountMinor" | "currency" | "invoiceId" | "noteToPayer">): CaptureBody {
  if (input.amountMinor <= 0n) throw new RangeError("capture amountMinor must be positive");
  return {
    amount: { currency_code: input.currency, value: minorToPayPalValue(input.amountMinor, input.currency) },
    invoice_id: checkInvoiceId(input.invoiceId),
    final_capture: true,
    ...(input.noteToPayer === undefined ? {} : { note_to_payer: checkNote(input.noteToPayer) }),
  };
}

/** POST /v2/payments/authorizations/{id}/capture with PayPal-Request-Id "<purchase_id>:capture". */
export function captureAuthorization(http: PayPalHttp, input: CaptureInput): Promise<PayPalResponse<Capture>> {
  const body = buildCaptureRequest(input);
  return http.post(`${AUTHORIZATIONS_PATH}/${seg(input.authorizationId)}/capture`, body, CaptureSchema, {
    requestId: purchaseRequestId(input.purchaseId, "capture"),
    prefer: "return=representation",
  });
}

/**
 * POST /v2/payments/authorizations/{id}/void. PayPal answers 204 with no body by default and 200 with
 * the authorization under Prefer: return=representation; both are accepted, so data may be null.
 */
export function voidAuthorization(
  http: PayPalHttp,
  input: { readonly authorizationId: string; readonly purchaseId: string },
): Promise<PayPalResponse<Authorization | null>> {
  return http.post(`${AUTHORIZATIONS_PATH}/${seg(input.authorizationId)}/void`, undefined, AuthorizationSchema.nullable(), {
    requestId: purchaseRequestId(input.purchaseId, "void"),
    prefer: "return=representation",
  });
}

export function getAuthorization(http: PayPalHttp, authorizationId: string): Promise<PayPalResponse<Authorization>> {
  return http.get(`${AUTHORIZATIONS_PATH}/${seg(authorizationId)}`, AuthorizationSchema);
}

export function getCapture(http: PayPalHttp, captureId: string): Promise<PayPalResponse<Capture>> {
  return http.get(`${CAPTURES_PATH}/${seg(captureId)}`, CaptureSchema);
}

export interface RefundInput {
  readonly captureId: string;
  readonly purchaseId: string;
  /** Omit for a full refund (PayPal refunds captured minus previous refunds). */
  readonly amount?: { readonly minor: bigint; readonly currency: Currency };
  readonly invoiceId?: string;
  readonly noteToPayer?: string;
}

export interface RefundBody {
  readonly amount?: MoneyBody;
  readonly invoice_id?: string;
  readonly note_to_payer?: string;
}

export function buildRefundRequest(input: Omit<RefundInput, "captureId" | "purchaseId">): RefundBody {
  if (input.amount !== undefined && input.amount.minor <= 0n) throw new RangeError("refund amount must be positive");
  return {
    ...(input.amount === undefined
      ? {}
      : { amount: { currency_code: input.amount.currency, value: minorToPayPalValue(input.amount.minor, input.amount.currency) } }),
    ...(input.invoiceId === undefined ? {} : { invoice_id: checkInvoiceId(input.invoiceId) }),
    ...(input.noteToPayer === undefined ? {} : { note_to_payer: checkNote(input.noteToPayer) }),
  };
}

/** POST /v2/payments/captures/{id}/refund (platform-liability route) with "<purchase_id>:refund". */
export function refundCapture(http: PayPalHttp, input: RefundInput): Promise<PayPalResponse<Refund>> {
  return http.post(`${CAPTURES_PATH}/${seg(input.captureId)}/refund`, buildRefundRequest(input), RefundSchema, {
    requestId: purchaseRequestId(input.purchaseId, "refund"),
    prefer: "return=representation",
  });
}

export function getRefund(http: PayPalHttp, refundId: string): Promise<PayPalResponse<Refund>> {
  return http.get(`${REFUNDS_PATH}/${seg(refundId)}`, RefundSchema);
}
