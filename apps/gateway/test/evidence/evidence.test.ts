// P0-7, P0-9, P0-13: evidence packs that really verify, capability links, disputes that re-fetch before
// acting and never auto-execute without confidence, and judge-mode isolation. PayPal is faked at the fetch
// seam (unit tests only, §22 rule 41).
import { approvalBody, approvalHash, ApprovalRequestSchema, generateDeviceKeyEd25519, parseInvoiceId, POLICY_VERSION, signDeviceEd25519, type PolicyDecision } from "@writ/core";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvalDecide } from "./helpers";
import { closeDb, type AppDb } from "../../src/db/client";
import { disputes, purchases, webhookEvents } from "../../src/db/schema";
import { assemblePack, evidencePdf } from "../../src/evidence/index";
import { buildTestApp, createTestDb, type TestApp } from "../helpers/app";
import { createFakePayPal, fakePayPalClients, seedCart, seedWrit, storeVerification, type FakePayPal, type Seeded } from "../money/fixtures";

let db: AppDb;
let t: TestApp;
let app: FastifyInstance;
let paypal: FakePayPal;

const policy = (amount: bigint): PolicyDecision => ({ policy_version: POLICY_VERSION, verdict: "APPROVE", amount_minor: amount.toString(), checks: [], reasons: [] });

beforeAll(async () => {
  db = await createTestDb();
  paypal = createFakePayPal();
  t = await buildTestApp({ db, env: { JUDGE_MODE: "true", DEMO_HERO_RUNS_PER_HOUR: "2" }, services: { paypal: fakePayPalClients(paypal), channel3: null } });
  app = t.app;
}, 60_000);

afterAll(async () => {
  await t.close();
  await closeDb(db);
});

const drain = async () => {
  while ((await app.services.jobs.runDue(16)) > 0);
};

async function captured(seeded: Seeded, final: "APPROVE" | "REVIEW" = "APPROVE") {
  const services = app.services;
  const { cartId, hash, cart } = await seedCart(db, seeded);
  const { purchase } = await services.saga.open({ tenantId: seeded.tenantId, writId: seeded.writId, cartId, agentId: seeded.agentId, idempotencyKey: `k-${cartId}`, amountMinor: 4400n, currency: "USD" });
  const decision = policy(4400n);
  const { decisions } = await import("../../src/db/schema");
  const { policyDecisionHash } = await import("@writ/core");
  await db.insert(decisions).values({ id: services.ids("decision"), tenantId: seeded.tenantId, cartId, purchaseId: purchase.purchaseId, stage: "policy", verdict: "APPROVE", output: decision, outputHash: policyDecisionHash(decision) });
  await services.saga.reserveAndAuthorize({ tenantId: seeded.tenantId, purchaseId: purchase.purchaseId, policy: decision, waitMs: 0 });
  await drain();
  const verifying = await services.saga.beginVerification({ tenantId: seeded.tenantId, purchaseId: purchase.purchaseId });
  const { record, decisionId } = await storeVerification(db, { tenantId: seeded.tenantId, purchaseId: purchase.purchaseId, cartId, cartHash: hash, cPre: verifying.cPre as string, final });
  await services.saga.execute({ tenantId: seeded.tenantId, purchaseId: purchase.purchaseId, verification: record, decisionId, waitMs: 0 });
  await drain();
  return { purchaseId: purchase.purchaseId, cart };
}

describe("evidence pack", () => {
  it("assembled from stored records, every commitment recomputes", async () => {
    const seeded = await seedWrit(db);
    const { purchaseId } = await captured(seeded);
    const assembled = await assemblePack(app.services, seeded.tenantId, purchaseId);
    expect(assembled).not.toBeNull();
    const failures = assembled?.verification.checks.filter((check) => check.status === "FAIL") ?? [];
    expect(failures, JSON.stringify(failures)).toEqual([]);
    const capture = paypal.calls.filter((c) => c.path.endsWith("/capture")).at(-1)?.body as { invoice_id: string };
    expect(assembled?.pack.commitments.c_post?.slice(0, 40)).toBe(parseInvoiceId(capture.invoice_id)?.cPostPrefix);
  });

  it("binds the signed approval into C_post when a human decided", async () => {
    const seeded = await seedWrit(db);
    const { purchaseId } = await captured(seeded, "REVIEW");
    const { approvals } = await import("../../src/db/schema");
    const [approval] = await db.select().from(approvals).where(eq(approvals.purchaseId, purchaseId));
    const request = ApprovalRequestSchema.parse(approval?.request);
    const signature = signDeviceEd25519(approvalHash(approvalBody(request, "APPROVE")), seeded.deviceSecret);
    await approvalDecide(app.services, seeded, approval?.id as string, signature);
    await drain();
    const assembled = await assemblePack(app.services, seeded.tenantId, purchaseId);
    const failures = assembled?.verification.checks.filter((check) => check.status === "FAIL") ?? [];
    expect(failures, JSON.stringify(failures)).toEqual([]);
    expect(assembled?.verification.checks.find((check) => check.name === "h_approval")?.status).toBe("PASS");
  });

  it("makes a PDF even when the title has characters the PDF font cannot encode", async () => {
    const seeded = await seedWrit(db);
    const { purchaseId } = await captured(seeded);
    const assembled = await assemblePack(app.services, seeded.tenantId, purchaseId);
    if (assembled === null) throw new Error("no pack");
    (assembled.pack.writ.body as { purpose: string }).purpose = "Teacup 🍵 for Zoë ‖ 陶器";
    const pdf = await evidencePdf(assembled.pack, assembled.verification);
    expect(Buffer.from(pdf.subarray(0, 5)).toString()).toBe("%PDF-");
  });
});

describe("disputes", () => {
  const OLD_FETCH_OK = (disputeBody: unknown) => {
    const inner = paypal.fetch;
    const calls: string[] = [];
    return {
      calls,
      clients: fakePayPalClients({
        ...paypal,
        fetch: async (url, init) => {
          const path = new URL(url).pathname;
          if (path.startsWith("/v1/customer/disputes/")) {
            calls.push(`${init.method ?? "GET"} ${path}`);
            return new Response(JSON.stringify((init.method ?? "GET") === "GET" ? disputeBody : { links: [] }), { status: 200, headers: { "content-type": "application/json", "paypal-debug-id": "dbg" } });
          }
          return inner(url, init);
        },
      }),
    };
  };

  it("a webhook re-fetches the dispute, marks the purchase, and with no analyst waits for a human", async () => {
    const seeded = await seedWrit(db);
    const { purchaseId } = await captured(seeded);
    const [row] = await db.select().from(purchases).where(eq(purchases.id, purchaseId));
    const dispute = { dispute_id: "PP-D-1", status: "OPEN", reason: "UNAUTHORISED", dispute_life_cycle_stage: "INQUIRY", dispute_amount: { currency_code: "USD", value: "44.00" }, disputed_transactions: [{ seller_transaction_id: row?.captureId }], links: [] };
    const fake = OLD_FETCH_OK(dispute);
    const test = await buildTestApp({ db, services: { paypal: fake.clients } });
    try {
      const { durableWebhookDedupe } = await import("../../src/webhooks/index");
      await durableWebhookDedupe(test.app.services).add("WH-D-1", { id: "WH-D-1", event_type: "CUSTOMER.DISPUTE.CREATED", resource_type: "dispute", resource: { dispute_id: "PP-D-1" } } as never);
      while ((await test.app.services.jobs.runDue(16)) > 0);
      expect(fake.calls[0]).toBe("GET /v1/customer/disputes/PP-D-1");
      const [saved] = await db.select().from(disputes).where(eq(disputes.paypalDisputeId, "PP-D-1"));
      expect(saved).toMatchObject({ status: "OPEN", action: "ESCALATE_TO_HUMAN", needsHuman: true, purchaseId });
      expect(fake.calls.some((call) => call.startsWith("POST"))).toBe(false);
      expect(await test.app.services.saga.get({ tenantId: seeded.tenantId, purchaseId })).toMatchObject({ state: "DISPUTED" });
      const [event] = await db.select().from(webhookEvents).where(eq(webhookEvents.paypalEventId, "WH-D-1"));
      expect(event?.processedAt).not.toBeNull();
    } finally {
      await test.close();
    }
  });
});

describe("judge mode", () => {
  async function session() {
    const res = await app.inject({ method: "POST", url: "/v1/demo/session" });
    expect(res.statusCode, res.body).toBe(200);
    return { cookie: String(res.headers["set-cookie"]).split(";")[0] ?? "", body: res.json() };
  }

  it("gives every visitor an isolated tenant with an active, signed demo Writ", async () => {
    const a = await session();
    const b = await session();
    expect(a.body.session.tenant_id).not.toBe(b.body.session.tenant_id);
    expect(a.body.session.user.demo).toBe(true);
    const writ = await app.inject({ method: "GET", url: `/v1/writs/${a.body.seeded.writ_id}`, headers: { cookie: a.cookie } });
    expect(writ.json()).toMatchObject({ status: "ACTIVE", signature_kind: "device-ed25519" });
    const other = await app.inject({ method: "GET", url: `/v1/writs/${a.body.seeded.writ_id}`, headers: { cookie: b.cookie } });
    expect(other.statusCode).toBe(404);
  });

  it("a hero run with no model fails visibly instead of pretending, and the hourly limit holds", async () => {
    const a = await session();
    const hero = () => app.inject({ method: "POST", url: "/v1/demo/hero-run", headers: { cookie: a.cookie } });
    const first = await hero();
    expect(first.statusCode, first.body).toBe(202);
    await app.services.runs.shutdown();
    const detail = await app.inject({ method: "GET", url: `/v1/runs/${first.json().run_id}`, headers: { cookie: a.cookie } });
    expect(detail.json().run).toMatchObject({ status: "FAILED", failure_code: "ai_unavailable" });
    expect((await hero()).statusCode).toBe(202);
    await app.services.runs.shutdown();
    expect((await hero()).statusCode).toBe(429);
  });

  it("a normal wallet cannot use the judge routes", async () => {
    const wallet = await app.inject({ method: "POST", url: "/v1/auth/device-wallet", payload: { display_name: "Bo", public_key: Buffer.from(generateDeviceKeyEd25519().publicKey).toString("base64url"), label: "x" } });
    const cookie = String(wallet.headers["set-cookie"]).split(";")[0] ?? "";
    expect((await app.inject({ method: "POST", url: "/v1/demo/hero-run", headers: { cookie } })).statusCode).toBe(403);
  });
});
