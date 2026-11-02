// Wallet sessions (plan decision 5): a stateless, HMAC-SHA256-signed, HttpOnly, SameSite=Lax cookie
// carrying user_id + tenant_id + kind + issued-at + expiry. The browser only ever talks to the
// Wallet origin (Next.js rewrites /gw/* to the gateway), so the cookie is first-party there.
// SESSION_SECRET is required in production; development generates an ephemeral key (config.ts).
//
// FROZEN for the parallel build (docs/ARCHITECTURE.md): routes use sessionOf()/judgeSessionOf()
// from guards.ts and SessionManager.issue()/clear(); nobody parses the cookie by hand.
import { createHmac, timingSafeEqual } from "node:crypto";
import { fromBase64Url, idSchema, toBase64Url, utf8 } from "@writ/core";
import { SessionKindSchema, TenantIdSchema, type SessionKind } from "@writ/core/api";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { SessionConfig } from "../config";

export interface SessionClaims {
  readonly userId: string;
  readonly tenantId: string;
  readonly kind: SessionKind;
  /** Unix seconds. */
  readonly issuedAt: number;
  /** Unix seconds. */
  readonly expiresAt: number;
}

const PayloadSchema = z.strictObject({
  v: z.literal(1),
  uid: idSchema("usr"),
  tid: TenantIdSchema,
  k: SessionKindSchema,
  iat: z.int().min(0),
  exp: z.int().min(1),
});

const MAX_TOKEN_CHARS = 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

function mac(secret: Uint8Array, payload: string): Uint8Array {
  return new Uint8Array(createHmac("sha256", secret).update(payload).digest());
}

export function encodeSession(claims: SessionClaims, secret: Uint8Array): string {
  const payload = toBase64Url(
    utf8(JSON.stringify({ v: 1, uid: claims.userId, tid: claims.tenantId, k: claims.kind, iat: claims.issuedAt, exp: claims.expiresAt })),
  );
  return `${payload}.${toBase64Url(mac(secret, payload))}`;
}

/** null for anything but an intact, unexpired token signed with `secret`. Never throws. */
export function decodeSession(token: string, secret: Uint8Array, nowSeconds: number): SessionClaims | null {
  try {
    if (token.length > MAX_TOKEN_CHARS) return null;
    const dot = token.indexOf(".");
    if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
    const payload = token.slice(0, dot);
    const given = fromBase64Url(token.slice(dot + 1));
    const expected = mac(secret, payload);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const parsed = PayloadSchema.safeParse(JSON.parse(decoder.decode(fromBase64Url(payload))));
    if (!parsed.success || parsed.data.exp <= nowSeconds || parsed.data.iat > nowSeconds + 300) return null;
    return { userId: parsed.data.uid, tenantId: parsed.data.tid, kind: parsed.data.k, issuedAt: parsed.data.iat, expiresAt: parsed.data.exp };
  } catch {
    return null;
  }
}

export interface IssueSessionInput {
  userId: string;
  tenantId: string;
  kind: SessionKind;
}

export interface SessionManager {
  /** Sets the cookie on `reply` and returns the claims (TTL: 7 days for wallets, 24 h for judge visitors). */
  issue(reply: FastifyReply, input: IssueSessionInput): SessionClaims;
  /** The cookie's claims, or null. Prefer request.session / sessionOf(): they also apply the Origin check. */
  read(request: FastifyRequest): SessionClaims | null;
  clear(reply: FastifyReply): void;
}

export interface SessionManagerDeps {
  session: SessionConfig;
  secret: Uint8Array;
  clock: () => Date;
}

export function createSessionManager({ session, secret, clock }: SessionManagerDeps): SessionManager {
  const nowSeconds = () => Math.floor(clock().getTime() / 1000);
  const cookieOptions = { httpOnly: true, sameSite: "lax", secure: session.secure, path: "/" } as const;
  return {
    issue(reply, input) {
      const issuedAt = nowSeconds();
      const ttl = input.kind === "judge" ? session.judgeTtlSeconds : session.ttlSeconds;
      const claims: SessionClaims = { ...input, issuedAt, expiresAt: issuedAt + ttl };
      void reply.setCookie(session.cookieName, encodeSession(claims, secret), { ...cookieOptions, maxAge: ttl });
      return claims;
    },
    read(request) {
      const token = request.cookies[session.cookieName];
      return token === undefined ? null : decodeSession(token, secret, nowSeconds());
    },
    clear(reply) {
      void reply.clearCookie(session.cookieName, cookieOptions);
    },
  };
}
