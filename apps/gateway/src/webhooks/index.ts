// Durable webhook processing (P0-8, plan §6.8): a verified event is inserted by its PayPal id (a
// redelivery is a no-op) together with its outbox row, and the job handler re-fetches the resource from
// PayPal before changing anything (§22 rule 15): the event body only says what to look at.
// The saga's own jobs stay the driver of purchase state; webhooks reconcile what happens outside them.
import { VOIDABLE_PURCHASE_STATES, type JsonValue } from "@writ/core";
import { getAuthorization, getPaymentToken, getRefund, PayPalApiError, WebhookEventSchema, type WebhookEvent } from "@writ/paypal";
import { eq } from "drizzle-orm";
import type { JobHandler } from "../contracts/index";
import { SYSTEM_TENANT } from "../db/enums";
import { paypalVaultTokens, purchases, webhookEvents } from "../db/schema";
import { requireDb, type CoreServices } from "../deps";
import type { WebhookDedupe } from "../routes/webhooks";
import { holdToVoiding, lockPurchase, moveTo } from "../saga/core";

function resourceId(event: WebhookEvent): string | null {
  const resource = event.resource;
  if (typeof resource !== "object" || resource === null) return null;
  const direct = (resource as { id?: unknown }).id;
  if (typeof direct === "string") return direct;
  const dispute = (resource as { dispute_id?: unknown }).dispute_id;
  return typeof dispute === "string" ? dispute : null;
}

export function durableWebhookDedupe(deps: Pick<CoreServices, "db" | "uow">): WebhookDedupe {
  return {
    async has(eventId) {
      const [row] = await requireDb(deps).select({ id: webhookEvents.paypalEventId }).from(webhookEvents).where(eq(webhookEvents.paypalEventId, eventId));
      return row !== undefined;
    },
    async add(eventId, event) {
      await deps.uow.run(SYSTEM_TENANT, async (ctx) => {
        const inserted = await ctx.db
          .insert(webhookEvents)
          .values({
            paypalEventId: eventId,
            tenantId: SYSTEM_TENANT,
            type: event.event_type,
            resourceType: event.resource_type ?? null,
            resourceId: resourceId(event),
            payload: event as unknown as JsonValue,
            verified: true,
          })
          .onConflictDoNothing({ target: webhookEvents.paypalEventId })
          .returning({ id: webhookEvents.paypalEventId });
        if (inserted.length > 0) await ctx.enqueue({ topic: "paypal.webhook", payload: { event_id: eventId } });
      });
    },
  };
}

function upLinkCaptureId(links: readonly { rel?: string | undefined; href?: string | undefined }[] | undefined): string | null {
  const up = links?.find((link) => link.rel === "up")?.href;
  const match = up?.match(/\/captures\/([^/?#]+)/);
  return match?.[1] ?? null;
}

async function markRefunded(deps: CoreServices, captureId: string, refundId: string, debugId: string | null): Promise<string | null> {
  const [found] = await requireDb(deps).select({ id: purchases.id, tenantId: purchases.tenantId }).from(purchases).where(eq(purchases.captureId, captureId));
  if (found === undefined) return null;
  await deps.uow.run(found.tenantId, async (ctx) => {
    const row = await lockPurchase(ctx, found.id);
    if (row.state !== "CAPTURED") return;
    await ctx.appendLedger({
      writId: row.writId,
      purchaseId: row.id,
      type: "REFUNDED",
      payload: { refund_id: refundId, capture_id: captureId, source: "webhook", ...(debugId === null ? {} : { debug_id: debugId }) },
    });
    await moveTo(ctx, row, "REFUNDED", { refundId });
  });
  return found.tenantId;
}

/** Voided at PayPal while we still think money is held: release the hold; the void job then sees it voided and finishes. */
async function markVoidedOutside(deps: CoreServices, authorizationId: string): Promise<string | null> {
  const [found] = await requireDb(deps).select({ id: purchases.id, tenantId: purchases.tenantId }).from(purchases).where(eq(purchases.authorizationId, authorizationId));
  if (found === undefined) return null;
  await deps.uow.run(found.tenantId, async (ctx) => {
    const row = await lockPurchase(ctx, found.id);
    if ((VOIDABLE_PURCHASE_STATES as readonly string[]).includes(row.state)) {
      await holdToVoiding(ctx, row, "paypal_error", { stateDetail: "The authorization was voided outside Writ." });
    }
  });
  return found.tenantId;
}

async function revokeIfGone(deps: CoreServices, vaultId: string): Promise<void> {
  if (deps.paypal === null) return;
  try {
    await getPaymentToken(deps.paypal.http, vaultId);
    return; // Still exists at PayPal: the event does not match reality.
  } catch (error) {
    if (!(error instanceof PayPalApiError) || error.status !== 404) throw error;
  }
  await requireDb(deps).update(paypalVaultTokens).set({ status: "REVOKED", updatedAt: deps.clock() }).where(eq(paypalVaultTokens.vaultId, vaultId));
}

export function paypalWebhookHandler(deps: CoreServices): JobHandler<"paypal.webhook"> {
  return async (job) => {
    const db = requireDb(deps);
    const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.paypalEventId, job.payload.event_id));
    if (row === undefined || row.processedAt !== null) return { status: "done" };
    const parsed = WebhookEventSchema.safeParse(row.payload);
    if (!parsed.success) {
      await db.update(webhookEvents).set({ error: "stored event does not parse", processedAt: deps.clock() }).where(eq(webhookEvents.paypalEventId, row.paypalEventId));
      return { status: "dead", error: "stored webhook event does not parse" };
    }
    const type = row.type;
    const id = row.resourceId;
    let tenantId: string | null = null;
    try {
      if (type.startsWith("CUSTOMER.DISPUTE.")) {
        if (id === null) return { status: "dead", error: `${type} has no dispute id` };
        await deps.uow.run(SYSTEM_TENANT, async (ctx) => {
          await ctx.enqueue({
            topic: "dispute.sync",
            payload: { paypal_dispute_id: id, event_id: row.paypalEventId },
            dedupeKey: `dispute.sync:${row.paypalEventId}`,
          });
        });
      } else if (deps.paypal === null) {
        return { status: "retry", error: "PayPal is not configured; cannot re-fetch the resource", delayMs: 60_000 };
      } else if (id !== null && type === "PAYMENT.CAPTURE.REFUNDED") {
        const refund = await getRefund(deps.paypal.http, id);
        const captureId = upLinkCaptureId(refund.data.links);
        if (captureId !== null) tenantId = await markRefunded(deps, captureId, refund.data.id, refund.debugId);
      } else if (id !== null && type === "PAYMENT.AUTHORIZATION.VOIDED") {
        const authorization = await getAuthorization(deps.paypal.http, id);
        if (authorization.data.status === "VOIDED") tenantId = await markVoidedOutside(deps, id);
      } else if (id !== null && type === "VAULT.PAYMENT-TOKEN.DELETED") {
        await revokeIfGone(deps, id);
      }
      // PAYMENT.AUTHORIZATION.CREATED, PAYMENT.CAPTURE.COMPLETED and the rest: the saga's own PayPal
      // answers are authoritative and the recovery task covers a lost one; stored for the audit trail.
    } catch (error) {
      return { status: "retry", error: error instanceof Error ? error.message.slice(0, 500) : String(error) };
    }
    await db
      .update(webhookEvents)
      .set({ processedAt: deps.clock(), ...(tenantId === null ? {} : { tenantId }) })
      .where(eq(webhookEvents.paypalEventId, row.paypalEventId));
    return { status: "done" };
  };
}
