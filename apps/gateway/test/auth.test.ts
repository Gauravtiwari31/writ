// Sessions (HMAC cookie, plan decision 5), the CSRF Origin guard, agent keys and the guards every
// stream uses (sessionOf, judgeSessionOf, agentOf).
import { newId, sha256 } from "@writ/core";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findAgentByKey, hashAgentKey, mintAgentKey, parseBearer } from "../src/auth/agent-keys";
import { agentOf, judgeSessionOf, originAllowed, sessionOf } from "../src/auth/guards";
import { decodeSession, encodeSession, type SessionClaims } from "../src/auth/session";
import { closeDb, type AppDb } from "../src/db/client";
import { newRowId } from "../src/db/ids";
import { agents, users } from "../src/db/schema";
import { buildTestApp, createTestDb, type TestApp } from "./helpers/app";

const SECRET = new TextEncoder().encode("k".repeat(40));
const NOW = 1_793_000_000;

function claims(overrides: Partial<SessionClaims> = {}): SessionClaims {
  return { userId: newId("usr"), tenantId: "tn_test", kind: "user", issuedAt: NOW, expiresAt: NOW + 3600, ...overrides };
}

describe("session token", () => {
  it("round-trips and rejects tampering, other keys and expiry", () => {
    const c = claims();
    const token = encodeSession(c, SECRET);
    expect(decodeSession(token, SECRET, NOW + 1)).toEqual(c);
    expect(decodeSession(token, new TextEncoder().encode("j".repeat(40)), NOW + 1)).toBeNull();
    expect(decodeSession(token, SECRET, NOW + 3600)).toBeNull();
    const [payload, mac] = token.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ v: 1, uid: c.userId, tid: "tn_other", k: "user", iat: NOW, exp: NOW + 3600 })).toString("base64url");
    expect(decodeSession(`${forged}.${mac}`, SECRET, NOW + 1)).toBeNull();
    expect(decodeSession(`${payload}.${mac}x`, SECRET, NOW + 1)).toBeNull();
    for (const junk of ["", ".", "a.b.c", "x".repeat(2000), `${payload}.`]) expect(decodeSession(junk, SECRET, NOW)).toBeNull();
  });

  it("refuses a token issued in the future and a malformed payload even with a valid MAC", () => {
    expect(decodeSession(encodeSession(claims({ issuedAt: NOW + 3600, expiresAt: NOW + 7200 }), SECRET), SECRET, NOW)).toBeNull();
    expect(decodeSession(encodeSession(claims({ userId: "usr_bad" }), SECRET), SECRET, NOW)).toBeNull();
  });

  it("applies the Origin guard only to unsafe browser requests", () => {
    expect(originAllowed("GET", "https://evil.example", "https://writ-web.onrender.com")).toBe(true);
    expect(originAllowed("POST", undefined, "https://writ-web.onrender.com")).toBe(true);
    expect(originAllowed("POST", "https://writ-web.onrender.com", "https://writ-web.onrender.com")).toBe(true);
    expect(originAllowed("POST", "https://evil.example", "https://writ-web.onrender.com")).toBe(false);
    expect(originAllowed("POST", "https://evil.example", null)).toBe(false);
  });
});

describe("agent keys", () => {
  it("mints wak_ keys, stores only sha256, and parses bearer headers strictly", () => {
    const minted = mintAgentKey();
    expect(minted.key).toMatch(/^wak_[A-Za-z0-9_-]{43}$/);
    expect(minted.hash).toEqual(sha256(minted.key));
    expect(hashAgentKey(minted.key)).toEqual(minted.hash);
    expect(minted.hint).toBe(minted.key.slice(-4));
    expect(mintAgentKey().key).not.toBe(minted.key);
    expect(parseBearer(`Bearer ${minted.key}`)).toBe(minted.key);
    expect(parseBearer(`bearer   ${minted.key}`)).toBe(minted.key);
    for (const bad of [undefined, "", minted.key, "Bearer sk_live_123", `Basic ${minted.key}`, `Bearer ${minted.key} extra`]) {
      expect(parseBearer(bad), String(bad)).toBeNull();
    }
  });
});

describe("guards on a running app", () => {
  let db: AppDb;
  let t: TestApp;
  const userId = newRowId("user");
  const tenantId = newRowId("tenant");
  const key = mintAgentKey();
  const revokedKey = mintAgentKey();

  beforeAll(async () => {
    db = await createTestDb();
    await db.insert(users).values({ id: userId, tenantId, displayName: "Ana" });
    await db.insert(agents).values([
      { id: newRowId("agent"), tenantId, userId, name: "SDK agent", kind: "sdk", apiKeyHash: key.hash, keyHint: key.hint },
      { id: newRowId("agent"), tenantId, userId, name: "Old", kind: "sdk", apiKeyHash: revokedKey.hash, revokedAt: new Date() },
    ]);
    // Test-only routes exercising the guards the way stream routes do.
    t = await buildTestApp({
      db,
      beforeReady: (app: FastifyInstance) => {
        app.get("/__t/session", async (request) => sessionOf(request));
        app.post("/__t/session", async (request) => sessionOf(request));
        app.get("/__t/judge", async (request) => judgeSessionOf(request));
        app.get("/__t/agent", async (request) => agentOf(request));
        app.post("/__t/login", async (request, reply) => {
          const { kind } = request.body as { kind: "user" | "judge" };
          return app.services.sessions.issue(reply, { userId, tenantId, kind });
        });
      },
    });
  });

  afterAll(async () => {
    await t.close();
    await closeDb(db);
  });

  async function login(kind: "user" | "judge"): Promise<string> {
    const res = await t.app.inject({ method: "POST", url: "/__t/login", payload: { kind } });
    const cookie = res.cookies.find((c) => c.name === "writ_session");
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
    return `writ_session=${cookie?.value ?? ""}`;
  }

  it("401s without a session and returns the claims with one", async () => {
    expect((await t.app.inject({ method: "GET", url: "/__t/session" })).json()).toMatchObject({ error: "unauthorized" });
    const cookie = await login("user");
    const res = await t.app.inject({ method: "GET", url: "/__t/session", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ userId, tenantId, kind: "user" });
  });

  it("ignores a session on unsafe cross-origin requests (CSRF) but not same-origin ones", async () => {
    const cookie = await login("user");
    const cross = await t.app.inject({ method: "POST", url: "/__t/session", headers: { cookie, origin: "https://evil.example" } });
    expect(cross.statusCode).toBe(401);
    const same = await t.app.inject({ method: "POST", url: "/__t/session", headers: { cookie, origin: "http://localhost:3000" } });
    expect(same.statusCode).toBe(200);
  });

  it("limits judge routes to judge sessions", async () => {
    expect((await t.app.inject({ method: "GET", url: "/__t/judge", headers: { cookie: await login("user") } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: "GET", url: "/__t/judge", headers: { cookie: await login("judge") } })).statusCode).toBe(200);
  });

  it("authenticates agents by key hash, never by anything the request claims", async () => {
    const ok = await t.app.inject({ method: "GET", url: "/__t/agent", headers: { authorization: `Bearer ${key.key}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ tenantId, userId, kind: "sdk", builtinKind: null });
    for (const header of [undefined, `Bearer ${revokedKey.key}`, `Bearer ${mintAgentKey().key}`]) {
      const res = await t.app.inject({ method: "GET", url: "/__t/agent", headers: header === undefined ? {} : { authorization: header } });
      expect(res.statusCode, String(header)).toBe(401);
    }
    expect(await findAgentByKey(db, revokedKey.key)).toBeNull();
  });
});
