// AG Studio console data (P0-11). The AI harness proxy needs spike S4 (a license and a provider that speaks
// the Responses API), so it answers a clear 503 rather than pretending to be connected.
import { ConsoleDatasetNameSchema, ConsoleQueryRequestSchema } from "@writ/core/api";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { sessionOf } from "../auth/guards";
import { datasetRows, runQuery } from "../console/index";
import { requireDb } from "../deps";
import { httpError, parseWith } from "../http/errors";

const DatasetParams = z.strictObject({ name: ConsoleDatasetNameSchema });

export const consoleRoutes: FastifyPluginAsync = async (app) => {
  const services = app.services;

  app.get("/api/console/datasets/:name", async (request) => {
    const session = sessionOf(request);
    const { name } = parseWith(DatasetParams, request.params, "path");
    return { name, rows: await datasetRows(requireDb(services), session.tenantId, name), generated_at: services.clock().toISOString() };
  });

  app.post("/api/console/query", async (request) => {
    const session = sessionOf(request);
    const query = parseWith(ConsoleQueryRequestSchema, request.body);
    const rows = runQuery(await datasetRows(requireDb(services), session.tenantId, query.dataset), query);
    return { dataset: query.dataset, rows, row_count: rows.length };
  });

  app.post("/api/ai/studio", async (request) => {
    sessionOf(request);
    throw httpError.unavailable("ai_unavailable", "The console's AI harness is not connected yet: it needs the AG Studio trial license and a provider chosen in spike S4.");
  });
};
