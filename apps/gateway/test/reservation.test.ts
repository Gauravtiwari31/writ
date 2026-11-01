import { sha256 } from "@writ/core";
import { eq, sql } from "drizzle-orm";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getBudget, releaseReservation, reserveBudget, settleReservation } from "../src/budget/reservations";
import {
  type AppDb,
  closeDb,
  createPgDb,
  createPgliteDb,
  type Db,
  isCheckViolation,
  newRowId,
  runMigrations,
  users,
  type WritBudget,
  writBudgets,
  writs,
} from "../src/db/index";

const TENANT = "tn_budget";
const HUNDRED_DOLLARS = 10_000n;
const PG_URL = process.env.TEST_DATABASE_URL ?? "";

async function seedWrit(db: Db, limitMinor: bigint, maxOrders: number): Promise<string> {
  const userId = newRowId("user");
  const writId = newRowId("writ");
  await db.insert(users).values({ id: userId, tenantId: TENANT, displayName: "Ana" });
  await db.insert(writs).values({
    id: writId,
    tenantId: TENANT,
    userId,
    body: { budget_minor: limitMinor.toString() },
    bodyHash: sha256(writId),
    status: "ACTIVE",
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
  });
  await db.insert(writBudgets).values({ writId, tenantId: TENANT, limitMinor, maxPerOrderMinor: limitMinor, maxOrders });
  return writId;
}

async function mustGet(db: Db, writId: string): Promise<WritBudget> {
  const row = await getBudget(db, writId);
  if (!row) throw new Error(`no budget for ${writId}`);
  return row;
}

function expectInvariants(row: WritBudget): void {
  expect(row.reservedMinor).toBeGreaterThanOrEqual(0n);
  expect(row.spentMinor).toBeGreaterThanOrEqual(0n);
  expect(row.spentMinor + row.reservedMinor).toBeLessThanOrEqual(row.limitMinor);
  expect(row.ordersCount).toBeLessThanOrEqual(row.maxOrders);
}

// Reference model of the three guarded statements.
interface Model {
  limit: bigint;
  maxOrders: number;
  reserved: bigint;
  spent: bigint;
  orders: number;
  version: number;
}

type OpKind = "reserve" | "settle" | "release";

function applyModel(m: Model, kind: OpKind, amount: bigint): boolean {
  switch (kind) {
    case "reserve":
      if (m.spent + m.reserved + amount > m.limit || m.orders >= m.maxOrders) return false;
      m.reserved += amount;
      break;
    case "settle":
      if (m.reserved < amount || m.orders >= m.maxOrders) return false;
      m.reserved -= amount;
      m.spent += amount;
      m.orders += 1;
      break;
    case "release":
      if (m.reserved < amount) return false;
      m.reserved -= amount;
      break;
  }
  m.version += 1;
  return true;
}

const run: Record<OpKind, (db: Db, change: { writId: string; amountMinor: bigint }) => Promise<WritBudget | null>> = {
  reserve: reserveBudget,
  settle: settleReservation,
  release: releaseReservation,
};

// An op either uses a fresh random amount or targets an outstanding hold (what a real saga does).
type Op = { kind: OpKind; amount: bigint } | { kind: "settle" | "release"; hold: number };

const amountArb = fc.oneof(
  fc.bigInt({ min: 1n, max: 3_000n }),
  fc.bigInt({ min: 1n, max: HUNDRED_DOLLARS + 1n }),
  fc.constantFrom(HUNDRED_DOLLARS, HUNDRED_DOLLARS + 1n, 1n),
);
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constantFrom<OpKind>("reserve", "settle", "release"), amount: amountArb }),
  fc.record({ kind: fc.constant<OpKind>("reserve"), amount: amountArb }),
  fc.record({ kind: fc.constantFrom<"settle" | "release">("settle", "release"), hold: fc.nat({ max: 9 }) }),
);

const drivers = [
  { name: "PGlite", skip: false, open: () => createPgliteDb(), runs: { model: 150, race: 40 } },
  {
    name: "Postgres (TEST_DATABASE_URL)",
    skip: PG_URL === "",
    // 50 connections so the 50 reservations below genuinely run in parallel on the server.
    open: async () => createPgDb(PG_URL, { max: 50 }),
    runs: { model: 25, race: 25 },
  },
];

for (const driver of drivers) {
  describe.skipIf(driver.skip)(`budget reservations on ${driver.name}`, () => {
    let app: AppDb;
    let db: Db;

    beforeAll(async () => {
      app = await driver.open();
      await runMigrations(app);
      db = app;
    });

    afterAll(async () => {
      if (app) await closeDb(app);
    });

    it("reserves until the limit, then returns null (BLOCK budget)", async () => {
      const writId = await seedWrit(db, HUNDRED_DOLLARS, 50);
      expect(await reserveBudget(db, { writId, amountMinor: 6_000n })).toMatchObject({
        reservedMinor: 6_000n,
        version: 1,
      });
      expect(await reserveBudget(db, { writId, amountMinor: 4_000n })).toMatchObject({
        reservedMinor: 10_000n,
        version: 2,
      });
      expect(await reserveBudget(db, { writId, amountMinor: 1n })).toBeNull();
      expect(await mustGet(db, writId)).toMatchObject({ reservedMinor: 10_000n, spentMinor: 0n, version: 2 });
    });

    it("counts spent money against the limit after settlement", async () => {
      const writId = await seedWrit(db, HUNDRED_DOLLARS, 5);
      await reserveBudget(db, { writId, amountMinor: 4_400n });
      expect(await settleReservation(db, { writId, amountMinor: 4_400n })).toMatchObject({
        reservedMinor: 0n,
        spentMinor: 4_400n,
        ordersCount: 1,
        version: 2,
      });
      expect(await reserveBudget(db, { writId, amountMinor: 5_601n })).toBeNull();
      expect(await reserveBudget(db, { writId, amountMinor: 5_600n })).toMatchObject({ reservedMinor: 5_600n });
    });

    it("returns null for a Writ without a budget row", async () => {
      expect(await reserveBudget(db, { writId: newRowId("writ"), amountMinor: 1n })).toBeNull();
      expect(await settleReservation(db, { writId: newRowId("writ"), amountMinor: 1n })).toBeNull();
      expect(await releaseReservation(db, { writId: newRowId("writ"), amountMinor: 1n })).toBeNull();
    });

    it("rejects zero, negative and out-of-range amounts before touching the database", async () => {
      const writId = await seedWrit(db, HUNDRED_DOLLARS, 1);
      for (const fn of [reserveBudget, settleReservation, releaseReservation]) {
        await expect(fn(db, { writId, amountMinor: 0n })).rejects.toThrow(RangeError);
        await expect(fn(db, { writId, amountMinor: -1n })).rejects.toThrow(RangeError);
        await expect(fn(db, { writId, amountMinor: 2n ** 63n })).rejects.toThrow(RangeError);
        // A JSON number smuggled past the type system is refused, never coerced.
        const loose = { writId, amountMinor: 100 as unknown as bigint };
        await expect(fn(db, loose)).rejects.toThrow(TypeError);
      }
      expect(await mustGet(db, writId)).toMatchObject({ reservedMinor: 0n, spentMinor: 0n, version: 0 });
    });

    it("returns null instead of overflowing on the largest bigint amount", async () => {
      const writId = await seedWrit(db, HUNDRED_DOLLARS, 1);
      await reserveBudget(db, { writId, amountMinor: 1n });
      expect(await reserveBudget(db, { writId, amountMinor: 2n ** 63n - 1n })).toBeNull();
    });

    it("enforces max_orders on reserve and on settle", async () => {
      const writId = await seedWrit(db, HUNDRED_DOLLARS, 1);
      // Two holds can be outstanding at once (the §6.8 statement only checks settled orders) ...
      expect(await reserveBudget(db, { writId, amountMinor: 1_000n })).not.toBeNull();
      expect(await reserveBudget(db, { writId, amountMinor: 2_000n })).not.toBeNull();
      expect(await settleReservation(db, { writId, amountMinor: 1_000n })).toMatchObject({ ordersCount: 1 });
      // ... but only max_orders of them can ever be captured; the other must be voided.
      expect(await settleReservation(db, { writId, amountMinor: 2_000n })).toBeNull();
      expect(await reserveBudget(db, { writId, amountMinor: 1n })).toBeNull();
      expect(await releaseReservation(db, { writId, amountMinor: 2_000n })).toMatchObject({
        reservedMinor: 0n,
        spentMinor: 1_000n,
        ordersCount: 1,
      });
    });

    it("guards settle and release against more than is reserved", async () => {
      const writId = await seedWrit(db, HUNDRED_DOLLARS, 3);
      await reserveBudget(db, { writId, amountMinor: 500n });
      expect(await settleReservation(db, { writId, amountMinor: 501n })).toBeNull();
      expect(await releaseReservation(db, { writId, amountMinor: 501n })).toBeNull();
      expect(await releaseReservation(db, { writId, amountMinor: 200n })).toMatchObject({ reservedMinor: 300n });
      expect(await settleReservation(db, { writId, amountMinor: 300n })).toMatchObject({
        reservedMinor: 0n,
        spentMinor: 300n,
      });
      expect(await releaseReservation(db, { writId, amountMinor: 1n })).toBeNull();
      expect(await mustGet(db, writId)).toMatchObject({ reservedMinor: 0n, spentMinor: 300n, ordersCount: 1, version: 3 });
    });

    it("joins the caller's transaction and rolls back with it", async () => {
      const writId = await seedWrit(db, HUNDRED_DOLLARS, 1);
      await expect(
        db.transaction(async (tx) => {
          expect(await reserveBudget(tx, { writId, amountMinor: 7_000n })).toMatchObject({ reservedMinor: 7_000n });
          expect(await getBudget(tx, writId)).toMatchObject({ reservedMinor: 7_000n });
          throw new Error("saga step failed after reserving");
        }),
      ).rejects.toThrow("saga step failed");
      expect(await mustGet(db, writId)).toMatchObject({ reservedMinor: 0n, version: 0 });

      const committed = await db.transaction(async (tx) => reserveBudget(tx, { writId, amountMinor: 7_000n }));
      expect(committed).toMatchObject({ reservedMinor: 7_000n });
      expect(await mustGet(db, writId)).toMatchObject({ reservedMinor: 7_000n, version: 1 });
    });

    it("CHECK constraints refuse a direct invariant-violating UPDATE (defense in depth)", async () => {
      const writId = await seedWrit(db, HUNDRED_DOLLARS, 2);
      await reserveBudget(db, { writId, amountMinor: 9_000n });
      const where = eq(writBudgets.writId, writId);
      const attempts: [string, Promise<unknown>][] = [
        [
          "writ_budgets_within_limit_check",
          db.update(writBudgets).set({ spentMinor: sql`${writBudgets.spentMinor} + 1001` }).where(where),
        ],
        ["writ_budgets_reserved_check", db.update(writBudgets).set({ reservedMinor: -1n }).where(where)],
        ["writ_budgets_spent_check", db.update(writBudgets).set({ spentMinor: -1n }).where(where)],
        ["writ_budgets_orders_count_check", db.update(writBudgets).set({ ordersCount: 3 }).where(where)],
        ["writ_budgets_limit_check", db.update(writBudgets).set({ limitMinor: 0n, reservedMinor: 0n }).where(where)],
      ];
      for (const [constraint, attempt] of attempts) {
        await expect(attempt, constraint).rejects.toSatisfy((e: unknown) => isCheckViolation(e, constraint));
      }
      expect(await mustGet(db, writId)).toMatchObject({ reservedMinor: 9_000n, spentMinor: 0n, ordersCount: 0 });
    });

    it("property: any reserve/settle/release sequence keeps the invariants and matches the model", async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 6 }), fc.array(opArb, { minLength: 1, maxLength: 40 }), async (maxOrders, ops) => {
          const writId = await seedWrit(db, HUNDRED_DOLLARS, maxOrders);
          const model: Model = { limit: HUNDRED_DOLLARS, maxOrders, reserved: 0n, spent: 0n, orders: 0, version: 0 };
          const holds: bigint[] = [];

          for (const op of ops) {
            let amount: bigint;
            let holdIndex = -1;
            if ("hold" in op) {
              if (holds.length === 0) continue;
              holdIndex = op.hold % holds.length;
              amount = holds[holdIndex] as bigint;
            } else {
              amount = op.amount;
            }

            const expectedOk = applyModel(model, op.kind, amount);
            const row = await run[op.kind](db, { writId, amountMinor: amount });
            expect(row !== null, `${op.kind} ${amount}`).toBe(expectedOk);

            if (expectedOk) {
              if (op.kind === "reserve") holds.push(amount);
              else if (holdIndex >= 0) holds.splice(holdIndex, 1);
            }

            const actual = row ?? (await mustGet(db, writId));
            expectInvariants(actual);
            expect(actual).toMatchObject({
              limitMinor: model.limit,
              maxOrders: model.maxOrders,
              reservedMinor: model.reserved,
              spentMinor: model.spent,
              ordersCount: model.orders,
              version: model.version,
            });
          }
        }),
        { numRuns: driver.runs.model },
      );
    }, 120_000);

    it("property (plan §6.8): 50 concurrent reservations on a $100 Writ never over-reserve", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.bigInt({ min: 1n, max: 1_000n }), { minLength: 50, maxLength: 50 }),
          async (amounts) => {
            const writId = await seedWrit(db, HUNDRED_DOLLARS, 50);
            const results = await Promise.all(amounts.map((amountMinor) => reserveBudget(db, { writId, amountMinor })));

            let granted = 0n;
            const wins: { amount: bigint; row: WritBudget }[] = [];
            results.forEach((row, i) => {
              const amount = amounts[i] as bigint;
              if (row) {
                granted += amount;
                wins.push({ amount, row });
              }
            });

            const final = await mustGet(db, writId);
            expectInvariants(final);
            expect(granted).toBeLessThanOrEqual(HUNDRED_DOLLARS);
            expect(final.reservedMinor).toBe(granted);
            expect(final.version).toBe(wins.length);

            // Linearizable: ordered by version, each winner saw exactly the reservations before it.
            wins.sort((a, b) => a.row.version - b.row.version);
            let running = 0n;
            wins.forEach(({ amount, row }, i) => {
              running += amount;
              expect(row.version).toBe(i + 1);
              expect(row.reservedMinor).toBe(running);
            });

            // No spurious refusals: reserved only grows here, so a refused amount must still not fit.
            results.forEach((row, i) => {
              if (!row) expect(final.reservedMinor + (amounts[i] as bigint)).toBeGreaterThan(HUNDRED_DOLLARS);
            });
          },
        ),
        { numRuns: driver.runs.race },
      );
    }, 120_000);
  });
}
