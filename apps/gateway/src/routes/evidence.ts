// Receipts and evidence packs behind capability links (P0-7).
// Owner: evidence stream. Paths and auth are frozen in routes/table.ts; bodies are the named
// @writ/core/api schemas. Every route answers 501 not_implemented until the owner fills it in.
import type { FastifyPluginAsync } from "fastify";
import { notImplemented } from "../http/errors";

const OWNER = "evidence";

export const evidenceRoutes: FastifyPluginAsync = async (app) => {
  // session → EvidenceLinkView
  app.post("/v1/evidence-links", notImplemented(OWNER, "POST /v1/evidence-links"));
  // capability-token → <token>.json → EvidencePack · <token>.pdf → application/pdf
  app.get("/v1/evidence/:file", notImplemented(OWNER, "GET /v1/evidence/:file"));
  // session → ReceiptView
  app.get("/v1/receipts/:purchaseId", notImplemented(OWNER, "GET /v1/receipts/:purchaseId"));
};
