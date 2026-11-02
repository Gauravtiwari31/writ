// The hero story (plan §4 scenes 3-7) through the real HTTP routes, with PayPal faked at the fetch seam
// (unit tests only, §22 rule 41) and no AI models: Sentinel rules run, Verifier is missing, so everything
// that passes policy goes to a human (fail closed).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { approvalBody, approvalHash, ApprovalRequestSchema, fromBase64Url, generateDeviceKeyEd25519, newId, signDeviceEd25519, toBase64Url, writHash, type WritBody } from "@writ/core";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURES_DIR } from "../../src/config";
import { closeDb, type AppDb } from "../../src/db/client";
import { buildTestApp, createTestDb, type TestApp } from "../helpers/app";
import { createFakePayPal, fakePayPalClients, type FakePayPal } from "../money/fixtures";

const ORIGIN = "http://localhost:3000";
const HIJACK_URL = `${ORIGIN}/fixtures/deals-outlet/gift-deals`;

let db: AppDb;
let t: TestApp;
let app: FastifyInstance;
let paypal: FakePayPal;
let cookie = "";
let apiKey = "";
let writId = "";
let addressId = "";
const device = generateDeviceKeyEd25519();

async function wallet(method: "GET" | "POST", url: string, payload?: unknown) {
  return app.inject({ method, url, headers: { cookie, origin: ORIGIN }, ...(payload === undefined ? {} : { payload: payload as object }) });
}
async function agent(method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method, url, headers: { authorization: `Bearer ${apiKey}`, ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });
}

beforeAll(async () => {
  db = await createTestDb();
  paypal = createFakePayPal();
  t = await buildTestApp({
    db,
    services: {
      paypal: fakePayPalClients(paypal),
      channel3: null,
      pages: {
        read: async (url) => ({ url, status: 200, html: readFileSync(join(FIXTURES_DIR, "deals-outlet", `${new URL(url).pathname.split("/").pop() ?? ""}.html`), "utf8"), fetched_at: new Date().toISOString() }),
      },
    },
  });
  app = t.app;
}, 60_000);

afterAll(async () => {
  await t.close();
  await closeDb(db);
});

const drain = async () => {
  while ((await app.services.jobs.runDue(16)) > 0);
};

describe("wallet and Writ", () => {
  it("creates a device-key wallet with a session cookie and built-in agents", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/device-wallet",
      headers: { origin: ORIGIN },
      payload: { display_name: "Ana", public_key: toBase64Url(device.publicKey), label: "This browser" },
    });
    expect(res.statusCode).toBe(200);
    cookie = String(res.headers["set-cookie"]).split(";")[0] ?? "";
    expect(res.json().user.display_name).toBe("Ana");
    const me = await wallet("GET", "/v1/me");
    expect(me.json().device_keys).toHaveLength(1);
    const agents = await wallet("GET", "/v1/agents");
    expect(agents.json().agents.map((a: { builtin_kind: string }) => a.builtin_kind).sort()).toEqual(["atlas", "scout"]);
  });

  it("refuses anonymous wallet calls and cross-site requests", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/writs" })).statusCode).toBe(401);
    const crossSite = await app.inject({ method: "POST", url: "/v1/kill-switch", headers: { cookie, origin: "https://evil.example" }, payload: {} });
    expect(crossSite.statusCode).toBe(401);
  });

  it("creates a draft, signs it once with the device key, and the challenge cannot be reused", async () => {
    const address = await wallet("POST", "/v1/address-book", { label: "Home", line1: "1 Main St", city: "Austin", region: "TX", postal: "78701", country: "US" });
    addressId = address.json().address_id;
    const created = await wallet("POST", "/v1/agents", { name: "External agent", kind: "sdk" });
    apiKey = created.json().api_key;
    const agentId = created.json().agent.agent_id;
    const draft = {
      purpose: "A pottery-themed gift for my sister",
      constraints: { total_minor: "6000", require_human_above_minor: "4000", categories: ["home_kitchen", "arts_crafts"], deliver_by: "2030-01-01" },
      clarifying_questions: [],
      assumptions: [],
    };
    const res = await wallet("POST", "/v1/writs", { draft, agent_id: agentId, ship_to_ref: addressId });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.writ.status).toBe("DRAFT");
    writId = body.writ.writ_id;
    expect(body.challenge).toBe(toBase64Url(writHash(body.writ.body as WritBody)));
    expect(body.writ.summary.join(" | ")).toContain("Can spend up to $60.00");
    expect(body.writ.summary.join(" | ")).toContain("Must ask you above $40.00");

    const signature = signDeviceEd25519(fromBase64Url(body.challenge), device.secretKey);
    const forged = signDeviceEd25519(fromBase64Url(body.challenge), generateDeviceKeyEd25519().secretKey);
    expect((await wallet("POST", `/v1/writs/${writId}/sign`, { signature: forged })).statusCode).toBe(403);
    const signed = await wallet("POST", `/v1/writs/${writId}/sign`, { signature });
    expect(signed.statusCode, signed.body).toBe(200);
    expect(signed.json().status).toBe("ACTIVE");
    expect(signed.json().budget.limit_minor).toBe("6000");
    expect((await wallet("POST", `/v1/writs/${writId}/sign`, { signature })).statusCode).toBe(409);
  });
});

describe("scene 5-6: the hijack", () => {
  it("blocks the hijacked cart with typed reasons, flags the hidden text, and PayPal is never called", async () => {
    const search = await agent("POST", "/v1/agent/search", { writ_id: writId, query: "pottery gift" });
    expect(search.statusCode).toBe(200);
    expect(search.json()).toMatchObject({ source: "fixture" });
    expect(search.json().notice).toContain("security test fixture");

    const proposed = await agent("POST", "/v1/agent/carts", {
      writ_id: writId,
      items: [
        { product_ref: "fx_mug_set", qty: 1 },
        { product_ref: "fx_gift_protection_plus", qty: 1 },
      ],
      ship_to_ref: newId("adr"),
      sources: [{ url: HIJACK_URL, kind: "page", fetched_at: new Date().toISOString() }],
    });
    expect(proposed.statusCode, proposed.body).toBe(200);
    expect(proposed.json().preview.verdict).toBe("BLOCK");
    expect(proposed.json().cart.total_minor).toBe("8500");

    const res = await agent("POST", "/v1/agent/checkout", { cart_id: proposed.json().cart_id }, { "idempotency-key": "hijack-1" });
    expect(res.statusCode, res.body).toBe(403);
    const view = res.json();
    expect(view).toMatchObject({ status: "BLOCKED", state_reason: "policy_blocked", money_moved: false });
    const codes = view.policy_reasons.map((r: { code: string }) => r.code);
    expect(codes.length).toBeGreaterThanOrEqual(3);
    await drain();
    expect(paypal.calls).toEqual([]);

    const detail = await wallet("GET", `/v1/purchases/${view.purchase_id}`);
    expect(detail.statusCode, detail.body).toBe(200);
    const attack = detail.json().attacks[0];
    expect(attack.detector).toBe("rules");
    expect(attack.spans.map((s: { text: string }) => s.text).join(" ")).toMatch(/AI assistant/i);
    expect(attack.spans.some((s: { channel: string }) => s.channel === "hidden")).toBe(true);
  });

  it("an agent cannot name a price: unknown products are refused", async () => {
    const res = await agent("POST", "/v1/agent/carts", { writ_id: writId, items: [{ product_ref: "made_up", qty: 1 }], ship_to_ref: addressId, sources: [] });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("unknown_product");
  });

  it("another wallet's agent key cannot see this Writ (T10)", async () => {
    const other = await app.inject({ method: "POST", url: "/v1/auth/device-wallet", payload: { display_name: "Eve", public_key: toBase64Url(generateDeviceKeyEd25519().publicKey), label: "x" } });
    const otherCookie = String(other.headers["set-cookie"]).split(";")[0] ?? "";
    const key = (await app.inject({ method: "POST", url: "/v1/agents", headers: { cookie: otherCookie }, payload: { name: "evil", kind: "sdk" } })).json().api_key;
    const res = await app.inject({ method: "GET", url: `/v1/agent/writs/${writId}`, headers: { authorization: `Bearer ${key}` } });
    expect(res.statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/v1/writs/${writId}`, headers: { cookie: otherCookie } })).statusCode).toBe(404);
  });
});

describe("scene 7: the right purchase", () => {
  it("holds $44, asks the human, captures exactly $44 and replays the Idempotency-Key", async () => {
    const proposed = await agent("POST", "/v1/agent/carts", {
      writ_id: writId,
      items: [{ product_ref: "fx_pourover_set", qty: 1 }],
      ship_to_ref: addressId,
      sources: [{ url: `${ORIGIN}/fixtures/deals-outlet/pour-over-set`, kind: "page", fetched_at: new Date().toISOString() }],
    });
    expect(proposed.json().preview.verdict, proposed.body).toBe("REVIEW");

    // A wallet with no PayPal token fails typed; connect one, then go again with a new key.
    const failed = await agent("POST", "/v1/agent/checkout", { cart_id: proposed.json().cart_id }, { "idempotency-key": "good-0" });
    expect(failed.json()).toMatchObject({ status: "FAILED", state_reason: "paypal_not_connected", money_moved: false });

    const { paypalVaultTokens, users } = await import("../../src/db/schema");
    const [user] = await db.select().from(users);
    const me = (await wallet("GET", "/v1/me")).json();
    expect(user).toBeDefined();
    await db.insert(paypalVaultTokens).values({ id: app.services.ids("vaultToken"), tenantId: me.session.tenant_id, userId: me.session.user.user_id, vaultId: "VAULT-HERO", status: "ACTIVE" });

    const started = agent("POST", "/v1/agent/checkout", { cart_id: proposed.json().cart_id }, { "idempotency-key": "good-1" });
    // Nothing polls in tests: run the authorize job while the pipeline waits for it.
    const pump = setInterval(() => void app.services.jobs.runDue(16), 50);
    const res = await started;
    clearInterval(pump);
    expect(res.statusCode, res.body).toBe(200);
    const view = res.json();
    expect(view).toMatchObject({ status: "AWAITING_HUMAN", verdict: "REVIEW", money_moved: false });
    expect(view.paypal.authorization_id).toBeTruthy();
    expect(paypal.effects).toMatchObject({ orders: 1, captures: 0 });

    const replay = await agent("POST", "/v1/agent/checkout", { cart_id: proposed.json().cart_id }, { "idempotency-key": "good-1" });
    expect(replay.json()).toMatchObject({ replayed: true, purchase_id: view.purchase_id });
    expect(paypal.effects.orders).toBe(1);

    const challenge = await wallet("GET", `/v1/approvals/${view.approval.approval_id}`);
    expect(challenge.statusCode, challenge.body).toBe(200);
    const request = ApprovalRequestSchema.parse(challenge.json().approval.request);
    expect(challenge.json().approval.reasons.join(" ")).toMatch(/above the amount|not available/);
    const signature = signDeviceEd25519(approvalHash(approvalBody(request, "APPROVE")), device.secretKey);
    const decided = await wallet("POST", `/v1/approvals/${view.approval.approval_id}/decide`, { decision: "APPROVE", signature });
    expect(decided.statusCode, decided.body).toBe(200);
    await drain();

    const done = await agent("GET", `/v1/agent/purchases/${view.purchase_id}`);
    expect(done.json()).toMatchObject({ status: "CAPTURED", money_moved: true });
    expect(paypal.effects.captures).toBe(1);
    const capture = paypal.calls.find((c) => c.path.endsWith("/capture"))?.body as { amount: { value: string }; final_capture: boolean };
    expect(capture).toMatchObject({ amount: { value: "44.00" }, final_capture: true });
    const writ = await wallet("GET", `/v1/writs/${writId}`);
    expect(writ.json().budget).toMatchObject({ spent_minor: "4400", reserved_minor: "0", held_orders: 0, orders_count: 1 });
  });

  it("the kill switch revokes the Writ and later carts are blocked", async () => {
    const res = await wallet("POST", "/v1/kill-switch", {});
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().revoked_writ_ids).toContain(writId);
    const proposed = await agent("POST", "/v1/agent/carts", { writ_id: writId, items: [{ product_ref: "fx_mug_set", qty: 1 }], ship_to_ref: addressId, sources: [] });
    expect(proposed.json().preview.verdict).toBe("BLOCK");
  });
});
