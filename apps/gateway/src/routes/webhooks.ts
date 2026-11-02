// POST /v1/webhooks/paypal (P0-8, plan §6.8). Keep the raw body, verify the signature with PayPal's
// postback API, dedupe by event id, store and enqueue (src/webhooks), acknowledge. The job handler
// re-fetches the resource from PayPal before anything changes (§22 rule 15).
// Anything short of a SUCCESS verification gets a non-2xx answer, so a spoofed event (threat T11)
// is never acknowledged and a genuine one is retried by PayPal (up to 25 times over 3 days).
import {
  extractTransmissionHeaders,
  missingTransmissionHeaders,
  parseWebhookEvent,
  PayPalError,
  verifyWebhookSignature,
  webhookResourceId,
  type PayPalHttp,
  type WebhookEvent,
  type TransmissionHeaders,
  type WebhookVerification,
} from "@writ/paypal";
import type { FastifyPluginAsync, FastifyReply } from "fastify";

export const PAYPAL_WEBHOOK_PATH = "/v1/webhooks/paypal";
/** Spike S3 only (ENABLE_SPIKES=true): the last deliveries, ids and statuses only, never payloads. */
export const WEBHOOK_SPIKE_STATUS_PATH = "/spikes/webhooks/recent";

const MAX_WEBHOOK_BODY_BYTES = 512 * 1024;
const MAX_RECENT = 50;

export interface WebhookVerifyRequest {
  readonly headers: TransmissionHeaders;
  /** The body exactly as received. */
  readonly rawBody: string;
  /** The same JSON with numbers kept verbatim (what is posted back to PayPal). */
  readonly verbatim: unknown;
}

export type WebhookVerifier = (request: WebhookVerifyRequest) => Promise<WebhookVerification>;

/** The production verifier: PayPal's verify-webhook-signature postback for one webhook subscription. */
export function paypalWebhookVerifier(http: PayPalHttp, webhookId: string): WebhookVerifier {
  return (request) => verifyWebhookSignature(http, { webhookId, headers: request.headers, event: request.verbatim });
}

export interface WebhookDedupe {
  has(eventId: string): boolean | Promise<boolean>;
  /** Called once, after a SUCCESS verification. A rejection answers 503 so PayPal delivers again. */
  add(eventId: string, event: WebhookEvent): void | Promise<void>;
}

/**
 * In-memory dedupe by event id, for a gateway with no database (spikes and tests). With a database the
 * durable webhook_events store in src/webhooks is used instead.
 */
export class InMemoryWebhookDedupe implements WebhookDedupe {
  readonly #seen = new Map<string, true>();

  constructor(readonly capacity = 10_000) {}

  has(eventId: string): boolean {
    return this.#seen.has(eventId);
  }

  add(eventId: string): void {
    this.#seen.set(eventId, true);
    // Bounded: drop the oldest ids first (Map keeps insertion order).
    while (this.#seen.size > this.capacity) {
      const oldest = this.#seen.keys().next();
      if (oldest.done === true) break;
      this.#seen.delete(oldest.value);
    }
  }
}

export type DeliveryOutcome = "verified" | "duplicate" | "rejected" | "unavailable";

export interface WebhookDelivery {
  readonly received_at: string;
  readonly outcome: DeliveryOutcome;
  readonly event_id: string | null;
  readonly event_type: string | null;
  readonly resource_type: string | null;
  readonly resource_id: string | null;
  readonly transmission_id: string | null;
  readonly verification_status: string | null;
  readonly paypal_debug_id: string | null;
  readonly reason: string | null;
}

export interface WebhookRoutesOptions {
  /** null when PayPal credentials or PAYPAL_WEBHOOK_ID are missing: every delivery gets 503. */
  readonly verifier: WebhookVerifier | null;
  readonly dedupe: WebhookDedupe;
  /** Mount GET /spikes/webhooks/recent (ENABLE_SPIKES=true). */
  readonly exposeRecent: boolean;
  readonly now?: () => Date;
}

function errorDebugId(error: unknown): string | null {
  return error instanceof PayPalError && "debugId" in error && typeof error.debugId === "string" ? error.debugId : null;
}

/** Register without fastify-plugin: the raw-body parser below must stay inside this scope. */
export const webhookRoutes: FastifyPluginAsync<WebhookRoutesOptions> = async (app, options) => {
  const now = options.now ?? (() => new Date());
  const recent: WebhookDelivery[] = [];

  // PayPal verifies the event as it sent it, so this scope never lets Fastify parse and rebuild JSON.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "string", bodyLimit: MAX_WEBHOOK_BODY_BYTES }, (_request, body, done) => {
    done(null, body);
  });

  app.post(PAYPAL_WEBHOOK_PATH, async (request, reply) => {
    const delivery: { -readonly [K in keyof WebhookDelivery]: WebhookDelivery[K] } = {
      received_at: now().toISOString(),
      outcome: "rejected",
      event_id: null,
      event_type: null,
      resource_type: null,
      resource_id: null,
      transmission_id: null,
      verification_status: null,
      paypal_debug_id: null,
      reason: null,
    };
    const finish = (status: number, body: Record<string, unknown>): FastifyReply => {
      recent.unshift({ ...delivery });
      if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;
      return reply.code(status).send(body);
    };

    const headers = extractTransmissionHeaders(request.headers);
    if (headers === null) {
      const missing = missingTransmissionHeaders(request.headers);
      delivery.reason = `missing transmission headers: ${missing.join(", ")}`;
      request.log.warn({ webhook: { missing_headers: missing } }, "paypal webhook rejected: missing transmission headers");
      return finish(400, { error: "missing_transmission_headers", missing });
    }
    delivery.transmission_id = headers.transmissionId;

    const rawBody = typeof request.body === "string" ? request.body : "";
    const parsed = parseWebhookEvent(rawBody);
    if (!parsed.ok) {
      delivery.reason = `invalid event: ${parsed.error}`;
      request.log.warn({ webhook: { transmission_id: headers.transmissionId, problem: parsed.error } }, "paypal webhook rejected: invalid event body");
      return finish(400, { error: "invalid_event" });
    }
    const { event, verbatim } = parsed.value;
    delivery.event_id = event.id;
    delivery.event_type = event.event_type;
    delivery.resource_type = event.resource_type ?? null;
    delivery.resource_id = webhookResourceId(event);
    const summary = {
      event_id: event.id,
      event_type: event.event_type,
      resource_type: delivery.resource_type,
      resource_id: delivery.resource_id,
      transmission_id: headers.transmissionId,
    };

    if (await options.dedupe.has(event.id)) {
      delivery.outcome = "duplicate";
      request.log.info({ webhook: summary }, "paypal webhook duplicate: already verified, not reprocessed");
      return finish(200, { received: true, duplicate: true, event_id: event.id });
    }

    if (options.verifier === null) {
      delivery.outcome = "unavailable";
      delivery.reason = "verification not configured";
      request.log.error(
        { webhook: summary },
        "paypal webhook NOT verified: set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_WEBHOOK_ID (PayPal will retry)",
      );
      return finish(503, { error: "webhook_verification_unavailable" });
    }

    let verification: WebhookVerification;
    try {
      verification = await options.verifier({ headers, rawBody, verbatim });
    } catch (error) {
      delivery.outcome = "unavailable";
      delivery.paypal_debug_id = errorDebugId(error);
      delivery.reason = error instanceof Error ? error.message : String(error);
      request.log.error(
        { webhook: summary, paypal_debug_id: delivery.paypal_debug_id, err: error },
        "paypal webhook NOT verified: verify-webhook-signature call failed (PayPal will retry)",
      );
      return finish(503, { error: "webhook_verification_unavailable" });
    }
    delivery.verification_status = verification.paypalStatus;
    delivery.paypal_debug_id = verification.debugId;
    const logged = { ...summary, verification_status: verification.paypalStatus, paypal_debug_id: verification.debugId };

    if (verification.verificationStatus !== "SUCCESS") {
      delivery.reason = "signature verification failed";
      request.log.warn(
        { webhook: logged },
        "paypal webhook verification FAILURE (simulator mock events always fail postback verification)",
      );
      return finish(400, { error: "signature_verification_failed" });
    }

    // A concurrent delivery of the same event may have been verified while this one waited.
    if (await options.dedupe.has(event.id)) {
      delivery.outcome = "duplicate";
      request.log.info({ webhook: logged }, "paypal webhook duplicate: already verified, not reprocessed");
      return finish(200, { received: true, duplicate: true, event_id: event.id });
    }
    try {
      await options.dedupe.add(event.id, event);
    } catch (error) {
      delivery.outcome = "unavailable";
      delivery.reason = "could not store the verified event";
      request.log.error({ webhook: logged, err: error }, "paypal webhook verified but not stored (PayPal will retry)");
      return finish(503, { error: "webhook_store_unavailable" });
    }
    delivery.outcome = "verified";
    request.log.info({ webhook: logged }, "paypal webhook verification SUCCESS");
    return finish(200, { received: true, event_id: event.id, verification_status: "SUCCESS" });
  });

  if (options.exposeRecent) {
    app.get(WEBHOOK_SPIKE_STATUS_PATH, async (_request, reply) => {
      void reply.header("cache-control", "no-store");
      return {
        spike: "S3",
        note: "In-memory, this instance only, newest first; ids and statuses, never payloads.",
        deliveries: recent,
      };
    });
  }
};
