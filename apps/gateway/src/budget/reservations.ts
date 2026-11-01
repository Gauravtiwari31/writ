// Atomic Writ budget reservations (plan §6.8, threat T8). Each operation is ONE guarded UPDATE:
// Postgres row-locks the budget and re-evaluates the WHERE clause against the latest committed
// row, so concurrent checkouts serialize on the row and can never overspend. There is no
// read-then-write window to race through, at any isolation level.
//
// The budget row does not know which hold belongs to which purchase. Callers MUST pair settle and
// release with the purchase state transition in the same transaction (pass `tx`), so a retried
// saga step cannot settle or release the same hold twice.
import { and, eq, lt, sql } from "drizzle-orm";
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
 * Holds `amountMinor` against the Writ. Returns the updated row, or null when the hold would exceed
 * the limit, the order cap is reached, or the Writ has no budget: null means BLOCK (budget).
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
      version: sql`${writBudgets.version} + 1`,
    })
    .where(
      and(
        eq(writBudgets.writId, writId),
        sql`${amountMinor}::bigint <= ${writBudgets.limitMinor} - ${writBudgets.spentMinor} - ${writBudgets.reservedMinor}`,
        lt(writBudgets.ordersCount, writBudgets.maxOrders),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Commits a hold to a capture: moves `amountMinor` from reserved to spent and counts the order.
 * Run it in the transaction that moves the purchase to CAPTURING, i.e. before the PayPal capture
 * call, so the order cap is enforced before money moves (§22 rule 14: no side effect before commit).
 * Returns null (nothing changed) when less than `amountMinor` is reserved or max_orders is already
 * reached; the purchase must then go to VOIDING instead.
 */
export async function settleReservation(db: Db, { writId, amountMinor }: BudgetChange): Promise<WritBudget | null> {
  assertAmount(amountMinor);
  const [row] = await db
    .update(writBudgets)
    .set({
      reservedMinor: sql`${writBudgets.reservedMinor} - ${amountMinor}::bigint`,
      spentMinor: sql`${writBudgets.spentMinor} + ${amountMinor}::bigint`,
      ordersCount: sql`${writBudgets.ordersCount} + 1`,
      version: sql`${writBudgets.version} + 1`,
    })
    .where(
      and(
        eq(writBudgets.writId, writId),
        sql`${writBudgets.reservedMinor} >= ${amountMinor}::bigint`,
        lt(writBudgets.ordersCount, writBudgets.maxOrders),
      ),
    )
    .returning();
  return row ?? null;
}

/** Void or failure: returns `amountMinor` of held budget. Returns null when less than that is reserved. */
export async function releaseReservation(db: Db, { writId, amountMinor }: BudgetChange): Promise<WritBudget | null> {
  assertAmount(amountMinor);
  const [row] = await db
    .update(writBudgets)
    .set({
      reservedMinor: sql`${writBudgets.reservedMinor} - ${amountMinor}::bigint`,
      version: sql`${writBudgets.version} + 1`,
    })
    .where(and(eq(writBudgets.writId, writId), sql`${writBudgets.reservedMinor} >= ${amountMinor}::bigint`))
    .returning();
  return row ?? null;
}

export async function getBudget(db: Db, writId: string): Promise<WritBudget | null> {
  const [row] = await db.select().from(writBudgets).where(eq(writBudgets.writId, writId));
  return row ?? null;
}
