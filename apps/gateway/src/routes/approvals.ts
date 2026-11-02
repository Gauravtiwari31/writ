// Human review: list, challenge, decide with a passkey (P0-6).
// Owner: money stream. Paths and auth are frozen in routes/table.ts; bodies are the named
// @writ/core/api schemas. Every route answers 501 not_implemented until the owner fills it in.
import type { FastifyPluginAsync } from "fastify";
import { notImplemented } from "../http/errors";

const OWNER = "money";

export const approvalRoutes: FastifyPluginAsync = async (app) => {
  // session → ListApprovalsResponse
  app.get("/v1/approvals", notImplemented(OWNER, "GET /v1/approvals"));
  // session → ApprovalChallengeResponse
  app.get("/v1/approvals/:id", notImplemented(OWNER, "GET /v1/approvals/:id"));
  // session → DecideApprovalResponse
  app.post("/v1/approvals/:id/decide", notImplemented(OWNER, "POST /v1/approvals/:id/decide"));
};
