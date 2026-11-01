// Vault v3 payment method tokens: "save PayPal without purchase". The user approves a setup token
// once; the payment token created from it is the vault_id the agent's merchant-initiated orders use.
// Requires Vault enabled on the sandbox REST app (App Feature Options > Accept payments > Advanced options).
import { z } from "zod";
import { seg, type PayPalHttp, type PayPalResponse } from "./http";
import { AGENT_USAGE_PATTERN, type UsagePattern } from "./orders";
import { EmptyBodySchema, findLink, LinkSchema } from "./schemas";

export const SETUP_TOKENS_PATH = "/v3/vault/setup-tokens";
export const PAYMENT_TOKENS_PATH = "/v3/vault/payment-tokens";

/** Setup-token statuses (Vault v3 payment_token_status). */
export const SETUP_TOKEN_STATUS = {
  CREATED: "CREATED",
  PAYER_ACTION_REQUIRED: "PAYER_ACTION_REQUIRED",
  APPROVED: "APPROVED",
  VAULTED: "VAULTED",
  TOKENIZED: "TOKENIZED",
} as const;

const CustomerSchema = z.looseObject({ id: z.string().optional(), merchant_customer_id: z.string().optional() });

export const SetupTokenSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string(),
  customer: CustomerSchema.optional(),
  payment_source: z.looseObject({}).optional(),
  links: z.array(LinkSchema).optional(),
});
export type SetupToken = z.output<typeof SetupTokenSchema>;

export const PaymentTokenSchema = z.looseObject({
  id: z.string().min(1),
  customer: CustomerSchema.optional(),
  payment_source: z
    .looseObject({
      paypal: z
        .looseObject({
          email_address: z.string().optional(),
          payer_id: z.string().optional(),
          account_id: z.string().optional(),
          usage_type: z.string().optional(),
          customer_type: z.string().optional(),
          usage_pattern: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  links: z.array(LinkSchema).optional(),
});
export type PaymentToken = z.output<typeof PaymentTokenSchema>;

export const PaymentTokenListSchema = z.looseObject({
  customer: CustomerSchema.optional(),
  payment_tokens: z.array(PaymentTokenSchema).optional(),
  total_items: z.number().optional(),
  total_pages: z.number().optional(),
  links: z.array(LinkSchema).optional(),
});
export type PaymentTokenList = z.output<typeof PaymentTokenListSchema>;

export type ShippingPreference = "GET_FROM_FILE" | "NO_SHIPPING" | "SET_PROVIDED_ADDRESS";

export interface PayPalSetupTokenInput {
  readonly returnUrl: string;
  readonly cancelUrl: string;
  readonly brandName?: string;
  /** Shown to the buyer on the approval page and in their PayPal token management. */
  readonly description?: string;
  /** PayPal customer id from an earlier token, to add this wallet to the same customer. */
  readonly customerId?: string;
  readonly usagePattern?: UsagePattern;
  readonly shippingPreference?: ShippingPreference;
  readonly locale?: string;
}

export interface PayPalSetupTokenBody {
  readonly customer?: { readonly id: string };
  readonly payment_source: {
    readonly paypal: {
      readonly description?: string;
      readonly usage_pattern: UsagePattern;
      readonly usage_type: "MERCHANT";
      readonly customer_type: "CONSUMER";
      readonly permit_multiple_payment_tokens: false;
      readonly experience_context: {
        readonly return_url: string;
        readonly cancel_url: string;
        readonly brand_name?: string;
        readonly locale?: string;
        readonly shipping_preference?: ShippingPreference;
      };
    };
  };
}

// Vault v3 documents max 22 chars; we only check the charset so an id PayPal itself returned is never refused here.
const CUSTOMER_ID_RE = /^[0-9a-zA-Z_-]{1,255}$/;
const MAX_DESCRIPTION_LENGTH = 128;
// Vault v3 experience_context.brand_name: 1-127 chars.
const MAX_BRAND_NAME_LENGTH = 127;
const MAX_URL_LENGTH = 4000;

function checkUrl(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${name} must be an absolute URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new TypeError(`${name} must be http(s)`);
  if (value.length > MAX_URL_LENGTH) throw new TypeError(`${name} must be at most ${MAX_URL_LENGTH} chars`);
  return value;
}

function checkLength(name: string, value: string, max: number): string {
  if (value.trim() === "" || value.length > max) throw new TypeError(`${name} must be 1-${max} chars`);
  return value;
}

/**
 * Body for POST /v3/vault/setup-tokens (PayPal wallet). usage_type MERCHANT + customer_type CONSUMER
 * is what lets the merchant charge the wallet later without the buyer present.
 */
export function buildPayPalSetupTokenRequest(input: PayPalSetupTokenInput): PayPalSetupTokenBody {
  if (input.customerId !== undefined && !CUSTOMER_ID_RE.test(input.customerId)) {
    throw new TypeError("customerId must match ^[0-9a-zA-Z_-]+$");
  }
  return {
    ...(input.customerId === undefined ? {} : { customer: { id: input.customerId } }),
    payment_source: {
      paypal: {
        ...(input.description === undefined ? {} : { description: checkLength("description", input.description, MAX_DESCRIPTION_LENGTH) }),
        usage_pattern: input.usagePattern ?? AGENT_USAGE_PATTERN,
        usage_type: "MERCHANT",
        customer_type: "CONSUMER",
        permit_multiple_payment_tokens: false,
        experience_context: {
          return_url: checkUrl("returnUrl", input.returnUrl),
          cancel_url: checkUrl("cancelUrl", input.cancelUrl),
          ...(input.brandName === undefined ? {} : { brand_name: checkLength("brandName", input.brandName, MAX_BRAND_NAME_LENGTH) }),
          ...(input.locale === undefined ? {} : { locale: input.locale }),
          ...(input.shippingPreference === undefined ? {} : { shipping_preference: input.shippingPreference }),
        },
      },
    },
  };
}

export function createSetupToken(http: PayPalHttp, body: PayPalSetupTokenBody, options: { requestId: string }): Promise<PayPalResponse<SetupToken>> {
  return http.post(SETUP_TOKENS_PATH, body, SetupTokenSchema, { requestId: options.requestId });
}

export function getSetupToken(http: PayPalHttp, setupTokenId: string): Promise<PayPalResponse<SetupToken>> {
  return http.get(`${SETUP_TOKENS_PATH}/${seg(setupTokenId)}`, SetupTokenSchema);
}

/** The PayPal-hosted page where the buyer approves saving the wallet (HATEOAS rel "approve"). */
export function setupTokenApproveUrl(token: SetupToken): string {
  const href = findLink(token.links, "approve");
  if (href === null) throw new TypeError(`setup token ${token.id} (${token.status}) has no approve link`);
  return href;
}

export interface PaymentTokenBody {
  readonly payment_source: { readonly token: { readonly id: string; readonly type: "SETUP_TOKEN" } };
}

export function buildPaymentTokenRequest(setupTokenId: string): PaymentTokenBody {
  if (setupTokenId.trim() === "") throw new TypeError("setupTokenId must be non-empty");
  return { payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" } } };
}

/** POST /v3/vault/payment-tokens from an approved setup token; the result's id is the vault_id. */
export function createPaymentToken(
  http: PayPalHttp,
  setupTokenId: string,
  options: { requestId: string },
): Promise<PayPalResponse<PaymentToken>> {
  return http.post(PAYMENT_TOKENS_PATH, buildPaymentTokenRequest(setupTokenId), PaymentTokenSchema, { requestId: options.requestId });
}

export function getPaymentToken(http: PayPalHttp, paymentTokenId: string): Promise<PayPalResponse<PaymentToken>> {
  return http.get(`${PAYMENT_TOKENS_PATH}/${seg(paymentTokenId)}`, PaymentTokenSchema);
}

export function listPaymentTokens(http: PayPalHttp, customerId: string): Promise<PayPalResponse<PaymentTokenList>> {
  if (!CUSTOMER_ID_RE.test(customerId)) throw new TypeError("customerId must match ^[0-9a-zA-Z_-]+$");
  return http.get(PAYMENT_TOKENS_PATH, PaymentTokenListSchema, { query: { customer_id: customerId } });
}

/** DELETE /v3/vault/payment-tokens/{id}: PayPal answers 204. */
export function deletePaymentToken(http: PayPalHttp, paymentTokenId: string): Promise<PayPalResponse<null>> {
  return http.delete(`${PAYMENT_TOKENS_PATH}/${seg(paymentTokenId)}`, EmptyBodySchema);
}
