// Writ lifecycle: compile, create, sign, revoke, list/get, kill switch (P0-1).
import { idSchema } from "@writ/core";
import { CompileRequestSchema, CreateWritRequestSchema, KillSwitchRequestSchema, RevokeWritRequestSchema, SignWritRequestSchema } from "@writ/core/api";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { sessionOf } from "../auth/guards";
import { addressBook, writs } from "../db/schema";
import { requireDb } from "../deps";
import { HttpError, httpError, parseWith } from "../http/errors";
import { createWrit, getWrit, killSwitch, listWrits, revokeWrit, signWrit } from "../writs/index";

const IdParams = z.strictObject({ id: idSchema("wr") });

export const writRoutes: FastifyPluginAsync = async (app) => {
  const services = app.services;

  app.post("/v1/writs/compile", async (request) => {
    const session = sessionOf(request);
    const body = parseWith(CompileRequestSchema, request.body);
    const compiler = services.ai.compiler;
    if (compiler === null) throw httpError.unavailable("ai_unavailable", "No compiler model is configured. Fill in the permission card by hand.");
    const db = requireDb(services);
    const addresses = await db.select({ id: addressBook.id, label: addressBook.label }).from(addressBook).where(eq(addressBook.userId, session.userId));
    const existing = await db.select({ body: writs.body, status: writs.status }).from(writs).where(eq(writs.userId, session.userId)).limit(20);
    const result = await compiler.compile({
      text: body.text,
      addresses: addresses.map((address) => ({ ref: address.id, label: address.label })),
      existing_writs: existing.map((writ) => ({ purpose: String((writ.body as { purpose?: unknown }).purpose ?? ""), status: writ.status })),
      now: services.clock().toISOString(),
    });
    if (!result.ok) throw new HttpError(503, "ai_unavailable", `The compiler could not produce a draft (${result.failure.kind}). Fill in the permission card by hand.`);
    return { draft: result.value, model: result.meta.model ?? "unknown" };
  });

  app.post("/v1/writs", async (request) => {
    const session = sessionOf(request);
    const body = parseWith(CreateWritRequestSchema, request.body);
    return createWrit(services, { tenantId: session.tenantId, userId: session.userId, draft: body.draft, agentId: body.agent_id, shipToRef: body.ship_to_ref });
  });

  app.get("/v1/writs", async (request) => ({ writs: await listWrits(services, sessionOf(request).tenantId) }));

  app.get("/v1/writs/:id", async (request) => {
    const { id } = parseWith(IdParams, request.params, "path");
    return getWrit(services, sessionOf(request).tenantId, id);
  });

  app.post("/v1/writs/:id/sign", async (request) => {
    const session = sessionOf(request);
    const { id } = parseWith(IdParams, request.params, "path");
    const body = parseWith(SignWritRequestSchema, request.body);
    return signWrit(services, { tenantId: session.tenantId, userId: session.userId, writId: id, signature: body.signature });
  });

  app.post("/v1/writs/:id/revoke", async (request) => {
    const session = sessionOf(request);
    const { id } = parseWith(IdParams, request.params, "path");
    const body = parseWith(RevokeWritRequestSchema, request.body ?? {});
    return revokeWrit(services, { tenantId: session.tenantId, userId: session.userId, writId: id, reason: body.reason });
  });

  app.post("/v1/kill-switch", async (request) => {
    const session = sessionOf(request);
    const body = parseWith(KillSwitchRequestSchema, request.body ?? {});
    return killSwitch(services, { tenantId: session.tenantId, userId: session.userId, reason: body.reason });
  });
};
