// Purchases for the Wallet and console (P0-4).
// Owner: api stream. Paths and auth are frozen in routes/table.ts; bodies are the named
// @writ/core/api schemas. Every route answers 501 not_implemented until the owner fills it in.
import type { FastifyPluginAsync } from "fastify";
import { notImplemented } from "../http/errors";

const OWNER = "api";

export const purchaseRoutes: FastifyPluginAsync = async (app) => {
  // session → ListPurchasesResponse
  app.get("/v1/purchases", notImplemented(OWNER, "GET /v1/purchases"));
  // session → PurchaseDetailResponse
  app.get("/v1/purchases/:id", notImplemented(OWNER, "GET /v1/purchases/:id"));
};
