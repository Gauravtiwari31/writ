// Human review: list, challenge, decide with a passkey (P0-6).
import { ApprovalStatusSchema, idSchema } from "@writ/core";
import { DecideApprovalRequestSchema } from "@writ/core/api";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { approvalChallenge, decideApproval, listApprovals } from "../approvals/index";
import { sessionOf } from "../auth/guards";
import { parseWith } from "../http/errors";

const IdParams = z.strictObject({ id: idSchema("apr") });
const ListQuery = z.strictObject({ status: ApprovalStatusSchema.optional() });

export const approvalRoutes: FastifyPluginAsync = async (app) => {
  app.get("/v1/approvals", async (request) => {
    const session = sessionOf(request);
    const query = parseWith(ListQuery, request.query, "query");
    return { approvals: await listApprovals(app.services, session.tenantId, query.status) };
  });

  app.get("/v1/approvals/:id", async (request) => {
    const session = sessionOf(request);
    const { id } = parseWith(IdParams, request.params, "path");
    return approvalChallenge(app.services, session.tenantId, session.userId, id);
  });

  app.post("/v1/approvals/:id/decide", async (request) => {
    const session = sessionOf(request);
    const { id } = parseWith(IdParams, request.params, "path");
    const body = parseWith(DecideApprovalRequestSchema, request.body);
    return decideApproval(app.services, { tenantId: session.tenantId, userId: session.userId, approvalId: id, decision: body.decision, signature: body.signature });
  });
};
