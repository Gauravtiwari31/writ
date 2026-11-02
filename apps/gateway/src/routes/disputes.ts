// Disputes for the Wallet and console, and the sandbox simulate buttons (P0-9).
import { DisputeAnalysisSchema, idSchema } from "@writ/core";
import { DisputeActionRequestSchema, localIdSchema, SimulateDisputeRequestSchema } from "@writ/core/api";
import { and, asc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { sessionOf } from "../auth/guards";
import { ledgerEvents } from "../db/schema";
import { requireDb } from "../deps";
import { disputeView, listDisputes, loadDispute, requestDisputeAction, simulateDispute } from "../disputes/index";
import { parseWith } from "../http/errors";
import { ledgerEventFromRow, ledgerEventView } from "../tx/ledger";

const IdParams = z.strictObject({ id: localIdSchema("dsp") });
const PurchaseParams = z.strictObject({ purchaseId: idSchema("pur") });

export const disputeRoutes: FastifyPluginAsync = async (app) => {
  const services = app.services;

  app.get("/v1/disputes", async (request) => ({ disputes: await listDisputes(services, sessionOf(request).tenantId) }));

  app.get("/v1/disputes/:id", async (request) => {
    const session = sessionOf(request);
    const { id } = parseWith(IdParams, request.params, "path");
    const row = await loadDispute(services, session.tenantId, id);
    const analysis = DisputeAnalysisSchema.safeParse(row.analysis);
    const events = row.purchaseId === null ? [] : await requireDb(services).select().from(ledgerEvents).where(and(eq(ledgerEvents.purchaseId, row.purchaseId), eq(ledgerEvents.tenantId, session.tenantId))).orderBy(asc(ledgerEvents.seq));
    return { dispute: disputeView(row), analysis: analysis.success ? analysis.data : null, events: events.map((event) => ledgerEventView(ledgerEventFromRow(event))) };
  });

  app.post("/v1/disputes/:id/actions", async (request) => {
    const session = sessionOf(request);
    const { id } = parseWith(IdParams, request.params, "path");
    const body = parseWith(DisputeActionRequestSchema, request.body);
    return requestDisputeAction(services, session.tenantId, id, body.action);
  });

  app.post("/v1/demo/disputes/:purchaseId/simulate", async (request) => {
    const session = sessionOf(request);
    const { purchaseId } = parseWith(PurchaseParams, request.params, "path");
    const body = parseWith(SimulateDisputeRequestSchema, request.body);
    return simulateDispute(services, session.tenantId, purchaseId, body);
  });
};
