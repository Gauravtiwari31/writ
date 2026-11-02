// Building blocks every saga step shares, always inside one UnitOfWork transaction (§22 rule 14).
// Only this module and its callers write purchases.state, and only along PURCHASE_TRANSITIONS.
import { canTransition, type PurchaseState, type PurchaseStateReason } from "@writ/core";
import { and, eq } from "drizzle-orm";
import { releaseReservation, reverseSettlement, settleReservation } from "../budget/reservations";
import type { PurchaseSnapshot } from "../contracts/index";
import type { Db } from "../db/client";
import { approvals, decisions, purchases, writs, type Purchase, type WritBudget } from "../db/schema";
import { httpError } from "../http/errors";
import { budgetView, purchaseView } from "../http/views";
import type { TxContext } from "../tx/unit-of-work";
import { toHex } from "@writ/core";

/** Locks in the documented order: writs row, then the purchase row. */
export async function lockPurchase(ctx: TxContext, purchaseId: string): Promise<Purchase> {
  const [ref] = await ctx.db
    .select({ writId: purchases.writId })
    .from(purchases)
    .where(and(eq(purchases.id, purchaseId), eq(purchases.tenantId, ctx.tenantId)));
  if (ref === undefined) throw httpError.notFound("Purchase");
  await ctx.lockWrit(ref.writId);
  const [row] = await ctx.db
    .select()
    .from(purchases)
    .where(and(eq(purchases.id, purchaseId), eq(purchases.tenantId, ctx.tenantId)))
    .for("update");
  if (row === undefined) throw httpError.notFound("Purchase");
  return row;
}

export type PurchasePatch = Partial<
  Pick<
    typeof purchases.$inferInsert,
    | "stateDetail"
    | "finalVerdict"
    | "vaultTokenId"
    | "paypalOrderId"
    | "authorizationId"
    | "captureId"
    | "refundId"
    | "cPre"
    | "cPost"
  >
> & { stateReason?: PurchaseStateReason | null };

/** One guarded state move. A row that changed underneath the caller is a bug under the writ lock: it throws and rolls back. */
export async function moveTo(ctx: TxContext, row: Purchase, to: PurchaseState, patch: PurchasePatch = {}): Promise<Purchase> {
  if (!canTransition(row.state, to)) throw new Error(`illegal purchase transition ${row.state} -> ${to} (${row.id})`);
  const [next] = await ctx.db
    .update(purchases)
    .set({ ...patch, state: to, updatedAt: ctx.now })
    .where(and(eq(purchases.id, row.id), eq(purchases.state, row.state)))
    .returning();
  if (next === undefined) throw new Error(`purchase ${row.id} left ${row.state} under the lock`);
  ctx.emit({ type: "purchase.updated", data: purchaseView(next) });
  return next;
}

function emitBudget(ctx: TxContext, budget: WritBudget): void {
  ctx.emit({ type: "budget.updated", data: budgetView(budget) });
}

/** Releases the purchase's hold and records it. A hold that is already gone is logged in the event, never fatal: the void must still happen. */
export async function releaseHold(ctx: TxContext, row: Purchase): Promise<void> {
  const budget = await releaseReservation(ctx.db, { writId: row.writId, amountMinor: row.amountMinor });
  if (budget !== null) emitBudget(ctx, budget);
  await ctx.appendLedger({
    writId: row.writId,
    purchaseId: row.id,
    type: "BUDGET_RELEASED",
    payload: { amount_minor: row.amountMinor.toString(), released: budget !== null },
  });
}

/** Reserved → spent, in the transaction that moves to CAPTURING. False means the hold is gone: void instead. */
export async function settleHold(ctx: TxContext, row: Purchase): Promise<boolean> {
  const budget = await settleReservation(ctx.db, { writId: row.writId, amountMinor: row.amountMinor });
  if (budget === null) return false;
  emitBudget(ctx, budget);
  await ctx.appendLedger({ writId: row.writId, purchaseId: row.id, type: "BUDGET_SETTLED", payload: { amount_minor: row.amountMinor.toString() } });
  return true;
}

export async function reverseSettled(ctx: TxContext, row: Purchase): Promise<void> {
  const budget = await reverseSettlement(ctx.db, { writId: row.writId, amountMinor: row.amountMinor });
  if (budget !== null) emitBudget(ctx, budget);
}

/** Any state holding a live authorization and a reservation → VOIDING. The void itself runs after COMMIT. */
export async function holdToVoiding(
  ctx: TxContext,
  row: Purchase,
  reason: PurchaseStateReason,
  patch: PurchasePatch = {},
): Promise<Purchase> {
  await releaseHold(ctx, row);
  const next = await moveTo(ctx, row, "VOIDING", { ...patch, stateReason: reason });
  await ctx.enqueue({ topic: "purchase.void", payload: { purchase_id: row.id, reason } });
  return next;
}

export async function writStatus(ctx: TxContext, writId: string): Promise<{ status: string; expiresAt: Date }> {
  const [writ] = await ctx.db.select({ status: writs.status, expiresAt: writs.expiresAt }).from(writs).where(eq(writs.id, writId));
  if (writ === undefined) throw httpError.notFound("Writ");
  return writ;
}

/** Why a forward step must stop, or null when the Writ is still spendable. */
export async function writBlockReason(ctx: TxContext, writId: string): Promise<Extract<PurchaseStateReason, "writ_revoked" | "writ_expired"> | null> {
  const writ = await writStatus(ctx, writId);
  if (writ.status === "REVOKED") return "writ_revoked";
  if (writ.status === "EXPIRED" || writ.expiresAt.getTime() <= ctx.now.getTime()) return "writ_expired";
  if (writ.status !== "ACTIVE") return "writ_revoked";
  return null;
}

/** H_verifier as stored on the purchase's combiner decisions row; null before the pipeline recorded one. */
export async function storedVerifierHash(db: Db, purchaseId: string): Promise<Uint8Array | null> {
  const [row] = await db
    .select({ hash: decisions.outputHash })
    .from(decisions)
    .where(and(eq(decisions.purchaseId, purchaseId), eq(decisions.stage, "combiner")));
  return row?.hash ?? null;
}

export async function toSnapshot(db: Db, row: Purchase): Promise<PurchaseSnapshot> {
  const [approval] = await db
    .select({ id: approvals.id, expiresAt: approvals.expiresAt })
    .from(approvals)
    .where(eq(approvals.purchaseId, row.id));
  return {
    purchaseId: row.id,
    tenantId: row.tenantId,
    writId: row.writId,
    cartId: row.cartId,
    agentId: row.agentId,
    state: row.state,
    stateReason: (row.stateReason ?? null) as PurchaseStateReason | null,
    finalVerdict: row.finalVerdict ?? null,
    amountMinor: row.amountMinor,
    currency: row.currency,
    paypal: { orderId: row.paypalOrderId, authorizationId: row.authorizationId, captureId: row.captureId, refundId: row.refundId },
    cPre: row.cPre === null ? null : toHex(row.cPre),
    cPost: row.cPost === null ? null : toHex(row.cPost),
    approvalId: approval?.id ?? null,
    approvalExpiresAt: approval?.expiresAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
