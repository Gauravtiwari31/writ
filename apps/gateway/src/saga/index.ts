// Purchase saga (P0-5, plan §6.3, §6.8; docs/ARCHITECTURE.md §5). Each transition is one UnitOfWork
// transaction with its ledger events and outbox rows; PayPal is called only by the job handlers below,
// after COMMIT, with PayPal-Request-Id = <purchase_id>:<step>. No LLM reaches this module (§22 rule 8).
import {
  approvalBody,
  ApprovalRequestSchema,
  APPROVAL_SPEC,
  APPROVAL_TIMEOUT_MS,
  CartSchema,
  COMBINER_REASON_CODES,
  commitPost,
  commitPre,
  maxVerdict,
  PIPELINE_PURCHASE_STATES,
  policyDecisionHash,
  RECOVERABLE_PURCHASE_STATES,
  STALLED_PIPELINE_MS,
  AUTHORIZE_WAIT_MS,
  toCustomId,
  toHex,
  toInvoiceId,
  VerificationRecordSchema,
  verificationRecordHash,
  VOIDABLE_PURCHASE_STATES,
  writShort,
  type CombinerReasonCode,
  type PolicyDecision,
  type PurchaseState,
  type Verdict,
  type VerificationRecord,
} from "@writ/core";
import {
  authorizeWithVault,
  captureAuthorization,
  getOrder,
  moneyToMinor,
  PayPalApiError,
  PayPalFlowError,
  refundCapture,
  voidAuthorization,
} from "@writ/paypal";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { approvalExpireHandler, approvalUpdatedEvent, expireOverdueApprovals } from "../approvals/index";
import { reserveBudget } from "../budget/reservations";
import { PurchaseStateChangedError, type JobOutcome, type JobRegistration, type OutboxTopic, type PurchaseSaga, type PurchaseSnapshot } from "../contracts/index";
import { approvals, carts, decisions, outbox, paypalVaultTokens, purchases, writs, type Purchase } from "../db/schema";
import { requireDb, type CoreServices } from "../deps";
import { budgetView } from "../http/views";
import type { TxContext } from "../tx/unit-of-work";
import { paypalWebhookHandler } from "../webhooks/index";
import { holdToVoiding, lockPurchase, moveTo, releaseHold, reverseSettled, settleHold, storedVerifierHash, toSnapshot, writBlockReason } from "./core";

const EXECUTE_WAIT_MS = 10_000;
const WAIT_POLL_MS = 100;
/** A money step whose job has been quiet this long gets checked for a live outbox row. */
const STEP_STALE_MS = 60_000;
const RECOVERY_INTERVAL_MS = 30_000;
const APPROVAL_SWEEP_INTERVAL_MS = 60_000;
const RECOVERY_BATCH = 100;

function debugIdOf(error: unknown): string | null {
  return error instanceof PayPalApiError || error instanceof PayPalFlowError ? error.debugId : null;
}

/** 4xx other than rate limits and timeouts: retrying the same request cannot change PayPal's answer. */
function isPermanent(error: unknown): error is PayPalApiError {
  return error instanceof PayPalApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function withDebugId(payload: Record<string, string | null>, debugId: string | null): Record<string, string | null> {
  return debugId === null ? payload : { ...payload, debug_id: debugId };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createPurchaseSaga(deps: CoreServices): PurchaseSaga {
  const read = async (tenantId: string, purchaseId: string): Promise<PurchaseSnapshot | null> => {
    const db = requireDb(deps);
    const [row] = await db
      .select()
      .from(purchases)
      .where(and(eq(purchases.id, purchaseId), eq(purchases.tenantId, tenantId)));
    return row === undefined ? null : toSnapshot(db, row);
  };

  /** Real time on purpose: the job runner works in real time whatever clock the ledger uses. */
  const waitUntilSettled = async (tenantId: string, purchaseId: string, pending: readonly PurchaseState[], waitMs: number): Promise<PurchaseSnapshot> => {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const snapshot = await read(tenantId, purchaseId);
      if (snapshot === null) throw new Error(`purchase ${purchaseId} disappeared`);
      if (!pending.includes(snapshot.state) || Date.now() >= deadline) return snapshot;
      await sleep(WAIT_POLL_MS);
    }
  };

  async function blockWithPolicy(ctx: TxContext, row: Purchase, reason: "policy_blocked" | "budget_exhausted", detail: string, policy: PolicyDecision | null): Promise<void> {
    if (policy !== null) {
      await ctx.appendLedger({
        writId: row.writId,
        purchaseId: row.id,
        type: "POLICY_DECIDED",
        payload: { policy_hash: toHex(policyDecisionHash(policy)), verdict: policy.verdict },
      });
    }
    await ctx.appendLedger({ writId: row.writId, purchaseId: row.id, type: "PURCHASE_BLOCKED", payload: { reason, detail, money_moved_minor: "0" } });
    await moveTo(ctx, row, "BLOCKED", { stateReason: reason, stateDetail: detail, finalVerdict: "BLOCK" });
  }

  return {
    async open(input) {
      if (input.amountMinor <= 0n) throw new RangeError("a purchase amount must be positive");
      return deps.uow.run(input.tenantId, async (ctx) => {
        const id = deps.ids("purchase");
        const inserted = await ctx.db
          .insert(purchases)
          .values({
            id,
            tenantId: input.tenantId,
            writId: input.writId,
            cartId: input.cartId,
            agentId: input.agentId,
            state: "PROPOSED",
            amountMinor: input.amountMinor,
            currency: input.currency,
            idempotencyKey: input.idempotencyKey,
            createdAt: ctx.now,
            updatedAt: ctx.now,
          })
          .onConflictDoNothing({ target: [purchases.agentId, purchases.idempotencyKey] })
          .returning();
        const created = inserted[0];
        if (created !== undefined) return { purchase: await toSnapshot(ctx.db, created), replayed: false };
        const [existing] = await ctx.db
          .select()
          .from(purchases)
          .where(and(eq(purchases.agentId, input.agentId), eq(purchases.idempotencyKey, input.idempotencyKey), eq(purchases.tenantId, input.tenantId)));
        if (existing === undefined) throw new Error("idempotency conflict without a visible row");
        return { purchase: await toSnapshot(ctx.db, existing), replayed: true };
      });
    },

    async block(input) {
      return deps.uow.run(input.tenantId, async (ctx) => {
        const row = await lockPurchase(ctx, input.purchaseId);
        if (row.state !== "PROPOSED") return toSnapshot(ctx.db, row);
        await blockWithPolicy(ctx, row, input.reason, input.detail, input.policy);
        return (await readInTx(ctx, input.purchaseId));
      });
    },

    async reserveAndAuthorize(input) {
      await deps.uow.run(input.tenantId, async (ctx) => {
        const row = await lockPurchase(ctx, input.purchaseId);
        if (row.state !== "PROPOSED") return;
        const stop = await writBlockReason(ctx, row.writId);
        if (stop !== null) {
          await blockWithPolicy(ctx, row, "policy_blocked", `The Writ is no longer active (${stop}).`, input.policy);
          return;
        }
        const budget = await reserveBudget(ctx.db, { writId: row.writId, amountMinor: row.amountMinor });
        if (budget === null) {
          await blockWithPolicy(ctx, row, "budget_exhausted", "The Writ has no budget or order slot left for this cart.", input.policy);
          return;
        }
        ctx.emit({ type: "budget.updated", data: budgetView(budget) });
        const policyHash = policyDecisionHash(input.policy);
        await ctx.appendLedger({
          writId: row.writId,
          purchaseId: row.id,
          type: "POLICY_DECIDED",
          payload: { policy_hash: toHex(policyHash), verdict: input.policy.verdict },
        });
        await ctx.appendLedger({ writId: row.writId, purchaseId: row.id, type: "BUDGET_RESERVED", payload: { amount_minor: row.amountMinor.toString() } });
        const reserved = await moveTo(ctx, row, "RESERVED");

        const fail = async (reason: "paypal_unconfigured" | "paypal_not_connected", detail: string): Promise<void> => {
          await ctx.appendLedger({ writId: row.writId, purchaseId: row.id, type: "PURCHASE_FAILED", payload: { reason, detail } });
          await releaseHold(ctx, reserved);
          await moveTo(ctx, reserved, "FAILED", { stateReason: reason, stateDetail: detail });
        };
        if (deps.paypal === null) {
          await fail("paypal_unconfigured", "PayPal is not configured on this gateway.");
          return;
        }
        const [writ] = await ctx.db.select({ userId: writs.userId, bodyHash: writs.bodyHash }).from(writs).where(eq(writs.id, row.writId));
        const [cart] = await ctx.db.select({ bodyHash: carts.bodyHash }).from(carts).where(eq(carts.id, row.cartId));
        if (writ === undefined || cart === undefined) throw new Error(`purchase ${row.id} lost its Writ or cart`);
        const [token] = await ctx.db
          .select({ id: paypalVaultTokens.id })
          .from(paypalVaultTokens)
          .where(and(eq(paypalVaultTokens.userId, writ.userId), eq(paypalVaultTokens.tenantId, ctx.tenantId), eq(paypalVaultTokens.status, "ACTIVE")))
          .limit(1);
        if (token === undefined) {
          await fail("paypal_not_connected", "The Writ's owner has not connected a PayPal wallet.");
          return;
        }
        const cPre = commitPre(writ.bodyHash, cart.bodyHash, policyHash);
        await moveTo(ctx, reserved, "AUTHORIZING", { cPre, vaultTokenId: token.id });
        await ctx.enqueue({ topic: "purchase.authorize", payload: { purchase_id: row.id } });
      });
      return waitUntilSettled(input.tenantId, input.purchaseId, ["AUTHORIZING"], input.waitMs ?? AUTHORIZE_WAIT_MS);
    },

    async beginVerification(input) {
      return deps.uow.run(input.tenantId, async (ctx) => {
        const row = await lockPurchase(ctx, input.purchaseId);
        if (row.state === "VERIFYING") return toSnapshot(ctx.db, row);
        if (row.state !== "AUTHORIZED") throw new PurchaseStateChangedError(await toSnapshot(ctx.db, row));
        return toSnapshot(ctx.db, await moveTo(ctx, row, "VERIFYING"));
      });
    },

    async execute(input) {
      await deps.uow.run(input.tenantId, async (ctx) => {
        const row = await lockPurchase(ctx, input.purchaseId);
        if (row.state !== "VERIFYING") throw new PurchaseStateChangedError(await toSnapshot(ctx.db, row));
        if (row.cPre === null) throw new Error(`purchase ${row.id} reached VERIFYING without C_pre`);
        const cPre = row.cPre;

        const checked = await checkVerification(ctx, row, input.verification, input.decisionId);
        await ctx.appendLedger({
          writId: row.writId,
          purchaseId: row.id,
          type: "VERIFIER_DECIDED",
          payload: { verifier_hash: toHex(checked.verifierHash), final: checked.final, decision_id: input.decisionId },
        });
        const cPost = commitPost(cPre, checked.verifierHash, null);

        const stop = await writBlockReason(ctx, row.writId);
        if (stop !== null) {
          await holdToVoiding(ctx, row, stop, { cPost, finalVerdict: "BLOCK" });
          return;
        }
        if (checked.final === "BLOCK") {
          await holdToVoiding(ctx, row, "verifier_blocked", { cPost, finalVerdict: "BLOCK" });
          return;
        }
        if (checked.final === "APPROVE") {
          if (!(await settleHold(ctx, row))) {
            await holdToVoiding(ctx, row, "settle_refused", { cPost, finalVerdict: "APPROVE" });
            return;
          }
          await moveTo(ctx, row, "CAPTURING", { cPost, finalVerdict: "APPROVE" });
          await ctx.enqueue({ topic: "purchase.capture", payload: { purchase_id: row.id } });
          return;
        }
        await enterHumanReview(ctx, row, input.verification, cPre);
      });
      return waitUntilSettled(input.tenantId, input.purchaseId, ["CAPTURING", "VOIDING"], input.waitMs ?? EXECUTE_WAIT_MS);
    },

    async requestVoids(ctx, input) {
      if (input.writIds.length === 0) return [];
      for (const writId of input.writIds) await ctx.lockWrit(writId);
      const rows = await ctx.db
        .select()
        .from(purchases)
        .where(
          and(
            eq(purchases.tenantId, ctx.tenantId),
            inArray(purchases.writId, [...input.writIds]),
            inArray(purchases.state, [...VOIDABLE_PURCHASE_STATES]),
          ),
        )
        .for("update");
      const moved: string[] = [];
      for (const row of rows) {
        const verifierHash = await storedVerifierHash(ctx.db, row.id);
        const cPost = row.cPre !== null && verifierHash !== null ? commitPost(row.cPre, verifierHash, null) : null;
        if (row.state === "AWAITING_HUMAN") {
          await ctx.db.update(approvals).set({ status: "CANCELLED" }).where(and(eq(approvals.purchaseId, row.id), eq(approvals.status, "PENDING")));
        }
        await holdToVoiding(ctx, row, input.reason, cPost === null ? {} : { cPost });
        moved.push(row.id);
      }
      return moved;
    },

    async markDisputed(ctx, input) {
      const row = await lockPurchase(ctx, input.purchaseId);
      if (row.state !== "CAPTURED") return;
      await ctx.appendLedger({ writId: row.writId, purchaseId: row.id, type: "DISPUTE_OPENED", payload: { paypal_dispute_id: input.paypalDisputeId } });
      await moveTo(ctx, row, "DISPUTED", { stateReason: "dispute_opened" });
    },

    async resolveDispute(ctx, input) {
      const row = await lockPurchase(ctx, input.purchaseId);
      if (row.state !== "DISPUTED") return;
      await ctx.appendLedger({ writId: row.writId, purchaseId: row.id, type: "DISPUTE_RESOLVED", payload: { paypal_dispute_id: input.paypalDisputeId, outcome: input.outcome } });
      await moveTo(ctx, row, input.outcome === "WON" ? "DISPUTE_WON" : "DISPUTE_LOST", { stateReason: input.outcome === "WON" ? "dispute_won" : "dispute_lost" });
    },

    async requestRefund(ctx, input) {
      const row = await lockPurchase(ctx, input.purchaseId);
      if (row.state !== "CAPTURED" && row.state !== "DISPUTED") throw new PurchaseStateChangedError(await toSnapshot(ctx.db, row));
      await ctx.enqueue({ topic: "purchase.refund", payload: { purchase_id: row.id, reason: input.reason }, dedupeKey: `purchase.refund:${row.id}` });
    },

    get: (input) => read(input.tenantId, input.purchaseId),
  };

  async function readInTx(ctx: TxContext, purchaseId: string): Promise<PurchaseSnapshot> {
    const [row] = await ctx.db.select().from(purchases).where(eq(purchases.id, purchaseId));
    if (row === undefined) throw new Error(`purchase ${purchaseId} disappeared`);
    return toSnapshot(ctx.db, row);
  }

  /**
   * The saga never trusts the record it is handed: it must be about this purchase and match what the
   * pipeline stored, and `final` can only tighten to the strictest contribution. Anything else is a
   * fail-closed BLOCK.
   */
  async function checkVerification(ctx: TxContext, row: Purchase, verification: VerificationRecord, decisionId: string): Promise<{ final: Verdict; verifierHash: Uint8Array }> {
    const parsed = VerificationRecordSchema.safeParse(verification);
    const [cart] = await ctx.db.select({ bodyHash: carts.bodyHash }).from(carts).where(eq(carts.id, row.cartId));
    const [stored] = await ctx.db
      .select({ hash: decisions.outputHash, purchaseId: decisions.purchaseId, stage: decisions.stage })
      .from(decisions)
      .where(eq(decisions.id, decisionId));
    const verifierHash = parsed.success ? verificationRecordHash(parsed.data) : new Uint8Array(32);
    const matches =
      parsed.success &&
      row.cPre !== null &&
      parsed.data.purchase_id === row.id &&
      parsed.data.c_pre === toHex(row.cPre) &&
      cart !== undefined &&
      parsed.data.cart_hash === toHex(cart.bodyHash) &&
      stored !== undefined &&
      stored.purchaseId === row.id &&
      stored.stage === "combiner" &&
      stored.hash !== null &&
      toHex(stored.hash) === toHex(verifierHash);
    if (!matches || !parsed.success) {
      deps.log.error({ purchase_id: row.id, decision_id: decisionId }, "verification record does not match the purchase: failing closed");
      return { final: "BLOCK", verifierHash };
    }
    const final = maxVerdict(parsed.data.final, ...parsed.data.contributions.map((c) => c.verdict));
    return { final, verifierHash };
  }

  async function enterHumanReview(ctx: TxContext, row: Purchase, verification: VerificationRecord, cPre: Uint8Array): Promise<void> {
    const [writ] = await ctx.db.select({ bodyHash: writs.bodyHash }).from(writs).where(eq(writs.id, row.writId));
    const [cart] = await ctx.db.select({ bodyHash: carts.bodyHash }).from(carts).where(eq(carts.id, row.cartId));
    if (writ === undefined || cart === undefined) throw new Error(`purchase ${row.id} lost its Writ or cart`);
    const codes = [...new Set(verification.contributions.filter((c) => c.verdict === "REVIEW").map((c) => c.reason.code))].filter(
      (code): code is CombinerReasonCode => (COMBINER_REASON_CODES as readonly string[]).includes(code),
    );
    const id = deps.ids("approval");
    const expiresAt = new Date(ctx.now.getTime() + APPROVAL_TIMEOUT_MS);
    const request = ApprovalRequestSchema.parse({
      spec: APPROVAL_SPEC,
      approval_id: id,
      purchase_id: row.id,
      writ_id: row.writId,
      writ_hash: toHex(writ.bodyHash),
      cart_hash: toHex(cart.bodyHash),
      c_pre: toHex(cPre),
      amount_minor: row.amountMinor.toString(),
      currency: row.currency,
      review_codes: codes.length > 0 ? codes : ["VERIFIER_REVIEW"],
      requested_at: ctx.now.toISOString(),
      expires_at: expiresAt.toISOString(),
    });
    approvalBody(request, "APPROVE"); // A malformed request must fail here, not when the human signs.
    await ctx.db.insert(approvals).values({
      id,
      tenantId: ctx.tenantId,
      purchaseId: row.id,
      status: "PENDING",
      request,
      expiresAt,
      createdAt: ctx.now,
    });
    await ctx.appendLedger({
      writId: row.writId,
      purchaseId: row.id,
      type: "HUMAN_REVIEW_REQUESTED",
      payload: { approval_id: id, expires_at: request.expires_at, review_codes: request.review_codes },
    });
    await moveTo(ctx, row, "AWAITING_HUMAN", { finalVerdict: "REVIEW" });
    await ctx.enqueue({ topic: "approval.expire", payload: { approval_id: id }, availableAt: expiresAt });
    ctx.emit(await approvalUpdatedEvent(ctx.db, id));
  }
}

// ---------------------------------------------------------------- job handlers (after COMMIT)

function itemName(body: unknown): string {
  const cart = CartSchema.safeParse(body);
  if (!cart.success) return "Writ purchase";
  const first = cart.data.items[0];
  if (first === undefined) return "Writ purchase";
  const more = cart.data.items.length > 1 ? ` + ${cart.data.items.length - 1} more` : "";
  return `${first.title.slice(0, 127 - more.length)}${more}`;
}

function money(row: Purchase): { amount_minor: string; currency: string } {
  return { amount_minor: row.amountMinor.toString(), currency: row.currency };
}

export function sagaJobs(deps: CoreServices & { saga: PurchaseSaga }): JobRegistration {
  const load = async (tenantId: string, purchaseId: string): Promise<Purchase | null> => {
    const [row] = await requireDb(deps)
      .select()
      .from(purchases)
      .where(and(eq(purchases.id, purchaseId), eq(purchases.tenantId, tenantId)));
    return row ?? null;
  };
  const retry = (error: unknown): JobOutcome => ({ status: "retry", error: errorText(error) });

  async function failAuthorizing(tenantId: string, purchaseId: string, reason: "paypal_unconfigured" | "paypal_error" | "payer_action_required" | "authorization_declined", detail: string, debugId: string | null, orderId: string | null): Promise<void> {
    await deps.uow.run(tenantId, async (ctx) => {
      const row = await lockPurchase(ctx, purchaseId);
      if (row.state !== "AUTHORIZING") return;
      await ctx.appendLedger({ writId: row.writId, purchaseId: row.id, type: "PURCHASE_FAILED", payload: withDebugId({ reason, detail, order_id: orderId }, debugId) });
      await releaseHold(ctx, row);
      await moveTo(ctx, row, "FAILED", { stateReason: reason, stateDetail: detail, ...(orderId === null ? {} : { paypalOrderId: orderId }) });
    });
  }

  const authorize = async (job: { tenantId: string; payload: { purchase_id: string } }): Promise<JobOutcome> => {
    const row = await load(job.tenantId, job.payload.purchase_id);
    if (row === null || row.state !== "AUTHORIZING") return { status: "done" };
    if (deps.paypal === null) {
      await failAuthorizing(job.tenantId, row.id, "paypal_unconfigured", "PayPal is not configured on this gateway.", null, null);
      return { status: "done" };
    }
    if (row.cPre === null || row.vaultTokenId === null) return { status: "dead", error: `purchase ${row.id} is AUTHORIZING without C_pre or a vault token` };
    const db = requireDb(deps);
    const [token] = await db.select({ vaultId: paypalVaultTokens.vaultId }).from(paypalVaultTokens).where(eq(paypalVaultTokens.id, row.vaultTokenId));
    const [cart] = await db.select({ body: carts.body }).from(carts).where(eq(carts.id, row.cartId));
    if (token?.vaultId === null || token === undefined || cart === undefined) return { status: "dead", error: `purchase ${row.id} lost its vault token or cart` };
    const customId = toCustomId(writShort(row.writId), row.cPre);

    let result: Awaited<ReturnType<typeof authorizeWithVault>>;
    try {
      result = await authorizeWithVault(deps.paypal.http, {
        purchaseId: row.id,
        amountMinor: row.amountMinor,
        currency: row.currency,
        itemName: itemName(cart.body),
        vaultId: token.vaultId,
        customId,
      });
    } catch (error) {
      if (error instanceof PayPalFlowError) {
        await failAuthorizing(job.tenantId, row.id, "payer_action_required", errorText(error), error.debugId, error.resourceId);
        return { status: "done" };
      }
      if (isPermanent(error)) {
        await failAuthorizing(job.tenantId, row.id, "paypal_error", errorText(error), debugIdOf(error), null);
        return { status: "done" };
      }
      return retry(error); // Timeout, 5xx, 429: outcome unknown, same PayPal-Request-Id replays.
    }

    const authorization = result.authorization;
    const debugId = result.debugIds.createOrder;
    if (authorization.status !== "CREATED" && authorization.status !== "PENDING") {
      await failAuthorizing(job.tenantId, row.id, "authorization_declined", `PayPal returned authorization status ${authorization.status}.`, debugId, result.order.id);
      return { status: "done" };
    }
    await deps.uow.run(job.tenantId, async (ctx) => {
      const locked = await lockPurchase(ctx, row.id);
      if (locked.state !== "AUTHORIZING") return;
      await ctx.appendLedger({
        writId: locked.writId,
        purchaseId: locked.id,
        type: "PAYPAL_ORDER_CREATED",
        payload: withDebugId({ order_id: result.order.id, custom_id: customId, c_pre: toHex(row.cPre as Uint8Array), ...money(locked) }, debugId),
      });
      await ctx.appendLedger({
        writId: locked.writId,
        purchaseId: locked.id,
        type: "PAYPAL_AUTHORIZED",
        payload: withDebugId({ order_id: result.order.id, authorization_id: authorization.id, flow: result.flow }, result.debugIds.authorizeOrder ?? debugId),
      });
      const authorized = await moveTo(ctx, locked, "AUTHORIZED", { paypalOrderId: result.order.id, authorizationId: authorization.id });
      // PayPal must hold exactly what was asked; a Writ revoked meanwhile voids right away.
      const heldOk = authorization.amount === undefined || moneyToMinor(authorization.amount, locked.currency) === locked.amountMinor;
      const stop = await writBlockReason(ctx, locked.writId);
      if (!heldOk) await holdToVoiding(ctx, authorized, "paypal_error", { stateDetail: "PayPal authorized a different amount than requested." });
      else if (stop !== null) await holdToVoiding(ctx, authorized, stop);
    });
    return { status: "done" };
  };

  /** The capture went through on an earlier attempt whose answer was lost: read it back from the order. */
  async function findExistingCapture(row: Purchase): Promise<{ id: string; debugId: string | null } | null> {
    if (deps.paypal === null || row.paypalOrderId === null) return null;
    const order = await getOrder(deps.paypal.http, row.paypalOrderId);
    const unit = order.data.purchase_units?.[0];
    const capture = unit?.payments?.captures?.[0];
    return capture === undefined ? null : { id: capture.id, debugId: order.debugId };
  }

  const recordCaptured = async (tenantId: string, row: Purchase, captureId: string, debugId: string | null): Promise<void> => {
    if (row.cPost === null) throw new Error(`purchase ${row.id} captured without C_post`);
    const cPost = row.cPost;
    await deps.uow.run(tenantId, async (ctx) => {
      const locked = await lockPurchase(ctx, row.id);
      if (locked.state !== "CAPTURING") return;
      await ctx.appendLedger({
        writId: locked.writId,
        purchaseId: locked.id,
        type: "PAYPAL_CAPTURED",
        payload: withDebugId(
          { authorization_id: locked.authorizationId, capture_id: captureId, ...money(locked), c_post: toHex(cPost), invoice_id: toInvoiceId(cPost) },
          debugId,
        ),
      });
      await moveTo(ctx, locked, "CAPTURED", { captureId });
    });
  };

  const capture = async (job: { tenantId: string; payload: { purchase_id: string } }): Promise<JobOutcome> => {
    const row = await load(job.tenantId, job.payload.purchase_id);
    if (row === null || row.state !== "CAPTURING") return { status: "done" };
    if (deps.paypal === null) return { status: "retry", error: "PayPal is not configured; the capture stays pending", delayMs: 60_000 };
    if (row.authorizationId === null || row.cPost === null) return { status: "dead", error: `purchase ${row.id} is CAPTURING without an authorization or C_post` };
    try {
      const captured = await captureAuthorization(deps.paypal.http, {
        authorizationId: row.authorizationId,
        purchaseId: row.id,
        amountMinor: row.amountMinor, // Exactly the verified total (§22 rule 11).
        currency: row.currency,
        invoiceId: toInvoiceId(row.cPost),
      });
      if (captured.data.status === "DECLINED" || captured.data.status === "FAILED") {
        await refuseCapture(job.tenantId, row, `PayPal returned capture status ${captured.data.status}.`, captured.debugId);
        return { status: "done" };
      }
      await recordCaptured(job.tenantId, row, captured.data.id, captured.debugId);
      return { status: "done" };
    } catch (error) {
      if (error instanceof PayPalApiError && error.hasIssue("AUTHORIZATION_ALREADY_CAPTURED")) {
        const existing = await findExistingCapture(row);
        if (existing === null) return retry(error);
        await recordCaptured(job.tenantId, row, existing.id, existing.debugId);
        return { status: "done" };
      }
      if (isPermanent(error)) {
        await refuseCapture(job.tenantId, row, errorText(error), error.debugId);
        return { status: "done" };
      }
      return retry(error); // Unknown outcome: never void, retry with the same PayPal-Request-Id.
    }
  };

  async function refuseCapture(tenantId: string, row: Purchase, detail: string, debugId: string | null): Promise<void> {
    await deps.uow.run(tenantId, async (ctx) => {
      const locked = await lockPurchase(ctx, row.id);
      if (locked.state !== "CAPTURING") return;
      await ctx.appendLedger({ writId: locked.writId, purchaseId: locked.id, type: "PAYPAL_CAPTURE_FAILED", payload: withDebugId({ detail, authorization_id: locked.authorizationId }, debugId) });
      await reverseSettled(ctx, locked);
      await moveTo(ctx, locked, "VOIDING", { stateReason: "capture_failed", stateDetail: detail });
      await ctx.enqueue({ topic: "purchase.void", payload: { purchase_id: locked.id, reason: "capture_failed" } });
    });
  }

  const voidStep = async (job: { tenantId: string; payload: { purchase_id: string } }): Promise<JobOutcome> => {
    const row = await load(job.tenantId, job.payload.purchase_id);
    if (row === null || row.state !== "VOIDING") return { status: "done" };
    if (deps.paypal === null) return { status: "retry", error: "PayPal is not configured; the void stays pending", delayMs: 60_000 };
    if (row.authorizationId === null) return { status: "dead", error: `purchase ${row.id} is VOIDING without an authorization` };
    let debugId: string | null = null;
    try {
      const voided = await voidAuthorization(deps.paypal.http, { authorizationId: row.authorizationId, purchaseId: row.id });
      debugId = voided.debugId;
    } catch (error) {
      const alreadyVoided = error instanceof PayPalApiError && (error.hasIssue("PREVIOUSLY_VOIDED") || error.hasIssue("AUTHORIZATION_VOIDED"));
      if (!alreadyVoided) return retry(error);
      debugId = error.debugId;
    }
    await deps.uow.run(job.tenantId, async (ctx) => {
      const locked = await lockPurchase(ctx, row.id);
      if (locked.state !== "VOIDING") return;
      await ctx.appendLedger({
        writId: locked.writId,
        purchaseId: locked.id,
        type: "PAYPAL_VOIDED",
        payload: withDebugId({ authorization_id: locked.authorizationId, c_post: locked.cPost === null ? null : toHex(locked.cPost) }, debugId),
      });
      await moveTo(ctx, locked, "VOIDED");
    });
    return { status: "done" };
  };

  const refund = async (job: { tenantId: string; payload: { purchase_id: string } }): Promise<JobOutcome> => {
    const row = await load(job.tenantId, job.payload.purchase_id);
    if (row === null || row.state !== "CAPTURED") return { status: "done" };
    if (deps.paypal === null) return { status: "retry", error: "PayPal is not configured; the refund stays pending", delayMs: 60_000 };
    if (row.captureId === null) return { status: "dead", error: `purchase ${row.id} has no capture to refund` };
    try {
      const refunded = await refundCapture(deps.paypal.http, { captureId: row.captureId, purchaseId: row.id });
      await deps.uow.run(job.tenantId, async (ctx) => {
        const locked = await lockPurchase(ctx, row.id);
        if (locked.state !== "CAPTURED") return;
        await ctx.appendLedger({ writId: locked.writId, purchaseId: locked.id, type: "REFUNDED", payload: withDebugId({ refund_id: refunded.data.id, capture_id: locked.captureId, reason: "platform_liability" }, refunded.debugId) });
        await moveTo(ctx, locked, "REFUNDED", { refundId: refunded.data.id, stateReason: "platform_liability" });
      });
      return { status: "done" };
    } catch (error) {
      return retry(error);
    }
  };

  const STEP_TOPIC: Readonly<Record<(typeof RECOVERABLE_PURCHASE_STATES)[number], OutboxTopic>> = {
    AUTHORIZING: "purchase.authorize",
    CAPTURING: "purchase.capture",
    VOIDING: "purchase.void",
  };

  /** Keeps exactly one live job per in-flight money step, and fails closed anything no live checkout owns anymore. */
  const recovery = async (): Promise<void> => {
    const db = requireDb(deps);
    const now = deps.clock();
    const inFlight = await db
      .select({ id: purchases.id, tenantId: purchases.tenantId, state: purchases.state, stateReason: purchases.stateReason })
      .from(purchases)
      .where(
        and(
          inArray(purchases.state, [...RECOVERABLE_PURCHASE_STATES]),
          lt(purchases.updatedAt, new Date(now.getTime() - STEP_STALE_MS)),
          eq(purchases.synthetic, false),
        ),
      )
      .limit(RECOVERY_BATCH);
    for (const row of inFlight) {
      const topic = STEP_TOPIC[row.state as (typeof RECOVERABLE_PURCHASE_STATES)[number]];
      await deps.uow.run(row.tenantId, async (ctx) => {
        const [live] = await ctx.db
          .select({ id: outbox.id })
          .from(outbox)
          .where(and(eq(outbox.topic, topic), sql`${outbox.payload}->>'purchase_id' = ${row.id}`, isNull(outbox.publishedAt), isNull(outbox.deadAt)))
          .limit(1);
        if (live !== undefined) return;
        const locked = await lockPurchase(ctx, row.id);
        if (locked.state !== row.state) return;
        deps.log.warn({ purchase_id: row.id, state: row.state }, "recovery: re-enqueueing a money step");
        if (topic === "purchase.void") {
          await ctx.enqueue({ topic, payload: { purchase_id: row.id, reason: "verification_interrupted" } });
        } else {
          await ctx.enqueue({ topic, payload: { purchase_id: row.id } });
        }
      });
    }

    const stalled = await db
      .select({ id: purchases.id, tenantId: purchases.tenantId })
      .from(purchases)
      .where(
        and(
          inArray(purchases.state, [...PIPELINE_PURCHASE_STATES]),
          lt(purchases.updatedAt, new Date(now.getTime() - STALLED_PIPELINE_MS)),
          eq(purchases.synthetic, false),
        ),
      )
      .limit(RECOVERY_BATCH);
    for (const { id, tenantId } of stalled) {
      await deps.uow.run(tenantId, async (ctx) => {
        const row = await lockPurchase(ctx, id);
        const detail = "The checkout request ended before the purchase finished.";
        deps.log.warn({ purchase_id: id, state: row.state }, "recovery: failing a stalled purchase closed");
        if (row.state === "PROPOSED") {
          await ctx.appendLedger({ writId: row.writId, purchaseId: row.id, type: "PURCHASE_BLOCKED", payload: { reason: "checkout_interrupted", detail, money_moved_minor: "0" } });
          await moveTo(ctx, row, "BLOCKED", { stateReason: "checkout_interrupted", stateDetail: detail });
        } else if (row.state === "RESERVED") {
          await ctx.appendLedger({ writId: row.writId, purchaseId: row.id, type: "PURCHASE_FAILED", payload: { reason: "checkout_interrupted", detail } });
          await releaseHold(ctx, row);
          await moveTo(ctx, row, "FAILED", { stateReason: "checkout_interrupted", stateDetail: detail });
        } else if (row.state === "AUTHORIZED" || row.state === "VERIFYING") {
          await holdToVoiding(ctx, row, "verification_interrupted", { stateDetail: detail });
        }
      });
    }
  };

  return {
    handlers: {
      "purchase.authorize": authorize,
      "purchase.capture": capture,
      "purchase.void": voidStep,
      "purchase.refund": refund,
      "approval.expire": approvalExpireHandler(deps),
      "paypal.webhook": paypalWebhookHandler(deps),
    },
    periodic: [
      { name: "saga.recovery", intervalMs: RECOVERY_INTERVAL_MS, run: recovery },
      { name: "approvals.timeout", intervalMs: APPROVAL_SWEEP_INTERVAL_MS, run: () => expireOverdueApprovals(deps) },
    ],
  };
}

