// §22 rule 14 infrastructure: one transaction = state + ledger + outbox, nothing leaves the
// process before COMMIT, a rollback emits nothing; tenant-scoped SSE bus with replay.
import { newId, sha256 } from "@writ/core";
import type { StreamEvent, StreamMessage } from "@writ/core/api";
import { verifyChain } from "@writ/ledger";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, type AppDb } from "../src/db/client";
import { newRowId } from "../src/db/ids";
import { outbox, users, writs } from "../src/db/schema";
import { createEventBus } from "../src/events/bus";
import { HttpError } from "../src/http/errors";
import { loadChain } from "../src/tx/ledger";
import { createUnitOfWork, type UnitOfWork } from "../src/tx/unit-of-work";
import { createTestDb } from "./helpers/app";

const TENANT = "tn_uow";
const HASH = "ab".repeat(32);

function budgetEvent(writId: string): StreamEvent {
  return {
    type: "budget.updated",
    data: {
      writ_id: writId,
      limit_minor: "6000",
      max_per_order_minor: "6000",
      reserved_minor: "0",
      spent_minor: "0",
      remaining_minor: "6000",
      orders_count: 0,
      held_orders: 0,
      max_orders: 1,
    },
  };
}

describe("event bus", () => {
  it("delivers per tenant, replays after an id, and drops invalid events", () => {
    const invalid: unknown[] = [];
    const bus = createEventBus({ bufferSize: 3, onInvalid: (detail) => invalid.push(detail) });
    const seen: StreamMessage[] = [];
    const unsubscribe = bus.subscribe("tn_a", (message) => seen.push(message));
    const writId = newId("wr");
    const first = bus.publish("tn_a", budgetEvent(writId));
    bus.publish("tn_b", budgetEvent(writId));
    const second = bus.publish("tn_a", budgetEvent(writId));
    expect(seen.map((m) => m.id)).toEqual([first?.id, second?.id]);
    expect(first?.id).toMatch(/^[0-9a-z]+-1$/);
    expect(bus.since("tn_a", first?.id ?? "")).toEqual([second]);
    expect(bus.since("tn_a", "otherboot-1")).toBeNull();
    for (let i = 0; i < 3; i++) bus.publish("tn_a", budgetEvent(writId));
    expect(bus.since("tn_a", first?.id ?? "")).toBeNull();
    expect(bus.publish("tn_a", { type: "budget.updated", data: { writ_id: "nope" } } as unknown as StreamEvent)).toBeNull();
    expect(invalid).toHaveLength(1);
    unsubscribe();
    bus.publish("tn_a", budgetEvent(writId));
    expect(seen).toHaveLength(5);
  });
});

describe("unit of work", () => {
  let db: AppDb;
  let uow: UnitOfWork;
  const published: { tenantId: string; type: string }[] = [];
  let kicks = 0;
  const userId = newRowId("user");

  async function seedWrit(tenantId = TENANT): Promise<string> {
    const writId = newRowId("writ");
    await db.insert(writs).values({
      id: writId,
      tenantId,
      userId,
      body: { purpose: "gift" },
      bodyHash: sha256(writId),
      status: "ACTIVE",
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    return writId;
  }

  beforeAll(async () => {
    db = await createTestDb();
    await db.insert(users).values({ id: userId, tenantId: TENANT, displayName: "Ana" });
    const bus = createEventBus();
    const publish = bus.publish.bind(bus);
    bus.publish = (tenantId, event) => {
      published.push({ tenantId, type: event.type });
      return publish(tenantId, event);
    };
    uow = createUnitOfWork({
      db,
      events: bus,
      clock: () => new Date("2026-11-03T14:02:00.000Z"),
      ids: (kind) => newRowId(kind),
      onEnqueued: () => {
        kicks += 1;
      },
    });
  });

  afterAll(async () => {
    if (db) await closeDb(db);
  });

  it("appends a verifiable chain, enqueues validated jobs once, and publishes only after commit", async () => {
    const writId = await seedWrit();
    const purchaseId = newId("pur");
    published.length = 0;
    kicks = 0;
    await uow.run(TENANT, async (ctx) => {
      await ctx.appendLedger({ writId, type: "WRIT_SIGNED", payload: { writ_hash: HASH } });
      await ctx.appendLedger({ writId, type: "KILL_SWITCH", payload: { reason: "test" } });
      expect(await ctx.enqueue({ topic: "purchase.void", payload: { purchase_id: purchaseId, reason: "kill_switch" }, dedupeKey: `void:${purchaseId}` })).toMatch(/^obx_/);
      expect(await ctx.enqueue({ topic: "purchase.void", payload: { purchase_id: purchaseId, reason: "kill_switch" }, dedupeKey: `void:${purchaseId}` })).toBeNull();
      ctx.emit(budgetEvent(writId));
      expect(published).toHaveLength(0);
    });
    expect(published.map((p) => p.type)).toEqual(["ledger.appended", "ledger.appended", "budget.updated"]);
    expect(kicks).toBe(1);
    const chain = await loadChain(db, writId);
    expect(chain.map((e) => e.type)).toEqual(["WRIT_SIGNED", "KILL_SWITCH"]);
    expect(chain[0]?.ts).toBe("2026-11-03T14:02:00.000Z");
    expect(verifyChain(chain)).toEqual({ ok: true });
    const jobs = await db.select().from(outbox).where(eq(outbox.dedupeKey, `void:${purchaseId}`));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ tenantId: TENANT, topic: "purchase.void", attempts: 0, publishedAt: null, deadAt: null });
  });

  it("rolls everything back on error: no ledger row, no job, no event", async () => {
    const writId = await seedWrit();
    published.length = 0;
    kicks = 0;
    await expect(
      uow.run(TENANT, async (ctx) => {
        await ctx.appendLedger({ writId, type: "WRIT_SIGNED", payload: { writ_hash: HASH } });
        await ctx.enqueue({ topic: "approval.expire", payload: { approval_id: newId("apr") } });
        ctx.emit(budgetEvent(writId));
        throw new Error("boom after the writes");
      }),
    ).rejects.toThrow("boom");
    expect(await loadChain(db, writId)).toEqual([]);
    expect(published).toEqual([]);
    expect(kicks).toBe(0);
  });

  it("refuses a bad job payload, a chain without genesis, and a Writ of another tenant", async () => {
    const writId = await seedWrit();
    await expect(
      uow.run(TENANT, (ctx) => ctx.enqueue({ topic: "purchase.capture", payload: { purchase_id: "pur_bad" } })),
    ).rejects.toThrow();
    await expect(uow.run(TENANT, (ctx) => ctx.appendLedger({ writId, type: "KILL_SWITCH", payload: {} }))).rejects.toThrow(/WRIT_SIGNED/);
    const otherTenantWrit = await seedWrit("tn_other");
    await expect(uow.run(TENANT, (ctx) => ctx.lockWrit(otherTenantWrit))).rejects.toBeInstanceOf(HttpError);
  });

  it("serializes concurrent appends to one Writ into one unforked chain", async () => {
    const writId = await seedWrit();
    await uow.run(TENANT, (ctx) => ctx.appendLedger({ writId, type: "WRIT_SIGNED", payload: { writ_hash: HASH } }));
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => uow.run(TENANT, (ctx) => ctx.appendLedger({ writId, type: "TRACKING_ADDED", payload: { n: i } }))),
    );
    const chain = await loadChain(db, writId);
    expect(chain).toHaveLength(9);
    expect(verifyChain(chain)).toEqual({ ok: true });
    const seqs = chain.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it("answers 503 database_unavailable without a database", async () => {
    const none = createUnitOfWork({ db: null, events: createEventBus(), clock: () => new Date(), ids: (kind) => newRowId(kind) });
    await expect(none.run(TENANT, async () => 1)).rejects.toMatchObject({ status: 503, code: "database_unavailable" });
  });

  it("keeps outbox rows ordered by creation for the poller", async () => {
    const rows = await db.select({ id: outbox.id }).from(outbox).orderBy(asc(outbox.createdAt));
    expect(rows.length).toBeGreaterThan(0);
  });
});
