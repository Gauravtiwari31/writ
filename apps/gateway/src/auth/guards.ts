// Request authentication for route handlers:
//   sessionOf(request)       Wallet/console routes (cookie); 401 without a valid session.
//   judgeSessionOf(request)  judge-mode routes; 403 for a normal wallet session.
//   await agentOf(request)   agent API routes (Bearer wak_...); 401 for a missing/revoked key.
// Every query a handler runs must be scoped to the returned tenant id (plan decision 5).
//
// The session hook also applies a CSRF guard on top of SameSite=Lax: an unsafe request whose
// Origin header names another site is treated as anonymous.
//
// FROZEN for the parallel build (docs/ARCHITECTURE.md).
import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireDb } from "../deps";
import { findAgentByKey, parseBearer, type AgentPrincipal } from "./agent-keys";
import type { SessionClaims, SessionManager } from "./session";
import { httpError } from "../http/errors";

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the session hook for a valid cookie (and, on unsafe methods, an allowed Origin). */
    session: SessionClaims | null;
    /** Cached by agentOf(). */
    agent: AgentPrincipal | null;
  }
}

/** Unsafe requests from a browser must come from the Wallet origin; requests without Origin (curl, agents) pass. */
export function originAllowed(method: string, origin: string | undefined, appOrigin: string | null): boolean {
  if (SAFE_METHODS.has(method) || origin === undefined) return true;
  return appOrigin !== null && origin === appOrigin;
}

export function installAuthHooks(app: FastifyInstance, deps: { sessions: SessionManager; appOrigin: string | null }): void {
  app.decorateRequest("session", null);
  app.decorateRequest("agent", null);
  app.addHook("onRequest", async (request) => {
    const claims = deps.sessions.read(request);
    if (claims === null) return;
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
    if (!originAllowed(request.method, origin, deps.appOrigin)) {
      request.log.warn({ origin }, "session ignored: unsafe request from another origin");
      return;
    }
    request.session = claims;
  });
}

export function sessionOf(request: FastifyRequest): SessionClaims {
  if (request.session === null) throw httpError.unauthorized();
  return request.session;
}

export function judgeSessionOf(request: FastifyRequest): SessionClaims {
  const session = sessionOf(request);
  if (session.kind !== "judge") throw httpError.forbidden("This route is for judge-mode sessions only.");
  return session;
}

export async function agentOf(request: FastifyRequest): Promise<AgentPrincipal> {
  if (request.agent !== null) return request.agent;
  const key = parseBearer(request.headers.authorization);
  if (key === null) throw httpError.unauthorized("Send Authorization: Bearer <agent key>.");
  const agent = await findAgentByKey(requireDb(request.server.services), key);
  if (agent === null) throw httpError.unauthorized("Unknown or revoked agent key.");
  request.agent = agent;
  return agent;
}
