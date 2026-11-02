// P0-5, P0-6, P0-8: the money path end to end on a real database, with PayPal faked at the fetch seam
// (unit tests only, §22 rule 41). Rule 28: saga recovery; plan §6.8: chaos test.
import { approvalBody, approvalHash, ApprovalRequestSchema, parseCustomId, parseInvoiceId, POLICY_VERSION, signDeviceEd25519, type PolicyDecision } from "@writ/core";
import { verifyChain } from "@writ/ledger";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PurchaseStateChangedError } from "../../src/contracts/index";
import { closeDb, type AppDb } from "../../src/db/client";
import { approvals, decisions, purchases, webhookEvents, writBudgets } from "../../src/db/schema";
import type { Services } from "../../src/deps";
import { sagaJobs } from "../../src/saga/index";
import { loadChain } from "../../src/tx/ledger";
import { buildTestApp, createTestDb, type TestApp } from "../helpers/app";
import { createFakePayPal, fakePayPalClients, seedCart, seedWrit, storeVerification, type FakePayPal, type Seeded } from "./fixtures";

let db: AppDb;
let test: TestApp;
let app: FastifyInstance;
let services: Services;
let paypal: FakePayPal;

const policy = (amount: bigint, verdict: PolicyDecision["verdict"] = "APPROVE"): PolicyDecision => ({
  policy_version: POLICY_VERSION,
  verdict,
  amount_minor: amount.toString(),
  checks: [],
  reasons: [],
});

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await closeDb(db);
});

beforeEach(async () => {
  paypal = createFakePayPal();
  test = await buildTestApp({ db, services: { paypal: fakePayPalClients(paypal) } });
  app = test.app;
  services = app.services;
  return async () => {
    await test.close();
  };
});

async function drain(): Promise<void> {
  while ((await services.jobs.runDue(16)) > 0);
}

async function openPurchase(seeded: Seeded, key = "key-1", amount = 4400n) {
  const { cartId, hash } = await seedCart(db, seeded, amount);
  const { purchase } = await services.saga.open({
    tenantId: seeded.tenantId,
    writId: seeded.writId,
    cartId,
    agentId: seeded.agentId,
    idempotencyKey: key,
    amountMinor: amount,
    currency: "USD",
  });
  return { purchaseId: purchase.purchaseId, cartId, cartHash: hash };
}

/** Everything before the second key: authorized and verifying. */
async function toVerifying(seeded: Seeded, amount = 4400n) {
  const opened = await openPurchase(seeded, `key-${seeded.writId}`, amount);
  await services.saga.reserveAndAuthorize({ tenantId: seeded.tenantId, purchaseId: opened.purchaseId, policy: policy(amount), waitMs: 0 });
  await drain();
  const snapshot = await services.saga.beginVerification({ tenantId: seeded.tenantId, purchaseId: opened.purchaseId });
  expect(snapshot.state).toBe("VERIFYING");
  return { ...opened, cPre: snapshot.cPre as string };
}

async function budget(writId: string) {
  const [row] = await db.select().from(writBudgets).where(eq(writBudgets.writId, writId));
  if (row === undefined) throw new Error("no budget");
  return row;
}

const recovery = () => {
  const task = sagaJobs(services).periodic.find((t) => t.name === "saga.recovery");
  if (task === undefined) throw new Error("no recovery task");
  return task.run();
};

async function makeStale(purchaseId: string): Promise<void> {
  await db.update(purchases).set({ updatedAt: new Date(Date.now() - 10 * 60_000) }).where(eq(purchases.id, purchaseId));
}

describe("two-key settlement", () => {
  it("captures exactly the verified total with final_capture and both anchors, and keeps a valid chain", async () => {
    const seeded = await seedWrit(db);
    const { purchaseId, cartId, cartHash, cPre } = await toVerifying(seeded);
    const { record, decisionId } = await storeVerification(db, { tenantId: seeded.tenantId, purchaseId, cartId, cartHash, cPre, final: "APPROVE" });

    const moving = await services.saga.execute({ tenantId: seeded.tenantId, purchaseId, verification: record, decisionId, waitMs: 0 });
    expect(moving.state).toBe("CAPTURING");
    expect((await budget(seeded.writId)).spentMinor).toBe(4400n);
    await drain();

    const done = await services.saga.get({ tenantId: seeded.tenantId, purchaseId });
    expect(done?.state).toBe("CAPTURED");
    expect(paypal.effects).toEqual({ orders: 1, captures: 1, voids: 0, refunds: 0 });

    const order = paypal.calls.find((c) => c.path === "/v2/checkout/orders");
    expect(order?.requestId).toBe(`${purchaseId}:authorize`);
    const unit = (order?.body as { purchase_units: { custom_id: string; amount: { value: string } }[] }).purchase_units[0];
    expect(unit?.amount.value).toBe("44.00");
    expect(parseCustomId(unit?.custom_id ?? "")?.cPrePrefix).toBe(cPre.slice(0, 40));

    const capture = paypal.calls.find((c) => c.path.endsWith("/capture"));
    expect(capture?.requestId).toBe(`${purchaseId}:capture`);
    const body = capture?.body as { amount: { value: string }; final_capture: boolean; invoice_id: string };
    expect(body.amount.value).toBe("44.00");
    expect(body.final_capture).toBe(true);
    expect(parseInvoiceId(body.invoice_id)?.cPostPrefix).toBe(done?.cPost?.slice(0, 40));

    const chain = await loadChain(db, seeded.writId);
    expect(verifyChain(chain).ok).toBe(true);
    expect(chain.map((e) => e.type)).toEqual([
      "WRIT_SIGNED",
      "POLICY_DECIDED",
      "BUDGET_RESERVED",
      "PAYPAL_ORDER_CREATED",
      "PAYPAL_AUTHORIZED",
      "VERIFIER_DECIDED",
      "BUDGET_SETTLED",
      "PAYPAL_CAPTURED",
    ]);
  });

  it("a verifier BLOCK voids the hold and releases the reservation; $0 is captured", async () => {
    const seeded = await seedWrit(db);
    const { purchaseId, cartId, cartHash, cPre } = await toVerifying(seeded);
    const { record, decisionId } = await storeVerification(db, { tenantId: seeded.tenantId, purchaseId, cartId, cartHash, cPre, final: "BLOCK" });
    await services.saga.execute({ tenantId: seeded.tenantId, purchaseId, verification: record, decisionId, waitMs: 0 });
    await drain();
    const done = await services.saga.get({ tenantId: seeded.tenantId, purchaseId });
    expect(done).toMatchObject({ state: "VOIDED", stateReason: "verifier_blocked" });
    expect(paypal.effects).toMatchObject({ captures: 0, voids: 1 });
    expect(await budget(seeded.writId)).toMatchObject({ reservedMinor: 0n, spentMinor: 0n, heldOrders: 0, ordersCount: 0 });
  });

  it("a deterministic BLOCK never calls PayPal", async () => {
    const seeded = await seedWrit(db);
    const { purchaseId } = await openPurchase(seeded);
    const blocked = await services.saga.block({ tenantId: seeded.tenantId, purchaseId, reason: "policy_blocked", detail: "total above budget", policy: policy(4400n, "BLOCK") });
    expect(blocked.state).toBe("BLOCKED");
    await drain();
    expect(paypal.calls).toEqual([]);
  });

  it("replays an Idempotency-Key instead of opening a second purchase (T7)", async () => {
    const seeded = await seedWrit(db);
    const first = await openPurchase(seeded, "same-key");
    const { cartId } = await seedCart(db, seeded);
    const again = await services.saga.open({ tenantId: seeded.tenantId, writId: seeded.writId, cartId, agentId: seeded.agentId, idempotencyKey: "same-key", amountMinor: 4400n, currency: "USD" });
    expect(again.replayed).toBe(true);
    expect(again.purchase.purchaseId).toBe(first.purchaseId);
  });

  it("with max_orders = 1 a second checkout is blocked before any PayPal call", async () => {
    const seeded = await seedWrit(db, { maxOrders: 1 });
    const a = await openPurchase(seeded, "a");
    const b = await openPurchase(seeded, "b");
    await services.saga.reserveAndAuthorize({ tenantId: seeded.tenantId, purchaseId: a.purchaseId, policy: policy(4400n), waitMs: 0 });
    const second = await services.saga.reserveAndAuthorize({ tenantId: seeded.tenantId, purchaseId: b.purchaseId, policy: policy(4400n), waitMs: 0 });
    expect(second).toMatchObject({ state: "BLOCKED", stateReason: "budget_exhausted" });
    await drain();
    expect(paypal.effects.orders).toBe(1);
  });

  it("no vaulted wallet fails the purchase and releases the reservation", async () => {
    const seeded = await seedWrit(db, { vault: false });
    const { purchaseId } = await openPurchase(seeded);
    const failed = await services.saga.reserveAndAuthorize({ tenantId: seeded.tenantId, purchaseId, policy: policy(4400n), waitMs: 0 });
    expect(failed).toMatchObject({ state: "FAILED", stateReason: "paypal_not_connected" });
    expect(await budget(seeded.writId)).toMatchObject({ reservedMinor: 0n, heldOrders: 0 });
  });

  it("a declined authorization fails without a void", async () => {
    const seeded = await seedWrit(db);
    const { purchaseId } = await openPurchase(seeded);
    paypal.failOnce("/v2/checkout/orders", 422, "UNPROCESSABLE_ENTITY", "INSTRUMENT_DECLINED");
    await services.saga.reserveAndAuthorize({ tenantId: seeded.tenantId, purchaseId, policy: policy(4400n), waitMs: 0 });
    await drain();
    expect(await services.saga.get({ tenantId: seeded.tenantId, purchaseId })).toMatchObject({ state: "FAILED", stateReason: "paypal_error" });
    expect(paypal.effects.voids).toBe(0);
    expect(await budget(seeded.writId)).toMatchObject({ reservedMinor: 0n, heldOrders: 0 });
  });

  it("PayPal unconfigured fails at AUTHORIZE with a typed reason, without any fake PayPal", async () => {
    const unconfigured = await buildTestApp({ db, services: { paypal: null } });
    try {
      const seeded = await seedWrit(db);
      const { cartId } = await seedCart(db, seeded);
      const saga = unconfigured.app.services.saga;
      const { purchase } = await saga.open({ tenantId: seeded.tenantId, writId: seeded.writId, cartId, agentId: seeded.agentId, idempotencyKey: "k", amountMinor: 4400n, currency: "USD" });
      const failed = await saga.reserveAndAuthorize({ tenantId: seeded.tenantId, purchaseId: purchase.purchaseId, policy: policy(4400n), waitMs: 0 });
      expect(failed).toMatchObject({ state: "FAILED", stateReason: "paypal_unconfigured" });
      expect(await budget(seeded.writId)).toMatchObject({ reservedMinor: 0n, heldOrders: 0 });
    } finally {
      await unconfigured.close();
    }
  });
});

describe("the saga does not trust what it is handed", () => {
  it("fails closed on a record built for another purchase", async () => {
    const seeded = await seedWrit(db);
    const one = await toVerifying(seeded);
    const otherWrit = await seedWrit(db);
    const other = await toVerifying(otherWrit);
    const { record } = await storeVerification(db, { tenantId: otherWrit.tenantId, purchaseId: other.purchaseId, cartId: other.cartId, cartHash: other.cartHash, cPre: other.cPre, final: "APPROVE" });
    const stored = await storeVerification(db, { tenantId: seeded.tenantId, purchaseId: one.purchaseId, cartId: one.cartId, cartHash: one.cartHash, cPre: one.cPre, final: "APPROVE" });
    const result = await services.saga.execute({ tenantId: seeded.tenantId, purchaseId: one.purchaseId, verification: record, decisionId: stored.decisionId, waitMs: 0 });
    expect(result.state).toBe("VOIDING");
    expect(paypal.effects.captures).toBe(0);
  });

  it("final can only tighten: a record saying APPROVE with a BLOCK contribution is a BLOCK", async () => {
    const seeded = await seedWrit(db);
    const v = await toVerifying(seeded);
    const { record, decisionId } = await storeVerification(db, { tenantId: seeded.tenantId, purchaseId: v.purchaseId, cartId: v.cartId, cartHash: v.cartHash, cPre: v.cPre, final: "APPROVE", contributionVerdict: "BLOCK" });
    const result = await services.saga.execute({ tenantId: seeded.tenantId, purchaseId: v.purchaseId, verification: record, decisionId, waitMs: 0 });
    expect(result).toMatchObject({ state: "VOIDING", finalVerdict: "BLOCK" });
  });

  it("execute after the kill switch moved the purchase answers state_changed and changes nothing", async () => {
    const seeded = await seedWrit(db);
    const v = await toVerifying(seeded);
    const { record, decisionId } = await storeVerification(db, { tenantId: seeded.tenantId, purchaseId: v.purchaseId, cartId: v.cartId, cartHash: v.cartHash, cPre: v.cPre, final: "APPROVE" });
    await services.uow.run(seeded.tenantId, (ctx) => services.saga.requestVoids(ctx, { writIds: [seeded.writId], reason: "kill_switch" }));
    await expect(services.saga.execute({ tenantId: seeded.tenantId, purchaseId: v.purchaseId, verification: record, decisionId, waitMs: 0 })).rejects.toBeInstanceOf(PurchaseStateChangedError);
    await drain();
    expect(await services.saga.get({ tenantId: seeded.tenantId, purchaseId: v.purchaseId })).toMatchObject({ state: "VOIDED", stateReason: "kill_switch" });
    expect(paypal.effects.captures).toBe(0);
  });
});

describe("chaos: the process dies mid-saga", () => {
  it("a capture whose answer was lost is retried with the same request id and PayPal captures once", async () => {
    const seeded = await seedWrit(db);
    const v = await toVerifying(seeded);
    const { record, decisionId } = await storeVerification(db, { tenantId: seeded.tenantId, purchaseId: v.purchaseId, cartId: v.cartId, cartHash: v.cartHash, cPre: v.cPre, final: "APPROVE" });
    await services.saga.execute({ tenantId: seeded.tenantId, purchaseId: v.purchaseId, verification: record, decisionId, waitMs: 0 });
    paypal.loseAnswerOnce("/capture");
    await services.jobs.runDue(16);
    expect(await services.saga.get({ tenantId: seeded.tenantId, purchaseId: v.purchaseId })).toMatchObject({ state: "CAPTURING" });

    // Restart: a new gateway on the same database. The job is due again after its backoff.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const restarted = await buildTestApp({ db, services: { paypal: fakePayPalClients(paypal) } });
    try {
      while ((await restarted.app.services.jobs.runDue(16)) > 0);
      expect(await restarted.app.services.saga.get({ tenantId: seeded.tenantId, purchaseId: v.purchaseId })).toMatchObject({ state: "CAPTURED" });
    } finally {
      await restarted.close();
    }
    const captureCalls = paypal.calls.filter((c) => c.path.endsWith("/capture"));
    expect(captureCalls.length).toBe(2);
    expect(new Set(captureCalls.map((c) => c.requestId)).size).toBe(1);
    expect(paypal.effects.captures).toBe(1);
  });

  it("a capture already made on an earlier attempt is read back, never repeated", async () => {
    const seeded = await seedWrit(db);
    const v = await toVerifying(seeded);
    const { record, decisionId } = await storeVerification(db, { tenantId: seeded.tenantId, purchaseId: v.purchaseId, cartId: v.cartId, cartHash: v.cartHash, cPre: v.cPre, final: "APPROVE" });
    await services.saga.execute({ tenantId: seeded.tenantId, purchaseId: v.purchaseId, verification: record, decisionId, waitMs: 0 });
    paypal.failOnce("/capture", 422, "UNPROCESSABLE_ENTITY", "AUTHORIZATION_ALREADY_CAPTURED");
    const original = paypal.fetch;
    const clients = fakePayPalClients({
      ...paypal,
      fetch: async (url, init) => {
        if (new URL(url).pathname.startsWith("/v2/checkout/orders/") && (init.method ?? "GET") === "GET") {
          return new Response(JSON.stringify({ id: "ORDER1", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAP-EARLIER", status: "COMPLETED" }] } }] }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return original(url, init);
      },
    });
    const restarted = await buildTestApp({ db, services: { paypal: clients } });
    try {
      await restarted.app.services.jobs.runDue(16);
      expect(await restarted.app.services.saga.get({ tenantId: seeded.tenantId, purchaseId: v.purchaseId })).toMatchObject({ state: "CAPTURED", paypal: { captureId: "CAP-EARLIER" } });
    } finally {
      await restarted.close();
    }
    expect(paypal.effects.captures).toBe(0);
  });

  it("killed between AUTHORIZED and verification: recovery voids the hold and frees the order slot", async () => {
    const seeded = await seedWrit(db, { maxOrders: 1 });
    const { purchaseId } = await openPurchase(seeded);
    await services.saga.reserveAndAuthorize({ tenantId: seeded.tenantId, purchaseId, policy: policy(4400n), waitMs: 0 });
    await drain();
    expect(await services.saga.get({ tenantId: seeded.tenantId, purchaseId })).toMatchObject({ state: "AUTHORIZED" });

    await makeStale(purchaseId);
    await recovery();
    await drain();
    expect(await services.saga.get({ tenantId: seeded.tenantId, purchaseId })).toMatchObject({ state: "VOIDED", stateReason: "verification_interrupted" });
    expect(paypal.effects).toMatchObject({ captures: 0, voids: 1 });
    expect(await budget(seeded.writId)).toMatchObject({ reservedMinor: 0n, heldOrders: 0, ordersCount: 0 });
  });

  it("does not touch a purchase whose checkout may still be running", async () => {
    const seeded = await seedWrit(db);
    const v = await toVerifying(seeded);
    await recovery();
    await drain();
    expect(await services.saga.get({ tenantId: seeded.tenantId, purchaseId: v.purchaseId })).toMatchObject({ state: "VERIFYING" });
    expect(paypal.effects.voids).toBe(0);
  });

  it("re-enqueues a money step whose job went dead, and fails closed a stuck PROPOSED purchase", async () => {
    const seeded = await seedWrit(db);
    const { purchaseId } = await openPurchase(seeded, "stuck");
    await makeStale(purchaseId);
    await recovery();
    expect(await services.saga.get({ tenantId: seeded.tenantId, purchaseId })).toMatchObject({ state: "BLOCKED", stateReason: "checkout_interrupted" });

    const other = await seedWrit(db);
    const opened = await openPurchase(other, "dead-job");
    await services.saga.reserveAndAuthorize({ tenantId: other.tenantId, purchaseId: opened.purchaseId, policy: policy(4400n), waitMs: 0 });
    const { outbox } = await import("../../src/db/schema");
    await db.update(outbox).set({ deadAt: new Date() });
    await makeStale(opened.purchaseId);
    await recovery();
    await drain();
    expect(await services.saga.get({ tenantId: other.tenantId, purchaseId: opened.purchaseId })).toMatchObject({ state: "AUTHORIZED" });
  });
});

describe("human review", () => {
  async function toReview(seeded: Seeded) {
    const v = await toVerifying(seeded);
    const { record, decisionId } = await storeVerification(db, { tenantId: seeded.tenantId, purchaseId: v.purchaseId, cartId: v.cartId, cartHash: v.cartHash, cPre: v.cPre, final: "REVIEW" });
    const review = await services.saga.execute({ tenantId: seeded.tenantId, purchaseId: v.purchaseId, verification: record, decisionId, waitMs: 0 });
    expect(review.state).toBe("AWAITING_HUMAN");
    const [approval] = await db.select().from(approvals).where(eq(approvals.purchaseId, v.purchaseId));
    if (approval === undefined) throw new Error("no approval");
    return { ...v, approvalId: approval.id, request: ApprovalRequestSchema.parse(approval.request) };
  }
  const decide = (seeded: Seeded, id: string, decision: "APPROVE" | "DECLINE", signature: unknown) =>
    import("../../src/approvals/index").then(({ decideApproval }) =>
      decideApproval(services, { tenantId: seeded.tenantId, userId: seeded.userId, approvalId: id, decision, signature: signature as never }),
    );

  it("an approval signed for APPROVE captures, and stores the record as H_approval", async () => {
    const seeded = await seedWrit(db);
    const r = await toReview(seeded);
    const signature = signDeviceEd25519(approvalHash(approvalBody(r.request, "APPROVE")), seeded.deviceSecret);
    await decide(seeded, r.approvalId, "APPROVE", signature);
    await drain();
    const done = await services.saga.get({ tenantId: seeded.tenantId, purchaseId: r.purchaseId });
    expect(done?.state).toBe("CAPTURED");
    expect(paypal.effects.captures).toBe(1);
    const [human] = await db.select().from(decisions).where(eq(decisions.purchaseId, r.purchaseId)).then((rows) => rows.filter((row) => row.stage === "human"));
    expect(human?.outputHash).toBeInstanceOf(Uint8Array);
  });

  it("a signature for DECLINE cannot be used to APPROVE", async () => {
    const seeded = await seedWrit(db);
    const r = await toReview(seeded);
    const signature = signDeviceEd25519(approvalHash(approvalBody(r.request, "DECLINE")), seeded.deviceSecret);
    await expect(decide(seeded, r.approvalId, "APPROVE", signature)).rejects.toMatchObject({ status: 403 });
    expect(await services.saga.get({ tenantId: seeded.tenantId, purchaseId: r.purchaseId })).toMatchObject({ state: "AWAITING_HUMAN" });
  });

  it("decline voids and releases; the hold never becomes a capture", async () => {
    const seeded = await seedWrit(db);
    const r = await toReview(seeded);
    const signature = signDeviceEd25519(approvalHash(approvalBody(r.request, "DECLINE")), seeded.deviceSecret);
    await decide(seeded, r.approvalId, "DECLINE", signature);
    await drain();
    expect(await services.saga.get({ tenantId: seeded.tenantId, purchaseId: r.purchaseId })).toMatchObject({ state: "VOIDED", stateReason: "human_declined" });
    expect(await budget(seeded.writId)).toMatchObject({ reservedMinor: 0n, heldOrders: 0 });
  });

  it("24 hours without an answer auto-voids", async () => {
    const seeded = await seedWrit(db);
    const r = await toReview(seeded);
    await db.update(approvals).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(approvals.id, r.approvalId));
    const sweep = sagaJobs(services).periodic.find((t) => t.name === "approvals.timeout");
    await sweep?.run();
    await drain();
    expect(await services.saga.get({ tenantId: seeded.tenantId, purchaseId: r.purchaseId })).toMatchObject({ state: "VOIDED", stateReason: "approval_expired" });
  });
});

describe("budget under concurrency (T8)", () => {
  it("50 concurrent checkouts on a $100 Writ never exceed $100 reserved + spent", async () => {
    const seeded = await seedWrit(db, { limitMinor: 10_000n, maxOrders: 100 });
    const opened = await Promise.all(Array.from({ length: 50 }, (_, i) => openPurchase(seeded, `c-${i}`, 700n)));
    const results = await Promise.all(opened.map((o) => services.saga.reserveAndAuthorize({ tenantId: seeded.tenantId, purchaseId: o.purchaseId, policy: policy(700n), waitMs: 0 })));
    const row = await budget(seeded.writId);
    expect(row.reservedMinor + row.spentMinor).toBeLessThanOrEqual(10_000n);
    expect(results.filter((r) => r.state === "AUTHORIZING").length).toBe(14);
    expect(results.filter((r) => r.state === "BLOCKED").length).toBe(36);
  }, 30_000);
});

describe("durable webhooks", () => {
  it("a redelivered event is a no-op and the handler re-fetches before acting", async () => {
    const { durableWebhookDedupe } = await import("../../src/webhooks/index");
    const dedupe = durableWebhookDedupe(services);
    const event = { id: "WH-1", event_type: "PAYMENT.AUTHORIZATION.VOIDED", resource_type: "authorization", resource: { id: "AUTH-NOPE" } };
    await dedupe.add("WH-1", event as never);
    await dedupe.add("WH-1", event as never);
    expect(await dedupe.has("WH-1")).toBe(true);
    await drain();
    const fetched = paypal.calls.filter((c) => c.path.includes("AUTH-NOPE"));
    expect(fetched.length).toBeGreaterThanOrEqual(1);
    const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.paypalEventId, "WH-1"));
    expect(row?.verified).toBe(true);
  });
});
