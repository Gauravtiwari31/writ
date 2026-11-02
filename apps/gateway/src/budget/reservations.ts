// Atomic Writ budget reservations (plan §6.8, threat T8). Each operation is ONE guarded UPDATE:
// Postgres row-locks the budget and re-evaluates the WHERE clause against the latest committed
// row, so concurrent checkouts serialize on the row and can never overspend. There is no
// read-then-write window to race through, at any isolation level.
//
// held_orders (adopted Nov 1, plan §6.8): a reservation also holds one order slot, so the order
// cap counts in-flight orders too (orders_count + held_orders < max_orders). With max_orders = 1,
// two concurrent checkouts yield exactly one reservation; the other is a BLOCK (budget) before any
// PayPal call, instead of a second authorization that later has to be voided.
//
// The budget row does not know which hold belongs to which purchase. Callers MUST pair settle and
// release with the purchase state transition in the same transaction (pass `tx`), so a retried
// saga step cannot settle or release the same hold twice. Lock order in such a transaction:
// writs row first (TxContext.lockWrit), then writ_budgets (these statements), then purchases.
//
// FROZEN for the parallel build (docs/ARCHITECTURE.md): the money stream calls these, never edits them.
import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { type WritBudget, writBudgets } from "../db/schema";

export interface BudgetChange {
  writId: string;
  /** Minor units (cents for USD). Must be > 0. */
  amountMinor: bigint;
}

const PG_BIGINT_MAX = 2n ** 63n - 1n;

function assertAmount(amountMinor: bigint): void {
  // Runtime check too: a number from untyped JSON must never reach a money statement.
  if (typeof amountMinor !== "bigint") throw new TypeError("amountMinor must be a bigint in minor units");
  if (amountMinor <= 0n) throw new RangeError("amountMinor must be greater than zero");
  if (amountMinor > PG_BIGINT_MAX) throw new RangeError("amountMinor exceeds the Postgres bigint range");
}

/**
 * Holds `amountMinor` and one order slot against the Writ. Returns the updated row, or null when
 * the hold would exceed the limit, every order slot is settled or held, or the Writ has no budget:
 * null means BLOCK (budget).
 *
 * Same predicate as plan §6.8 (`spent + reserved + $1 <= limit`), rearranged so that an absurd
 * amount yields null instead of a bigint overflow error.
 */
export async function reserveBudget(db: Db, { writId, amountMinor }: BudgetChange): Promise<WritBudget | null> {
  assertAmount(amountMinor);
  const [row] = await db
    .update(writBudgets)
    .set({
      reservedMinor: sql`${writBudgets.reservedMinor} + ${amountMinor}::bigint`,
      heldOrders: sql`${writBudgets.heldOrders} + 1`,
      version: sql`${writBudgets.version} + 1`,
    })
    .where(
      and(
        eq(writBudgets.writId, writId),
        sql`${amountMinor}::bigint <= ${writBudgets.limitMinor} - ${writBudgets.spentMinor} - ${writBudgets.reservedMinor}`,
        sql`${writBudgets.ordersCount} + ${writBudgets.heldOrders} < ${writBudgets.maxOrders}`,
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Commits a hold to a capture: moves `amountMinor` from reserved to spent and its order slot from
 * held to settled. Run it in the transaction that moves the purchase to CAPTURING, i.e. before the
 * PayPal capture call (§22 rule 14: no side effect before commit). Returns null (nothing changed)
 * when less than `amountMinor` is reserved or no order slot is held; the purchase must then go to
 * VOIDING instead.
 */
export async function settleReservation(db: Db, { writId, amountMinor }: BudgetChange): Promise<WritBudget | null> {
  assertAmount(amountMinor);
  const [row] = await db
    .update(writBudgets)
    .set({
      reservedMinor: sql`${writBudgets.reservedMinor} - ${amountMinor}::bigint`,
      spentMinor: sql`${writBudgets.spentMinor} + ${amountMinor}::bigint`,
      ordersCount: sql`${writBudgets.ordersCount} + 1`,
      heldOrders: sql`${writBudgets.heldOrders} - 1`,
      version: sql`${writBudgets.version} + 1`,
    })
    .where(
      and(
        eq(writBudgets.writId, writId),
        sql`${writBudgets.reservedMinor} >= ${amountMinor}::bigint`,
        gte(writBudgets.heldOrders, 1),
      ),
    )
    .returning();
  return row ?? null;
}

/** Void or failure: returns `amountMinor` and its order slot. Returns null when less than that is reserved or no slot is held. */
export async function releaseReservation(db: Db, { writId, amountMinor }: BudgetChange): Promise<WritBudget | null> {
  assertAmount(amountMinor);
  const [row] = await db
    .update(writBudgets)
    .set({
      reservedMinor: sql`${writBudgets.reservedMinor} - ${amountMinor}::bigint`,
      heldOrders: sql`${writBudgets.heldOrders} - 1`,
      version: sql`${writBudgets.version} + 1`,
    })
    .where(
      and(
        eq(writBudgets.writId, writId),
        sql`${writBudgets.reservedMinor} >= ${amountMinor}::bigint`,
        gte(writBudgets.heldOrders, 1),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Only for a capture PayPal permanently refused after settlement (CAPTURING → VOIDING): no money
 * moved, so the settled amount and its order slot are given back. Returns null when less than
 * `amountMinor` is spent or no order is settled. Never use it for refunds: refunded money stays spent.
 */
export async function reverseSettlement(db: Db, { writId, amountMinor }: BudgetChange): Promise<WritBudget | null> {
  assertAmount(amountMinor);
  const [row] = await db
    .update(writBudgets)
    .set({
      spentMinor: sql`${writBudgets.spentMinor} - ${amountMinor}::bigint`,
      ordersCount: sql`${writBudgets.ordersCount} - 1`,
      version: sql`${writBudgets.version} + 1`,
    })
    .where(
      and(
        eq(writBudgets.writId, writId),
        sql`${writBudgets.spentMinor} >= ${amountMinor}::bigint`,
        gte(writBudgets.ordersCount, 1),
      ),
    )
    .returning();
  return row ?? null;
}

export async function getBudget(db: Db, writId: string): Promise<WritBudget | null> {
  const [row] = await db.select().from(writBudgets).where(eq(writBudgets.writId, writId));
  return row ?? null;
}

/** The policy engine's view (PolicyBudget in @writ/core): in-flight orders count against max_orders. */
export function policyBudgetOf(row: WritBudget): { spent_minor: bigint; reserved_minor: bigint; orders_count: number } {
  return { spent_minor: row.spentMinor, reserved_minor: row.reservedMinor, orders_count: row.ordersCount + row.heldOrders };
}
