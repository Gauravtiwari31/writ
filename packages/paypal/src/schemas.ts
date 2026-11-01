// Lenient response schemas: z.looseObject keeps fields we do not model, so a new PayPal field never
// breaks a call, while the fields the money path reads are type-checked. Statuses stay plain strings
// (PayPal adds enum values over time); callers compare them against the documented constants below.
import { payPalValueToMinor, type Currency } from "@writ/core";
import { z } from "zod";

export const MoneySchema = z.looseObject({
  currency_code: z.string().length(3),
  value: z.string().min(1),
});
export type Money = z.output<typeof MoneySchema>;

export const LinkSchema = z.looseObject({
  href: z.string(),
  rel: z.string(),
  method: z.string().optional(),
});
export type Link = z.output<typeof LinkSchema>;

const StatusDetailsSchema = z.looseObject({ reason: z.string().optional() });

/** Orders v2 order statuses. */
export const ORDER_STATUS = {
  CREATED: "CREATED",
  SAVED: "SAVED",
  APPROVED: "APPROVED",
  VOIDED: "VOIDED",
  COMPLETED: "COMPLETED",
  PAYER_ACTION_REQUIRED: "PAYER_ACTION_REQUIRED",
} as const;

/** Payments v2 authorization statuses. */
export const AUTHORIZATION_STATUS = {
  CREATED: "CREATED",
  CAPTURED: "CAPTURED",
  DENIED: "DENIED",
  PARTIALLY_CAPTURED: "PARTIALLY_CAPTURED",
  VOIDED: "VOIDED",
  PENDING: "PENDING",
} as const;

/** Payments v2 capture statuses. */
export const CAPTURE_STATUS = {
  COMPLETED: "COMPLETED",
  DECLINED: "DECLINED",
  PARTIALLY_REFUNDED: "PARTIALLY_REFUNDED",
  PENDING: "PENDING",
  REFUNDED: "REFUNDED",
  FAILED: "FAILED",
} as const;

export const AuthorizationSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string(),
  status_details: StatusDetailsSchema.optional(),
  amount: MoneySchema.optional(),
  custom_id: z.string().optional(),
  invoice_id: z.string().optional(),
  expiration_time: z.string().optional(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
  links: z.array(LinkSchema).optional(),
});
export type Authorization = z.output<typeof AuthorizationSchema>;

const RelatedIdsSchema = z.looseObject({
  order_id: z.string().optional(),
  authorization_id: z.string().optional(),
  capture_id: z.string().optional(),
});

export const CaptureSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string(),
  status_details: StatusDetailsSchema.optional(),
  amount: MoneySchema.optional(),
  final_capture: z.boolean().optional(),
  custom_id: z.string().optional(),
  invoice_id: z.string().optional(),
  supplementary_data: z.looseObject({ related_ids: RelatedIdsSchema.optional() }).optional(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
  links: z.array(LinkSchema).optional(),
});
export type Capture = z.output<typeof CaptureSchema>;

export const RefundSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string(),
  status_details: StatusDetailsSchema.optional(),
  amount: MoneySchema.optional(),
  custom_id: z.string().optional(),
  invoice_id: z.string().optional(),
  create_time: z.string().optional(),
  links: z.array(LinkSchema).optional(),
});
export type Refund = z.output<typeof RefundSchema>;

export const PurchaseUnitSchema = z.looseObject({
  reference_id: z.string().optional(),
  custom_id: z.string().optional(),
  invoice_id: z.string().optional(),
  amount: MoneySchema.optional(),
  payments: z
    .looseObject({
      authorizations: z.array(AuthorizationSchema).optional(),
      captures: z.array(CaptureSchema).optional(),
      refunds: z.array(RefundSchema).optional(),
    })
    .optional(),
});
export type PurchaseUnit = z.output<typeof PurchaseUnitSchema>;

export const OrderSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string(),
  intent: z.string().optional(),
  purchase_units: z.array(PurchaseUnitSchema).optional(),
  payment_source: z.looseObject({}).optional(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
  links: z.array(LinkSchema).optional(),
});
export type Order = z.output<typeof OrderSchema>;

/** 204 No Content: the transport hands the schema null. */
export const EmptyBodySchema = z.null();

/** Returns the href of the HATEOAS link with the given rel, or null. */
export function findLink(links: readonly Link[] | undefined, rel: string): string | null {
  return links?.find((link) => link.rel === rel)?.href ?? null;
}

/** Converts a PayPal amount to minor units, refusing a currency other than the expected one. */
export function moneyToMinor(money: Money, currency: Currency): bigint {
  if (money.currency_code !== currency) {
    throw new TypeError(`expected ${currency}, PayPal returned ${money.currency_code}`);
  }
  return payPalValueToMinor(money.value, currency);
}
