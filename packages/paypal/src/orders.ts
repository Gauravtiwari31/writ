// Orders v2: the merchant-initiated AUTHORIZE order that puts a hold on the vaulted PayPal wallet
// (plan §6.4 two-key purchase). Body shape per the Orders v2 spec (order_request, paypal_wallet,
// paypal_wallet_stored_credential); amounts leave bigint minor units only here, at the HTTP edge.
import { minorToPayPalValue, type Currency } from "@writ/core";
import { PayPalFlowError } from "./errors";
import { purchaseRequestId, seg, type PayPalHttp, type PayPalResponse } from "./http";
import { findLink, ORDER_STATUS, OrderSchema, type Authorization, type Order } from "./schemas";

export const ORDERS_PATH = "/v2/checkout/orders";

/** `usage_pattern` enum shared by Orders v2 stored_credential and Vault v3 setup tokens. */
export const USAGE_PATTERNS = [
  "IMMEDIATE",
  "DEFERRED",
  "RECURRING_PREPAID",
  "RECURRING_POSTPAID",
  "THRESHOLD_PREPAID",
  "THRESHOLD_POSTPAID",
  "SUBSCRIPTION_PREPAID",
  "SUBSCRIPTION_POSTPAID",
  "UNSCHEDULED_PREPAID",
  "UNSCHEDULED_POSTPAID",
  "INSTALLMENT_PREPAID",
  "INSTALLMENT_POSTPAID",
] as const;
export type UsagePattern = (typeof USAGE_PATTERNS)[number];

/**
 * S1 decision. Vault v3 documents IMMEDIATE as "on-demand instant payments - non-recurring,
 * pre-paid, variable amount, variable frequency", which is exactly an agent purchase inside a Writ.
 * The setup token and every order use the same value so the agreement and the charges agree.
 */
export const AGENT_USAGE_PATTERN: UsagePattern = "IMMEDIATE";

export interface StoredCredential {
  readonly payment_initiator: "CUSTOMER" | "MERCHANT";
  readonly usage: "FIRST" | "SUBSEQUENT" | "DERIVED";
  readonly usage_pattern: UsagePattern;
}

/** The agent pays later with a wallet the user saved earlier: merchant-initiated, subsequent use. */
export const MERCHANT_INITIATED_STORED_CREDENTIAL: StoredCredential = Object.freeze({
  payment_initiator: "MERCHANT",
  usage: "SUBSEQUENT",
  usage_pattern: AGENT_USAGE_PATTERN,
});

/** Plan §6.7 caps custom_id at 127 (Orders allows 255, but refunds and captures echo it at 127). */
export const MAX_CUSTOM_ID_LENGTH = 127;
/** PayPal accepts longer item names but truncates them to 127 in every response. */
export const MAX_ITEM_NAME_LENGTH = 127;
const MAX_REFERENCE_ID_LENGTH = 256;
const VAULT_ID_RE = /^[0-9a-zA-Z_-]{1,255}$/;

export interface MoneyBody {
  readonly currency_code: string;
  readonly value: string;
}

export interface ItemBody {
  readonly name: string;
  readonly quantity: string;
  readonly unit_amount: MoneyBody;
}

export interface PurchaseUnitBody {
  readonly reference_id: string;
  readonly custom_id: string;
  readonly amount: MoneyBody & { readonly breakdown: { readonly item_total: MoneyBody } };
  readonly items: readonly ItemBody[];
}

export interface VaultedPayPalSource {
  readonly vault_id: string;
  readonly stored_credential?: StoredCredential;
}

export interface CreateOrderBody {
  readonly intent: "AUTHORIZE";
  readonly purchase_units: readonly PurchaseUnitBody[];
  readonly payment_source: { readonly paypal: VaultedPayPalSource };
}

export interface MerchantInitiatedOrderInput {
  /** Our purchase id: the purchase unit's reference_id and the PayPal-Request-Id prefix. */
  readonly purchaseId: string;
  readonly amountMinor: bigint;
  readonly currency: Currency;
  readonly itemName: string;
  /** The Vault v3 payment token id (vault_id). */
  readonly vaultId: string;
  /** "writ:<writ_short>:<C_pre 40 hex>" from toCustomId (plan §6.7). */
  readonly customId: string;
  /** Defaults to MERCHANT_INITIATED_STORED_CREDENTIAL. null omits the block (S1 diagnosis only). */
  readonly storedCredential?: StoredCredential | null;
}

function money(amountMinor: bigint, currency: Currency): MoneyBody {
  return { currency_code: currency, value: minorToPayPalValue(amountMinor, currency) };
}

function requireText(name: string, value: string, max: number): string {
  if (value.trim() === "") throw new TypeError(`${name} must be non-empty`);
  if (value.length > max) throw new TypeError(`${name} must be at most ${max} chars (got ${value.length})`);
  return value;
}

/** One item, quantity 1; amount == breakdown.item_total == unit_amount, so PayPal's sum rule holds. */
export function buildMerchantInitiatedOrder(input: MerchantInitiatedOrderInput): CreateOrderBody {
  if (input.amountMinor <= 0n) throw new RangeError("amountMinor must be positive");
  requireText("purchaseId", input.purchaseId, MAX_REFERENCE_ID_LENGTH);
  requireText("itemName", input.itemName, MAX_ITEM_NAME_LENGTH);
  requireText("customId", input.customId, MAX_CUSTOM_ID_LENGTH);
  if (!VAULT_ID_RE.test(input.vaultId)) throw new TypeError("vaultId must match ^[0-9a-zA-Z_-]{1,255}$");
  const total = money(input.amountMinor, input.currency);
  const storedCredential = input.storedCredential === undefined ? MERCHANT_INITIATED_STORED_CREDENTIAL : input.storedCredential;
  return {
    intent: "AUTHORIZE",
    purchase_units: [
      {
        reference_id: input.purchaseId,
        custom_id: input.customId,
        amount: { ...total, breakdown: { item_total: total } },
        items: [{ name: input.itemName, quantity: "1", unit_amount: total }],
      },
    ],
    payment_source: {
      paypal: storedCredential === null ? { vault_id: input.vaultId } : { vault_id: input.vaultId, stored_credential: storedCredential },
    },
  };
}

/** POST /v2/checkout/orders with the full representation, so a single-step authorization is visible. */
export function createOrder(http: PayPalHttp, body: CreateOrderBody, options: { requestId: string }): Promise<PayPalResponse<Order>> {
  return http.post(ORDERS_PATH, body, OrderSchema, { requestId: options.requestId, prefer: "return=representation" });
}

export function getOrder(http: PayPalHttp, orderId: string): Promise<PayPalResponse<Order>> {
  return http.get(`${ORDERS_PATH}/${seg(orderId)}`, OrderSchema);
}

/** POST /v2/checkout/orders/{id}/authorize for an order that was created but not yet authorized. */
export function authorizeOrder(http: PayPalHttp, orderId: string, options: { requestId: string }): Promise<PayPalResponse<Order>> {
  return http.post(`${ORDERS_PATH}/${seg(orderId)}/authorize`, {}, OrderSchema, {
    requestId: options.requestId,
    prefer: "return=representation",
  });
}

export function firstAuthorization(order: Order): Authorization | null {
  return order.purchase_units?.[0]?.payments?.authorizations?.[0] ?? null;
}

export interface VaultAuthorizationResult {
  readonly order: Order;
  readonly authorization: Authorization;
  /** "single-step": create returned the authorization; "order-authorize": a second call was needed. */
  readonly flow: "single-step" | "order-authorize";
  /** Order status as the create call returned it (before any follow-up authorize). */
  readonly createdStatus: string;
  readonly debugIds: { readonly createOrder: string | null; readonly authorizeOrder: string | null };
}

/**
 * Creates the AUTHORIZE order against the vaulted wallet and returns the authorization. With a
 * vault_id PayPal normally authorizes in the create call; if the order comes back CREATED or
 * APPROVED we authorize it explicitly. Anything else (PAYER_ACTION_REQUIRED) means the wallet cannot
 * be charged merchant-initiated, and the S1 fallback applies.
 */
export async function authorizeWithVault(http: PayPalHttp, input: MerchantInitiatedOrderInput): Promise<VaultAuthorizationResult> {
  const body = buildMerchantInitiatedOrder(input);
  const created = await createOrder(http, body, { requestId: purchaseRequestId(input.purchaseId, "authorize") });
  const order = created.data;
  const singleStep = (latest: Order, authorization: Authorization): VaultAuthorizationResult => ({
    order: latest,
    authorization,
    flow: "single-step",
    createdStatus: order.status,
    debugIds: { createOrder: created.debugId, authorizeOrder: null },
  });
  const direct = firstAuthorization(order);
  if (direct !== null) return singleStep(order, direct);
  if (order.status === ORDER_STATUS.COMPLETED) {
    // Completed without payments in the body: re-read rather than guess.
    const reread = (await getOrder(http, order.id)).data;
    const authorization = firstAuthorization(reread);
    if (authorization !== null) return singleStep(reread, authorization);
    throw new PayPalFlowError("order is COMPLETED but has no authorization", order.id, order.status, created.debugId);
  }
  if (order.status === ORDER_STATUS.CREATED || order.status === ORDER_STATUS.APPROVED) {
    const authorized = await authorizeOrder(http, order.id, { requestId: purchaseRequestId(input.purchaseId, "order-authorize") });
    const authorization = firstAuthorization(authorized.data);
    if (authorization === null) {
      throw new PayPalFlowError("authorize returned no authorization", authorized.data.id, authorized.data.status, authorized.debugId);
    }
    return {
      order: authorized.data,
      authorization,
      flow: "order-authorize",
      createdStatus: order.status,
      debugIds: { createOrder: created.debugId, authorizeOrder: authorized.debugId },
    };
  }
  const payerAction = findLink(order.links, "payer-action");
  const hint = payerAction === null ? "" : "; PayPal wants the buyer to approve (payer-action link present)";
  throw new PayPalFlowError(
    `merchant-initiated order ended in ${order.status} without an authorization${hint}`,
    order.id,
    order.status,
    created.debugId,
  );
}
