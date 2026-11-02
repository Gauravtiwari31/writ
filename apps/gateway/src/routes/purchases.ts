// Purchases for the Wallet and console (P0-4).
import { CartSchema, CartSourcesSchema, idSchema, PurchaseStateSchema } from "@writ/core";
import { and, asc, desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { sessionOf } from "../auth/guards";
import { approvals, attacks, carts, decisions, purchases } from "../db/schema";
import { requireDb } from "../deps";
import { httpError, parseWith } from "../http/errors";
import { attackView, decisionView, purchaseView } from "../http/views";
import { ledgerEventFromRow, ledgerEventView } from "../tx/ledger";
import { ledgerEvents } from "../db/schema";

const IdParams = z.strictObject({ id: idSchema("pur") });
const ListQuery = z.strictObject({ writ_id: idSchema("wr").optional(), state: PurchaseStateSchema.optional() });

export const purchaseRoutes: FastifyPluginAsync = async (app) => {
  const services = app.services;

  app.get("/v1/purchases", async (request) => {
    const session = sessionOf(request);
    const query = parseWith(ListQuery, request.query, "query");
    const rows = await requireDb(services)
      .select()
      .from(purchases)
      .where(
        and(
          eq(purchases.tenantId, session.tenantId),
          query.writ_id === undefined ? undefined : eq(purchases.writId, query.writ_id),
          query.state === undefined ? undefined : eq(purchases.state, query.state),
        ),
      )
      .orderBy(desc(purchases.createdAt))
      .limit(500);
    return { purchases: rows.map(purchaseView) };
  });

  app.get("/v1/purchases/:id", async (request) => {
    const session = sessionOf(request);
    const { id } = parseWith(IdParams, request.params, "path");
    const db = requireDb(services);
    const [row] = await db
      .select()
      .from(purchases)
      .where(and(eq(purchases.id, id), eq(purchases.tenantId, session.tenantId)));
    if (row === undefined) throw httpError.notFound("Purchase");
    const [cart] = await db.select().from(carts).where(eq(carts.id, row.cartId));
    const decisionRows = await db.select().from(decisions).where(eq(decisions.purchaseId, id)).orderBy(asc(decisions.createdAt));
    const attackRows = await db.select().from(attacks).where(eq(attacks.purchaseId, id)).orderBy(asc(attacks.createdAt));
    const [approval] = await db.select({ id: approvals.id }).from(approvals).where(eq(approvals.purchaseId, id));
    const ledger = await db.select().from(ledgerEvents).where(eq(ledgerEvents.purchaseId, id)).orderBy(asc(ledgerEvents.seq));
    return {
      purchase: purchaseView(row),
      cart: CartSchema.parse(cart?.body),
      sources: CartSourcesSchema.catch([]).parse(cart?.sources),
      decisions: decisionRows.map(decisionView),
      attacks: attackRows.map(attackView),
      approval_id: approval?.id ?? null,
      ledger: ledger.map((event) => ledgerEventView(ledgerEventFromRow(event))),
    };
  });
};
