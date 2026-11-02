// The public agent API: writs, search, products, carts, checkout, purchase status (P0-3, P0-4).
// Agents never name a payee, an amount or a raw address: carts are built here from catalog data.
import { idSchema, ProductRefSchema, toHex, WritBodySchema } from "@writ/core";
import { AgentSearchRequestSchema, CheckoutRequestSchema, IDEMPOTENCY_KEY_HEADER, IdempotencyKeySchema, ProposeCartRequestSchema, type AgentWritView } from "@writ/core/api";
import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { agentOf } from "../auth/guards";
import { resolveProducts, searchCatalog } from "../catalog/index";
import type { Db } from "../db/client";
import { writBudgets, writs, type Writ } from "../db/schema";
import { requireDb } from "../deps";
import { httpError, parseWith } from "../http/errors";
import { budgetView } from "../http/views";
import { checkoutStatus, getAgentPurchase, proposeCart, runCheckout } from "../pipeline/index";
import { writSummary } from "../writs/index";

const WritParams = z.strictObject({ id: idSchema("wr") });
const PurchaseParams = z.strictObject({ id: idSchema("pur") });
const ProductParams = z.strictObject({ ref: ProductRefSchema });

async function agentWritView(db: Db, row: Writ): Promise<AgentWritView | null> {
  const [budget] = await db.select().from(writBudgets).where(eq(writBudgets.writId, row.id));
  if (budget === undefined) return null;
  const body = WritBodySchema.parse(row.body);
  return { writ: body, status: row.status, hash: toHex(row.bodyHash), budget: budgetView(budget), summary: writSummary(body) };
}

export const agentApiRoutes: FastifyPluginAsync = async (app) => {
  const services = app.services;

  app.get("/v1/agent/writs", async (request) => {
    const agent = await agentOf(request);
    const db = requireDb(services);
    const rows = await db.select().from(writs).where(and(eq(writs.tenantId, agent.tenantId), eq(writs.agentId, agent.agentId))).limit(100);
    const views = await Promise.all(rows.map((row) => agentWritView(db, row)));
    return { writs: views.filter((view): view is AgentWritView => view !== null) };
  });

  app.get("/v1/agent/writs/:id", async (request) => {
    const agent = await agentOf(request);
    const { id } = parseWith(WritParams, request.params, "path");
    const db = requireDb(services);
    const [row] = await db.select().from(writs).where(and(eq(writs.id, id), eq(writs.tenantId, agent.tenantId), eq(writs.agentId, agent.agentId)));
    const view = row === undefined ? null : await agentWritView(db, row);
    if (view === null) throw httpError.notFound("Writ");
    return view;
  });

  app.post("/v1/agent/search", async (request) => {
    const agent = await agentOf(request);
    const body = parseWith(AgentSearchRequestSchema, request.body);
    return searchCatalog(services, requireDb(services), agent.tenantId, body);
  });

  app.get("/v1/agent/products/:ref", async (request) => {
    const agent = await agentOf(request);
    const { ref } = parseWith(ProductParams, request.params, "path");
    const found = await resolveProducts(services, requireDb(services), agent.tenantId, [ref]);
    const product = found.get(ref);
    if (product === undefined) throw httpError.notFound("Product");
    return { product };
  });

  app.post("/v1/agent/carts", async (request) => {
    const agent = await agentOf(request);
    const body = parseWith(ProposeCartRequestSchema, request.body);
    return proposeCart(services, agent, { writId: body.writ_id, items: body.items, shipToRef: body.ship_to_ref, sources: body.sources });
  });

  app.post("/v1/agent/checkout", async (request, reply) => {
    const agent = await agentOf(request);
    const body = parseWith(CheckoutRequestSchema, request.body);
    const key = parseWith(IdempotencyKeySchema, request.headers[IDEMPOTENCY_KEY_HEADER], "Idempotency-Key header");
    const view = await runCheckout(services, agent, { cartId: body.cart_id, idempotencyKey: key });
    return reply.code(checkoutStatus(view)).send(view);
  });

  app.get("/v1/agent/purchases/:id", async (request) => {
    const agent = await agentOf(request);
    const { id } = parseWith(PurchaseParams, request.params, "path");
    return getAgentPurchase(services, agent, id);
  });
};
