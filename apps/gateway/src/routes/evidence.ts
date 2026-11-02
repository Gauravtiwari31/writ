// Evidence links, capability-token evidence and receipts (P0-7).
import { idSchema } from "@writ/core";
import { CreateEvidenceLinkRequestSchema } from "@writ/core/api";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { sessionOf } from "../auth/guards";
import { assemblePack, createEvidenceLink, evidencePdf, receipt, resolveEvidenceToken } from "../evidence/index";
import { httpError, parseWith } from "../http/errors";

const FileParams = z.strictObject({ file: z.string().regex(/^[A-Za-z0-9_-]{43}\.(json|pdf)$/) });
const ReceiptParams = z.strictObject({ purchaseId: idSchema("pur") });

export const evidenceRoutes: FastifyPluginAsync = async (app) => {
  const services = app.services;

  app.post("/v1/evidence-links", async (request) => {
    const session = sessionOf(request);
    const body = parseWith(CreateEvidenceLinkRequestSchema, request.body);
    return createEvidenceLink(services, session.tenantId, body.purchase_id);
  });

  app.get("/v1/evidence/:file", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    const parsed = FileParams.safeParse(request.params);
    if (!parsed.success) throw httpError.notFound("Evidence");
    const [token, extension] = parsed.data.file.split(".") as [string, "json" | "pdf"];
    const { tenantId, purchaseId } = await resolveEvidenceToken(services, token);
    const assembled = await assemblePack(services, tenantId, purchaseId);
    if (assembled === null) throw httpError.notFound("Evidence");
    void reply.header("cache-control", "no-store").header("x-robots-tag", "noindex");
    if (extension === "json") return { pack: assembled.pack, verification: assembled.verification };
    const pdf = await evidencePdf(assembled.pack, assembled.verification);
    return reply.type("application/pdf").header("content-disposition", `attachment; filename="writ-evidence-${purchaseId}.pdf"`).send(Buffer.from(pdf));
  });

  app.get("/v1/receipts/:purchaseId", async (request) => {
    const session = sessionOf(request);
    const { purchaseId } = parseWith(ReceiptParams, request.params, "path");
    return receipt(services, session.tenantId, purchaseId);
  });
};
