// Ledger event vocabulary (plan §6.3 state machine + disputes) and the JSON form of a ledger row (§6.5).
import { ANCHOR_HEX_CHARS, CurrencySchema, idSchema, MinorAmountSchema, parseCustomId, parseInvoiceId } from "@writ/core";
import { z } from "zod";
import { JsonObjectSchema } from "./json";

// Appending a type is backward compatible (old chains still verify); renaming or removing one is not.
export const LEDGER_EVENT_TYPES = [
  "WRIT_SIGNED",
  "WRIT_REVOKED",
  "WRIT_EXPIRED",
  "CART_PROPOSED",
  "POLICY_DECIDED",
  "PURCHASE_BLOCKED",
  "BUDGET_RESERVED",
  "PAYPAL_ORDER_CREATED",
  "PAYPAL_AUTHORIZED",
  "PURCHASE_FAILED",
  "SENTINEL_SCANNED",
  "VERIFIER_DECIDED",
  "HUMAN_REVIEW_REQUESTED",
  "HUMAN_APPROVED",
  "HUMAN_DECLINED",
  "HUMAN_REVIEW_EXPIRED",
  "PAYPAL_CAPTURED",
  "PAYPAL_CAPTURE_FAILED",
  "PAYPAL_VOIDED",
  "BUDGET_SETTLED",
  "BUDGET_RELEASED",
  "TRACKING_ADDED",
  "DISPUTE_OPENED",
  "DISPUTE_UPDATED",
  "DISPUTE_ANALYZED",
  "DISPUTE_EVIDENCE_SUBMITTED",
  "DISPUTE_CLAIM_ACCEPTED",
  "DISPUTE_RESOLVED",
  "REFUNDED",
  "KILL_SWITCH",
] as const;

export const LedgerEventTypeSchema = z.enum(LEDGER_EVENT_TYPES);
export type LedgerEventType = z.infer<typeof LedgerEventTypeSchema>;

export const Hex32Schema = z.string().regex(/^[0-9a-f]{64}$/, "expected 32 bytes as 64 lowercase hex chars");

/** Writ ids and purchase ids are @writ/core ids, the same strings the signed Writ and cart bodies carry. */
export const WritIdSchema = idSchema("wr");
export const PurchaseIdSchema = idSchema("pur");

/** PayPal order/authorization/capture/void and debug ids: opaque to us, but printable, whitespace-free and bounded. */
export const PayPalIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/, "expected a PayPal id of 1-128 chars [A-Za-z0-9._:-]");

const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** ISO 8601 UTC with exactly millisecond precision, i.e. what `Date#toISOString` emits. The hash covers this exact string. */
export const LedgerTimestampSchema = z
  .string()
  .regex(TS_RE, "expected ISO 8601 UTC with milliseconds, e.g. 2026-11-03T14:02:00.000Z")
  .refine((ts) => {
    const date = new Date(ts);
    return !Number.isNaN(date.getTime()) && date.toISOString() === ts;
  }, "not a real calendar instant");

export function toLedgerTimestamp(date: Date): string {
  return LedgerTimestampSchema.parse(date.toISOString());
}

export const LedgerEventSchema = z.strictObject({
  seq: z.int().positive(),
  writ_id: WritIdSchema,
  purchase_id: PurchaseIdSchema.nullable(),
  type: LedgerEventTypeSchema,
  payload: JsonObjectSchema,
  ts: LedgerTimestampSchema,
  prev_hash: Hex32Schema,
  hash: Hex32Schema,
});
export type LedgerEvent = z.infer<typeof LedgerEventSchema>;

// Payload contracts for the events an evidence pack is checked against. Loose objects: extra
// fields are allowed (and hashed), but the fields below must be present and well-formed.
// `purchase_id` is filled in by appendEvent, so the unhashed column is bound by the hashed payload.
//
// The PayPal events record the full 32-byte commitments next to the truncated anchors sent to
// PayPal. Without them the post-commitment would exist nowhere in the ledger on the void path or
// under the Spike S8 fallback, and the verifier/approval records in a pack could be swapped freely.

export const WritSignedPayloadSchema = z.looseObject({
  writ_id: WritIdSchema,
  writ_hash: Hex32Schema,
});

const DebugIdSchema = PayPalIdSchema.optional();
const PayPalTextSchema = z.string().min(1).max(127);

export const PayPalOrderCreatedPayloadSchema = z
  .looseObject({
    purchase_id: PurchaseIdSchema,
    order_id: PayPalIdSchema,
    custom_id: PayPalTextSchema,
    c_pre: Hex32Schema,
    amount_minor: MinorAmountSchema,
    currency: CurrencySchema,
    debug_id: DebugIdSchema,
  })
  .refine((p) => parseCustomId(p.custom_id)?.cPrePrefix === p.c_pre.slice(0, ANCHOR_HEX_CHARS), {
    message: "custom_id must be writ:<short>:<first 40 hex of c_pre>",
    path: ["custom_id"],
  });

export const PayPalAuthorizedPayloadSchema = z.looseObject({
  purchase_id: PurchaseIdSchema,
  order_id: PayPalIdSchema,
  authorization_id: PayPalIdSchema,
  debug_id: DebugIdSchema,
});

export const PayPalCapturedPayloadSchema = z
  .looseObject({
    purchase_id: PurchaseIdSchema,
    authorization_id: PayPalIdSchema,
    capture_id: PayPalIdSchema,
    amount_minor: MinorAmountSchema,
    currency: CurrencySchema,
    c_post: Hex32Schema,
    // null only under the Spike S8 fallback (PayPal rejected invoice_id; C_post stays ledger-only).
    invoice_id: PayPalTextSchema.nullable(),
    debug_id: DebugIdSchema,
  })
  .refine((p) => p.invoice_id === null || parseInvoiceId(p.invoice_id)?.cPostPrefix === p.c_post.slice(0, ANCHOR_HEX_CHARS), {
    message: "invoice_id must be wv-<first 40 hex of c_post>",
    path: ["invoice_id"],
  });

export const PayPalVoidedPayloadSchema = z.looseObject({
  purchase_id: PurchaseIdSchema,
  authorization_id: PayPalIdSchema,
  void_id: PayPalIdSchema.optional(),
  /** Over the verifier (and decline) records when they exist; null when voided before the verifier ran. */
  c_post: Hex32Schema.nullable(),
  debug_id: DebugIdSchema,
});

export const PAYLOAD_SCHEMAS = {
  WRIT_SIGNED: WritSignedPayloadSchema,
  PAYPAL_ORDER_CREATED: PayPalOrderCreatedPayloadSchema,
  PAYPAL_AUTHORIZED: PayPalAuthorizedPayloadSchema,
  PAYPAL_CAPTURED: PayPalCapturedPayloadSchema,
  PAYPAL_VOIDED: PayPalVoidedPayloadSchema,
} as const satisfies Partial<Record<LedgerEventType, z.ZodType>>;

export type WritSignedPayload = z.infer<typeof WritSignedPayloadSchema>;
export type PayPalOrderCreatedPayload = z.infer<typeof PayPalOrderCreatedPayloadSchema>;
export type PayPalAuthorizedPayload = z.infer<typeof PayPalAuthorizedPayloadSchema>;
export type PayPalCapturedPayload = z.infer<typeof PayPalCapturedPayloadSchema>;
export type PayPalVoidedPayload = z.infer<typeof PayPalVoidedPayloadSchema>;

export function payloadSchemaFor(type: LedgerEventType): z.ZodType | undefined {
  return (PAYLOAD_SCHEMAS as Partial<Record<LedgerEventType, z.ZodType>>)[type];
}
