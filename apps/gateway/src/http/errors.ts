// One error envelope for every route (ApiError in @writ/core/api): { error, message, details? }.
// Handlers throw HttpError (or let a ZodError / NotImplementedError escape); the root error handler
// maps it. 5xx answers never carry stack traces, SQL or secrets.
//
// FROZEN for the parallel build (docs/ARCHITECTURE.md).
import { isNotImplementedError } from "@writ/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";

export class HttpError extends Error {
  override readonly name = "HttpError";
  constructor(
    readonly status: number,
    /** Stable code from API_ERROR_CODES (or a route-specific one documented in the route table). */
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const httpError = {
  badRequest: (code: string, message: string, details?: unknown) => new HttpError(400, code, message, details),
  unauthorized: (message = "Sign in first.") => new HttpError(401, "unauthorized", message),
  forbidden: (message = "You are not allowed to do that.") => new HttpError(403, "forbidden", message),
  notFound: (what = "Resource") => new HttpError(404, "not_found", `${what} not found.`),
  conflict: (code: string, message: string) => new HttpError(409, code, message),
  tooManyRequests: (message: string) => new HttpError(429, "rate_limited", message),
  unavailable: (code: string, message: string) => new HttpError(503, code, message),
};

/** Zod-parse a request part (§22 rule 27: Zod at every boundary); failure → 400 invalid_request with issue paths. */
export function parseWith<S extends z.ZodType>(schema: S, value: unknown, what = "request body"): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues.slice(0, 20).map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message }));
  throw new HttpError(400, "invalid_request", `Invalid ${what}.`, issues);
}

/** Handler for a route its owning stream has not implemented yet: 501 with the owner, never a fake answer. */
export function notImplemented(owner: string, route: string) {
  return async (_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> =>
    reply.code(501).send({
      error: "not_implemented",
      message: `${route} is not implemented yet (owner: ${owner} stream).`,
      details: { owner, route },
    });
}

interface StatusError {
  statusCode?: number;
  validation?: unknown;
  message?: string;
}

export function installErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler(async (error: unknown, request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.status).send({
        error: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      });
    }
    if (isNotImplementedError(error)) {
      return reply.code(501).send({ error: "not_implemented", message: error.message, details: { owner: error.owner, feature: error.feature } });
    }
    const status = typeof error === "object" && error !== null ? (error as StatusError).statusCode : undefined;
    if (status !== undefined && status >= 400 && status < 500) {
      // Fastify's own client errors: malformed JSON, unsupported media type, body too large, ...
      const message = typeof (error as StatusError).message === "string" ? (error as StatusError).message : "Invalid request.";
      return reply.code(status).send({ error: status === 429 ? "rate_limited" : "invalid_request", message });
    }
    request.log.error({ err: error }, "unhandled error");
    return reply.code(500).send({ error: "internal_error", message: "Something went wrong on our side." });
  });
  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ error: "not_found", message: "No such route." }));
}
