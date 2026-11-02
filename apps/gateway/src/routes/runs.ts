// Built-in agent runs started from the Wallet (P0-3): delegate to services.runs.
import { RunIdSchema, StartRunRequestSchema } from "@writ/core/api";
import { desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { sessionOf } from "../auth/guards";
import { agentRuns } from "../db/schema";
import { requireDb } from "../deps";
import { parseWith } from "../http/errors";
import { runDetail, runView } from "../runs/index";

const IdParams = z.strictObject({ id: RunIdSchema });

export const runRoutes: FastifyPluginAsync = async (app) => {
  const services = app.services;

  app.post("/v1/runs", async (request, reply) => {
    const session = sessionOf(request);
    const body = parseWith(StartRunRequestSchema, request.body);
    const run = await services.runs.start({
      tenantId: session.tenantId,
      userId: session.userId,
      agentKind: body.agent,
      writId: body.writ_id,
      mode: "manual",
      ...(body.goal === undefined ? {} : { goal: body.goal }),
    });
    return reply.code(202).send(run);
  });

  app.get("/v1/runs", async (request) => {
    const session = sessionOf(request);
    const rows = await requireDb(services).select().from(agentRuns).where(eq(agentRuns.tenantId, session.tenantId)).orderBy(desc(agentRuns.createdAt)).limit(200);
    return { runs: rows.map(runView) };
  });

  app.get("/v1/runs/:id", async (request) => {
    const session = sessionOf(request);
    const { id } = parseWith(IdParams, request.params, "path");
    return runDetail(requireDb(services), session.tenantId, id);
  });

  app.post("/v1/runs/:id/stop", async (request) => {
    const session = sessionOf(request);
    const { id } = parseWith(IdParams, request.params, "path");
    return services.runs.stop({ tenantId: session.tenantId, runId: id });
  });
};
