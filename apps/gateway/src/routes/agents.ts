// Wallet-side agent management: create (key shown once), list, revoke, rotate (P0-3).
import { idSchema } from "@writ/core";
import { CreateAgentRequestSchema } from "@writ/core/api";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { mintAgentKey } from "../auth/agent-keys";
import { sessionOf } from "../auth/guards";
import { agents } from "../db/schema";
import { requireDb } from "../deps";
import { httpError, parseWith } from "../http/errors";
import { agentView } from "../identity/index";

const IdParams = z.strictObject({ id: idSchema("agt") });

export const agentRoutes: FastifyPluginAsync = async (app) => {
  const services = app.services;

  app.post("/v1/agents", async (request) => {
    const session = sessionOf(request);
    const body = parseWith(CreateAgentRequestSchema, request.body);
    const minted = mintAgentKey();
    const [row] = await requireDb(services)
      .insert(agents)
      .values({ id: services.ids("agent"), tenantId: session.tenantId, userId: session.userId, name: body.name, kind: body.kind, apiKeyHash: minted.hash, keyHint: minted.hint })
      .returning();
    if (row === undefined) throw new Error("agent insert returned no row");
    return { agent: agentView(row), api_key: minted.key };
  });

  app.get("/v1/agents", async (request) => {
    const session = sessionOf(request);
    const rows = await requireDb(services).select().from(agents).where(eq(agents.userId, session.userId)).orderBy(desc(agents.createdAt)).limit(200);
    return { agents: rows.map(agentView) };
  });

  app.post("/v1/agents/:id/revoke", async (request) => {
    const session = sessionOf(request);
    const { id } = parseWith(IdParams, request.params, "path");
    const [row] = await requireDb(services)
      .update(agents)
      .set({ revokedAt: services.clock() })
      .where(and(eq(agents.id, id), eq(agents.userId, session.userId)))
      .returning();
    if (row === undefined) throw httpError.notFound("Agent");
    return agentView(row);
  });

  app.post("/v1/agents/:id/rotate-key", async (request) => {
    const session = sessionOf(request);
    const { id } = parseWith(IdParams, request.params, "path");
    const minted = mintAgentKey();
    const [row] = await requireDb(services)
      .update(agents)
      .set({ apiKeyHash: minted.hash, keyHint: minted.hint })
      .where(and(eq(agents.id, id), eq(agents.userId, session.userId)))
      .returning();
    if (row === undefined) throw httpError.notFound("Agent");
    return { agent: agentView(row), api_key: minted.key };
  });
};
