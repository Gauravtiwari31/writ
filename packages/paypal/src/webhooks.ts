// Webhooks Management v1: signature verification by postback, the subscription the gateway uses, and
// the simulator. Plan §6.8: verify -> dedupe by event.id -> re-fetch the resource before acting. This
// module does the first step only; nothing in a webhook body is trusted beyond "PayPal says so".
import { sha256, toHex } from "@writ/core";
import { z } from "zod";
import { seg, type PayPalHttp, type PayPalResponse } from "./http";
import { LinkSchema } from "./schemas";

export const WEBHOOKS_PATH = "/v1/notifications/webhooks";
export const VERIFY_WEBHOOK_SIGNATURE_PATH = "/v1/notifications/verify-webhook-signature";
export const SIMULATE_EVENT_PATH = "/v1/notifications/simulate-event";
export const WEBHOOK_EVENTS_PATH = "/v1/notifications/webhooks-events";

/** Plan §7 row 7, names as listed in PayPal's webhook event reference. */
export const WRIT_WEBHOOK_EVENT_TYPES = [
  "PAYMENT.AUTHORIZATION.CREATED",
  "PAYMENT.AUTHORIZATION.VOIDED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DECLINED",
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
  "CUSTOMER.DISPUTE.CREATED",
  "CUSTOMER.DISPUTE.UPDATED",
  "CUSTOMER.DISPUTE.RESOLVED",
  "VAULT.PAYMENT-TOKEN.CREATED",
  "VAULT.PAYMENT-TOKEN.DELETED",
  "VAULT.PAYMENT-TOKEN.DELETION-INITIATED",
] as const;
export type WritWebhookEventType = (typeof WRIT_WEBHOOK_EVENT_TYPES)[number];

/**
 * PayPal docs: mock events from the simulator carry this literal webhook id, and "postback
 * verification to the verify-webhook-signature endpoint is not supported for mock events".
 */
export const MOCK_WEBHOOK_ID = "WEBHOOK_ID";

// ---------------------------------------------------------------------------------------------
// Events

const WebhookResourceSchema = z.looseObject({
  id: z.string().optional(),
  // Dispute events identify their resource by dispute_id, not id.
  dispute_id: z.string().optional(),
  status: z.string().optional(),
});

export const WebhookEventSchema = z.looseObject({
  id: z.string().min(1),
  event_type: z.string().min(1),
  create_time: z.string().optional(),
  resource_type: z.string().optional(),
  resource_version: z.string().optional(),
  event_version: z.string().optional(),
  summary: z.string().optional(),
  resource: WebhookResourceSchema.optional(),
  links: z.array(LinkSchema).optional(),
});
export type WebhookEvent = z.output<typeof WebhookEventSchema>;

/** The id of the resource the event is about (capture, authorization, dispute, payment token), or null. */
export function webhookResourceId(event: WebhookEvent): string | null {
  return event.resource?.id ?? event.resource?.dispute_id ?? null;
}

type RawJsonFn = (text: string) => unknown;
// JSON.rawJSON (Node 21+) is missing from the ES2023 lib typings, so it is read structurally.
const rawJSON: RawJsonFn | undefined = (JSON as unknown as { rawJSON?: RawJsonFn }).rawJSON;

/**
 * Parses JSON keeping every number's source text. PayPal asks for the webhook_event to be posted back
 * "exactly as it was received"; a plain parse/stringify turns 1.50 into 1.5 and rounds integers past
 * 2^53, which changes what PayPal re-checks. Strings and key order survive a plain round-trip already.
 */
export function parseJsonVerbatim(text: string): unknown {
  if (rawJSON === undefined) return JSON.parse(text);
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) =>
    typeof value === "number" && context?.source !== undefined ? rawJSON(context.source) : value,
  );
}

export interface ReceivedWebhookEvent {
  /** Validated view for reading id, type and resource. */
  readonly event: WebhookEvent;
  /** The same JSON with numbers kept verbatim; this is what goes back to PayPal for verification. */
  readonly verbatim: unknown;
}

export type ParseWebhookResult = { readonly ok: true; readonly value: ReceivedWebhookEvent } | { readonly ok: false; readonly error: string };

/** Parses a raw webhook body. Never throws; the error text names fields only, never values. */
export function parseWebhookEvent(rawBody: string): ParseWebhookResult {
  let json: unknown;
  try {
    json = JSON.parse(rawBody) as unknown;
  } catch {
    return { ok: false, error: "body is not valid JSON" };
  }
  const parsed = WebhookEventSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.code}`).join("; ") };
  }
  return { ok: true, value: { event: parsed.data, verbatim: parseJsonVerbatim(rawBody) } };
}

// ---------------------------------------------------------------------------------------------
// Transmission headers

export interface TransmissionHeaders {
  readonly authAlgo: string;
  readonly certUrl: string;
  readonly transmissionId: string;
  readonly transmissionSig: string;
  readonly transmissionTime: string;
}

/** Header names (lowercase) with the max lengths of the matching verify-webhook-signature fields. */
export const TRANSMISSION_HEADERS = {
  authAlgo: { name: "paypal-auth-algo", max: 100 },
  certUrl: { name: "paypal-cert-url", max: 500 },
  transmissionId: { name: "paypal-transmission-id", max: 50 },
  transmissionSig: { name: "paypal-transmission-sig", max: 500 },
  transmissionTime: { name: "paypal-transmission-time", max: 100 },
} as const satisfies Record<keyof TransmissionHeaders, { name: string; max: number }>;

/** A fetch Headers object or a Node/Fastify header record (any key case, possibly repeated values). */
export type HeaderSource = Headers | Readonly<Record<string, string | readonly string[] | undefined>>;

function readHeader(headers: HeaderSource, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  const values: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name || value === undefined) continue;
    if (typeof value === "string") values.push(value);
    else values.push(...value);
  }
  // A repeated transmission header is ambiguous; treat it as missing so the caller fails closed.
  return values.length === 1 ? (values[0] ?? null) : null;
}

/** Names of the transmission headers that are absent, empty, repeated or over PayPal's length limit. */
export function missingTransmissionHeaders(headers: HeaderSource): string[] {
  return Object.values(TRANSMISSION_HEADERS)
    .filter(({ name, max }) => {
      const value = readHeader(headers, name)?.trim() ?? "";
      return value === "" || value.length > max;
    })
    .map(({ name }) => name);
}

/** Case-insensitive. Returns null when any header is unusable, so callers must fail closed. */
export function extractTransmissionHeaders(headers: HeaderSource): TransmissionHeaders | null {
  if (missingTransmissionHeaders(headers).length > 0) return null;
  const get = (key: keyof TransmissionHeaders): string => (readHeader(headers, TRANSMISSION_HEADERS[key].name) ?? "").trim();
  return {
    authAlgo: get("authAlgo"),
    certUrl: get("certUrl"),
    transmissionId: get("transmissionId"),
    transmissionSig: get("transmissionSig"),
    transmissionTime: get("transmissionTime"),
  };
}

// ---------------------------------------------------------------------------------------------
// Verification (postback)

export type WebhookVerificationStatus = "SUCCESS" | "FAILURE";

export interface WebhookVerification {
  /** SUCCESS only when PayPal said exactly SUCCESS; anything else is FAILURE (fail closed). */
  readonly verificationStatus: WebhookVerificationStatus;
  /** PayPal's raw verification_status, for the log. */
  readonly paypalStatus: string;
  readonly debugId: string | null;
}

export interface VerifyWebhookInput {
  /** The id of the webhook subscription this listener belongs to (PAYPAL_WEBHOOK_ID). */
  readonly webhookId: string;
  readonly headers: TransmissionHeaders;
  /** The raw body string, or ReceivedWebhookEvent.verbatim. Never a re-built or edited object. */
  readonly event: unknown;
}

export interface VerifyWebhookSignatureBody {
  readonly auth_algo: string;
  readonly cert_url: string;
  readonly transmission_id: string;
  readonly transmission_sig: string;
  readonly transmission_time: string;
  readonly webhook_id: string;
  readonly webhook_event: unknown;
}

const WEBHOOK_ID_RE = /^[A-Za-z0-9]{1,50}$/;
const SAFE_TRANSMISSION_ID_RE = /^[A-Za-z0-9-]{1,50}$/;

export function buildVerifyWebhookSignatureRequest(input: VerifyWebhookInput): VerifyWebhookSignatureBody {
  if (!WEBHOOK_ID_RE.test(input.webhookId)) throw new TypeError("webhookId must be 1-50 letters or digits (PAYPAL_WEBHOOK_ID)");
  return {
    auth_algo: input.headers.authAlgo,
    cert_url: input.headers.certUrl,
    transmission_id: input.headers.transmissionId,
    transmission_sig: input.headers.transmissionSig,
    transmission_time: input.headers.transmissionTime,
    webhook_id: input.webhookId,
    webhook_event: typeof input.event === "string" ? parseJsonVerbatim(input.event) : input.event,
  };
}

/**
 * "wh-verify:<transmission id>:<sha256 of the request>". The digest keeps a replayed transmission id
 * with a different body from ever receiving PayPal's stored answer for the genuine one.
 */
export function verifyRequestId(body: VerifyWebhookSignatureBody): string {
  const tid = SAFE_TRANSMISSION_ID_RE.test(body.transmission_id) ? body.transmission_id : "x";
  return `wh-verify:${tid}:${toHex(sha256(JSON.stringify(body))).slice(0, 24)}`;
}

const VerifyResponseSchema = z.looseObject({ verification_status: z.string() });

/** POST /v1/notifications/verify-webhook-signature. Throws PayPalError when PayPal cannot answer. */
export async function verifyWebhookSignature(http: PayPalHttp, input: VerifyWebhookInput): Promise<WebhookVerification> {
  const body = buildVerifyWebhookSignatureRequest(input);
  const response = await http.post(VERIFY_WEBHOOK_SIGNATURE_PATH, body, VerifyResponseSchema, { requestId: verifyRequestId(body) });
  const paypalStatus = response.data.verification_status;
  return { verificationStatus: paypalStatus === "SUCCESS" ? "SUCCESS" : "FAILURE", paypalStatus, debugId: response.debugId };
}

// ---------------------------------------------------------------------------------------------
// Subscriptions, event history and the simulator

const EventTypeSchema = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  status: z.string().optional(),
});

export const WebhookSchema = z.looseObject({
  id: z.string().min(1),
  url: z.string(),
  event_types: z.array(EventTypeSchema).optional(),
  links: z.array(LinkSchema).optional(),
});
export type Webhook = z.output<typeof WebhookSchema>;

export const WebhookListSchema = z.looseObject({ webhooks: z.array(WebhookSchema).optional() });
export type WebhookList = z.output<typeof WebhookListSchema>;

export const WebhookEventListSchema = z.looseObject({
  events: z.array(WebhookEventSchema).optional(),
  count: z.number().optional(),
  links: z.array(LinkSchema).optional(),
});
export type WebhookEventList = z.output<typeof WebhookEventListSchema>;

const MAX_WEBHOOK_URL_LENGTH = 2048;
const MAX_EVENT_TYPE_LENGTH = 50;

function checkEventType(eventType: string): string {
  if (eventType.trim() === "" || eventType.length > MAX_EVENT_TYPE_LENGTH) {
    throw new TypeError(`event type must be 1-${MAX_EVENT_TYPE_LENGTH} chars`);
  }
  return eventType;
}

function checkListenerUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError("webhook url must be an absolute URL");
  }
  if (parsed.protocol !== "https:") throw new TypeError("PayPal only delivers webhooks to https URLs");
  if (url.length > MAX_WEBHOOK_URL_LENGTH) throw new TypeError(`webhook url must be at most ${MAX_WEBHOOK_URL_LENGTH} chars`);
  return url;
}

export function listWebhooks(http: PayPalHttp): Promise<PayPalResponse<WebhookList>> {
  return http.get(WEBHOOKS_PATH, WebhookListSchema);
}

export interface CreateWebhookInput {
  readonly url: string;
  readonly eventTypes: readonly string[];
  /** Default: derived from url and event types, so re-running the same registration replays. */
  readonly requestId?: string;
}

export function buildCreateWebhookRequest(input: Pick<CreateWebhookInput, "url" | "eventTypes">): { url: string; event_types: { name: string }[] } {
  if (input.eventTypes.length === 0) throw new TypeError("subscribe to at least one event type");
  return { url: checkListenerUrl(input.url), event_types: input.eventTypes.map((name) => ({ name: checkEventType(name) })) };
}

/** POST /v1/notifications/webhooks. PayPal answers WEBHOOK_URL_ALREADY_EXISTS for a URL it already has. */
export function createWebhook(http: PayPalHttp, input: CreateWebhookInput): Promise<PayPalResponse<Webhook>> {
  const body = buildCreateWebhookRequest(input);
  const requestId = input.requestId ?? `wh-create:${toHex(sha256(JSON.stringify(body))).slice(0, 40)}`;
  return http.post(WEBHOOKS_PATH, body, WebhookSchema, { requestId });
}

export interface ListWebhookEventsInput {
  readonly pageSize?: number;
  readonly eventType?: string;
  /** Internet date-time, e.g. 2026-11-01T00:00:00Z. */
  readonly startTime?: string;
  readonly endTime?: string;
  readonly transactionId?: string;
}

/** GET /v1/notifications/webhooks-events: events PayPal generated for this app (real ones, not mocks). */
export function listWebhookEvents(http: PayPalHttp, input: ListWebhookEventsInput = {}): Promise<PayPalResponse<WebhookEventList>> {
  const query: Record<string, string> = {};
  if (input.pageSize !== undefined) query.page_size = String(input.pageSize);
  if (input.eventType !== undefined) query.event_type = checkEventType(input.eventType);
  if (input.startTime !== undefined) query.start_time = input.startTime;
  if (input.endTime !== undefined) query.end_time = input.endTime;
  if (input.transactionId !== undefined) query.transaction_id = input.transactionId;
  return http.get(WEBHOOK_EVENTS_PATH, WebhookEventListSchema, { query });
}

export function getWebhookEvent(http: PayPalHttp, eventId: string): Promise<PayPalResponse<WebhookEvent>> {
  return http.get(`${WEBHOOK_EVENTS_PATH}/${seg(eventId)}`, WebhookEventSchema);
}

/**
 * POST /v1/notifications/webhooks-events/{id}/resend. A resend is a real, signed delivery of a real
 * event, so unlike a simulator event it can be verified by postback.
 */
export function resendWebhookEvent(
  http: PayPalHttp,
  input: { readonly eventId: string; readonly webhookIds?: readonly string[]; readonly requestId: string },
): Promise<PayPalResponse<WebhookEvent>> {
  const body = input.webhookIds === undefined ? {} : { webhook_ids: [...input.webhookIds] };
  return http.post(`${WEBHOOK_EVENTS_PATH}/${seg(input.eventId)}/resend`, body, WebhookEventSchema, { requestId: input.requestId });
}

export interface SimulateEventInput {
  readonly eventType: string;
  /** Exactly one of webhookId or url. */
  readonly webhookId?: string;
  readonly url?: string;
  readonly resourceVersion?: string;
  readonly requestId: string;
}

export function buildSimulateEventRequest(input: Omit<SimulateEventInput, "requestId">): Record<string, string> {
  if ((input.webhookId === undefined) === (input.url === undefined)) throw new TypeError("pass exactly one of webhookId or url");
  if (input.webhookId !== undefined && !WEBHOOK_ID_RE.test(input.webhookId)) throw new TypeError("webhookId must be 1-50 letters or digits");
  return {
    ...(input.webhookId === undefined ? {} : { webhook_id: input.webhookId }),
    ...(input.url === undefined ? {} : { url: checkListenerUrl(input.url) }),
    event_type: checkEventType(input.eventType),
    ...(input.resourceVersion === undefined ? {} : { resource_version: input.resourceVersion }),
  };
}

/**
 * POST /v1/notifications/simulate-event. The delivered mock is signed for webhook id MOCK_WEBHOOK_ID
 * and cannot pass postback verification; use it to test reachability, not S3.
 */
export function simulateEvent(http: PayPalHttp, input: SimulateEventInput): Promise<PayPalResponse<WebhookEvent>> {
  return http.post(SIMULATE_EVENT_PATH, buildSimulateEventRequest(input), WebhookEventSchema, { requestId: input.requestId });
}
