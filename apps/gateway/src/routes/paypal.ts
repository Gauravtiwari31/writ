// Connect PayPal (P0-2): a Vault setup token the buyer approves once (JS SDK v6 or the approve URL), then a
// payment token stored per user for merchant-initiated authorizations. Not live-verified until spike S1 runs.
import { CreatePaymentTokenRequestSchema, CreateSetupTokenRequestSchema, PAYPAL_SDK_V6_SANDBOX_URL, type VaultStatusView } from "@writ/core/api";
import { buildPayPalSetupTokenRequest, createPaymentToken, createSetupToken, deletePaymentToken, setupTokenApproveUrl } from "@writ/paypal";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { sessionOf } from "../auth/guards";
import type { Db } from "../db/client";
import { paypalVaultTokens, type PaypalVaultToken } from "../db/schema";
import { requireDb } from "../deps";
import { httpError, parseWith } from "../http/errors";

function statusView(row: PaypalVaultToken | undefined): VaultStatusView {
  if (row === undefined) return { connected: false, status: "NONE", vault_token_id: null, payer_hint: null, demo: false, updated_at: null };
  return { connected: row.status === "ACTIVE", status: row.status, vault_token_id: row.id, payer_hint: row.payerHint, demo: row.demo, updated_at: row.updatedAt.toISOString() };
}

async function latest(db: Db, userId: string): Promise<PaypalVaultToken | undefined> {
  const [row] = await db.select().from(paypalVaultTokens).where(eq(paypalVaultTokens.userId, userId)).orderBy(desc(paypalVaultTokens.createdAt)).limit(1);
  return row;
}

function maskEmail(email: string | undefined): string | null {
  if (email === undefined) return null;
  const [name = "", domain = ""] = email.split("@");
  return `${name.slice(0, 1)}***@${domain}`;
}

export const paypalRoutes: FastifyPluginAsync = async (app) => {
  const services = app.services;
  const clients = () => {
    if (services.paypal === null) throw httpError.unavailable("paypal_unconfigured", "PayPal is not configured on this gateway.");
    return services.paypal;
  };

  app.get("/v1/paypal/config", async (request) => {
    sessionOf(request);
    return { configured: services.paypal !== null, env: "sandbox" as const, client_id: services.paypal?.clientId ?? null, sdk_url: PAYPAL_SDK_V6_SANDBOX_URL };
  });

  app.get("/v1/paypal/vault", async (request) => statusView(await latest(requireDb(services), sessionOf(request).userId)));

  app.post("/v1/paypal/vault/setup-token", async (request) => {
    const session = sessionOf(request);
    parseWith(CreateSetupTokenRequestSchema, request.body);
    const { http } = clients();
    const base = services.config.appBaseUrl;
    if (base === null) throw httpError.unavailable("app_url_unconfigured", "APP_BASE_URL is not set.");
    const id = services.ids("vaultToken");
    const body = buildPayPalSetupTokenRequest({ returnUrl: `${base}/connect?result=approved`, cancelUrl: `${base}/connect?result=cancelled`, brandName: "Writ (sandbox)", description: "Lets Writ charge within limits you sign" });
    const token = await createSetupToken(http, body, { requestId: `setup:${id}` });
    await requireDb(services).insert(paypalVaultTokens).values({ id, tenantId: session.tenantId, userId: session.userId, setupTokenId: token.data.id, status: "PENDING" });
    return { setup_token_id: token.data.id, approve_url: setupTokenApproveUrl(token.data) };
  });

  app.post("/v1/paypal/vault/payment-token", async (request) => {
    const session = sessionOf(request);
    const body = parseWith(CreatePaymentTokenRequestSchema, request.body);
    const { http } = clients();
    const db = requireDb(services);
    const [pending] = await db
      .select()
      .from(paypalVaultTokens)
      .where(and(eq(paypalVaultTokens.setupTokenId, body.setup_token_id), eq(paypalVaultTokens.userId, session.userId)));
    if (pending === undefined) throw httpError.notFound("Setup token");
    const created = await createPaymentToken(http, body.setup_token_id, { requestId: `payment-token:${pending.id}` });
    const [row] = await db
      .update(paypalVaultTokens)
      .set({
        vaultId: created.data.id,
        status: "ACTIVE",
        paypalCustomerId: created.data.customer?.id ?? null,
        payerHint: maskEmail(created.data.payment_source?.paypal?.email_address),
        updatedAt: services.clock(),
      })
      .where(eq(paypalVaultTokens.id, pending.id))
      .returning();
    const view = statusView(row);
    services.events.publish(session.tenantId, { type: "paypal.updated", data: view });
    return view;
  });

  app.post("/v1/paypal/vault/disconnect", async (request) => {
    const session = sessionOf(request);
    const db = requireDb(services);
    const row = await latest(db, session.userId);
    if (row === undefined || row.status !== "ACTIVE") return statusView(row);
    if (row.vaultId !== null && !row.demo) await deletePaymentToken(clients().http, row.vaultId);
    const [updated] = await db.update(paypalVaultTokens).set({ status: "REVOKED", updatedAt: services.clock() }).where(eq(paypalVaultTokens.id, row.id)).returning();
    return statusView(updated);
  });
};
