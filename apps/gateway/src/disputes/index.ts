// Dispute engine (P0-9, plan §6.4): a verified CUSTOMER.DISPUTE.* event → re-fetch from PayPal → load the
// evidence chain → analyst → auto PROVIDE_EVIDENCE only at confidence ≥ 0.8 with a user-authorized or
// fulfilled finding; everything else waits for a human click. Buyer messages are untrusted (T12). Without
// an analyst model the dispute goes to a person; nothing is decided for them.
import {
  ANALYST_UNAVAILABLE,
  canAutoExecute,
  DisputeAnalysisSchema,
  type DisputeAction,
  type DisputeAnalysis,
  type JsonValue,
} from "@writ/core";
import type { DisputeView, SimulateDisputeRequest } from "@writ/core/api";
import { acceptClaim, adjudicate, escalateDispute, getDispute, moneyToMinor, PayPalApiError, provideEvidence, requireEvidence, type Dispute } from "@writ/paypal";
import { and, desc, eq } from "drizzle-orm";
import type { JobOutcome, JobRegistration, PurchaseSaga } from "../contracts/index";
import { decisions, disputes, purchases, type Dispute as DisputeRow, type Purchase } from "../db/schema";
import { requireDb, type CoreServices } from "../deps";
import { assemblePack, evidencePdf } from "../evidence/index";
import { httpError } from "../http/errors";

type Deps = CoreServices & { saga: PurchaseSaga };

export function disputeView(row: DisputeRow): DisputeView {
  const liability = DisputeAnalysisSchema.shape.liability.safeParse(row.liability);
  const action = DisputeAnalysisSchema.shape.action.safeParse(row.action);
  return {
    dispute_id: row.id,
    paypal_dispute_id: row.paypalDisputeId,
    purchase_id: row.purchaseId as DisputeView["purchase_id"],
    reason: row.reason,
    status: row.status,
    stage: row.stage,
    liability: liability.success ? liability.data : null,
    action: action.success ? action.data : null,
    confidence: row.confidence,
    outcome: row.outcome,
    needs_human: row.needsHuman,
    amount_minor: row.amountMinor === null ? null : row.amountMinor.toString(),
    currency: row.currency,
    synthetic: row.synthetic,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function captureIdOf(dispute: Dispute): string | null {
  for (const transaction of dispute.disputed_transactions ?? []) {
    const id = (transaction as { seller_transaction_id?: unknown }).seller_transaction_id;
    if (typeof id === "string") return id;
  }
  return null;
}

function buyerMessages(dispute: Dispute): string[] {
  const messages = (dispute as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message: { posted_by?: unknown; content?: unknown }) => (message.posted_by === "BUYER" && typeof message.content === "string" ? [message.content] : []));
}

function isResolved(dispute: Dispute): boolean {
  return dispute.status === "RESOLVED";
}

function wonBySeller(dispute: Dispute): boolean {
  return (dispute.dispute_outcome?.outcome_code ?? "").includes("SELLER");
}

async function analyze(deps: Deps, row: DisputeRow, purchase: Purchase, dispute: Dispute): Promise<DisputeAnalysis> {
  const analyst = deps.ai.analyst;
  if (analyst === null) return ANALYST_UNAVAILABLE;
  const db = requireDb(deps);
  const assembled = await assemblePack(deps, purchase.tenantId, purchase.id);
  const [human] = await db.select({ verdict: decisions.verdict }).from(decisions).where(and(eq(decisions.purchaseId, purchase.id), eq(decisions.stage, "human")));
  const [combiner] = await db.select({ verdict: decisions.verdict }).from(decisions).where(and(eq(decisions.purchaseId, purchase.id), eq(decisions.stage, "combiner")));
  const check = (name: string): boolean => assembled?.verification.checks.find((c) => c.name === name)?.status === "PASS";
  const signature = assembled?.pack.writ.signature as { kind?: "webauthn" | "device-ed25519" } | undefined;
  const result = await analyst.analyze({
    dispute: {
      paypal_dispute_id: row.paypalDisputeId,
      reason: row.reason,
      status: row.status,
      stage: row.stage,
      amount_minor: row.amountMinor?.toString() ?? null,
      currency: row.currency,
      buyer_messages: buyerMessages(dispute),
    },
    evidence: {
      writ_signed: assembled !== null,
      signature_kind: signature?.kind ?? null,
      purpose: String((assembled?.pack.writ.body as { purpose?: unknown } | undefined)?.purpose ?? "") || null,
      human_approval: human === undefined ? "not_required" : human.verdict === "APPROVE" ? "approved" : "declined",
      verifier_verdict: combiner?.verdict ?? null,
      captured: purchase.captureId !== null,
      amount_matches: check("committed_amount"),
      fulfillment: "simulated",
      chain_verified: assembled?.verification.ok === true,
    },
  });
  return result.ok ? result.value : ANALYST_UNAVAILABLE;
}

export function disputeJobs(deps: Deps): JobRegistration {
  const sync = async (job: { payload: { paypal_dispute_id: string; event_id: string | null } }): Promise<JobOutcome> => {
    if (deps.paypal === null) return { status: "retry", error: "PayPal is not configured; cannot re-fetch the dispute", delayMs: 60_000 };
    const db = requireDb(deps);
    const view = await getDispute(deps.paypal.http, job.payload.paypal_dispute_id);
    const dispute = view.dispute;
    const captureId = captureIdOf(dispute);
    const [purchase] = captureId === null ? [] : await db.select().from(purchases).where(and(eq(purchases.captureId, captureId), eq(purchases.synthetic, false)));
    if (purchase === undefined) {
      deps.log.warn({ paypal_dispute_id: dispute.dispute_id }, "dispute does not match any purchase of ours");
      return { status: "done" };
    }
    const amount = dispute.dispute_amount;
    const values = {
      reason: dispute.reason ?? null,
      status: dispute.status,
      stage: dispute.dispute_life_cycle_stage ?? null,
      amountMinor: amount === undefined ? null : moneyToMinor(amount, purchase.currency),
      currency: purchase.currency,
      paypalSnapshot: dispute as unknown as JsonValue,
      updatedAt: deps.clock(),
    };

    const row = await deps.uow.run(purchase.tenantId, async (ctx) => {
      await ctx.lockWrit(purchase.writId);
      const [existing] = await ctx.db.select().from(disputes).where(and(eq(disputes.paypalDisputeId, dispute.dispute_id), eq(disputes.tenantId, purchase.tenantId), eq(disputes.synthetic, false)));
      let saved: DisputeRow | undefined;
      if (existing === undefined) {
        [saved] = await ctx.db
          .insert(disputes)
          .values({ id: deps.ids("dispute"), tenantId: purchase.tenantId, paypalDisputeId: dispute.dispute_id, purchaseId: purchase.id, createdAt: ctx.now, ...values })
          .returning();
        await deps.saga.markDisputed(ctx, { purchaseId: purchase.id, paypalDisputeId: dispute.dispute_id });
      } else {
        [saved] = await ctx.db.update(disputes).set(values).where(eq(disputes.id, existing.id)).returning();
        await ctx.appendLedger({ writId: purchase.writId, purchaseId: purchase.id, type: "DISPUTE_UPDATED", payload: { paypal_dispute_id: dispute.dispute_id, status: dispute.status, stage: dispute.dispute_life_cycle_stage ?? null, debug_id: view.debugId } });
      }
      if (saved === undefined) throw new Error("dispute upsert returned no row");
      if (isResolved(dispute)) {
        const won = wonBySeller(dispute);
        await deps.saga.resolveDispute(ctx, { purchaseId: purchase.id, paypalDisputeId: dispute.dispute_id, outcome: won ? "WON" : "LOST" });
        [saved] = await ctx.db.update(disputes).set({ outcome: dispute.dispute_outcome?.outcome_code ?? (won ? "WON" : "LOST"), needsHuman: false, resolvedAt: ctx.now }).where(eq(disputes.id, saved.id)).returning();
      }
      if (saved === undefined) throw new Error("dispute update returned no row");
      ctx.emit({ type: "dispute.updated", data: disputeView(saved) });
      return saved;
    });

    if (row.analysis !== null || isResolved(dispute)) return { status: "done" };
    const analysis = await analyze(deps, row, purchase, dispute);
    await deps.uow.run(purchase.tenantId, async (ctx) => {
      const auto = canAutoExecute(analysis);
      const [saved] = await ctx.db
        .update(disputes)
        .set({ analysis: analysis as unknown as JsonValue, action: analysis.action, liability: analysis.liability, confidence: analysis.confidence, needsHuman: !auto, updatedAt: ctx.now })
        .where(eq(disputes.id, row.id))
        .returning();
      await ctx.appendLedger({ writId: purchase.writId, purchaseId: purchase.id, type: "DISPUTE_ANALYZED", payload: { paypal_dispute_id: dispute.dispute_id, liability: analysis.liability, action: analysis.action, confidence: analysis.confidence } });
      if (auto) await ctx.enqueue({ topic: "dispute.execute", payload: { dispute_id: row.id as never, action: analysis.action, requested_by: "auto" }, dedupeKey: `dispute.execute:${row.id}:auto` });
      if (saved !== undefined) ctx.emit({ type: "dispute.updated", data: disputeView(saved) });
    });
    return { status: "done" };
  };

  const execute = async (job: { tenantId: string; payload: { dispute_id: string; action: DisputeAction } }): Promise<JobOutcome> => {
    if (deps.paypal === null) return { status: "retry", error: "PayPal is not configured", delayMs: 60_000 };
    const db = requireDb(deps);
    const [row] = await db.select().from(disputes).where(and(eq(disputes.id, job.payload.dispute_id), eq(disputes.tenantId, job.tenantId)));
    if (row === undefined || row.purchaseId === null) return { status: "dead", error: "dispute has no purchase" };
    const [purchase] = await db.select().from(purchases).where(eq(purchases.id, row.purchaseId));
    if (purchase === undefined) return { status: "dead", error: "dispute lost its purchase" };
    const analysis = DisputeAnalysisSchema.safeParse(row.analysis);
    const note = analysis.success ? analysis.data.note : "See the attached evidence.";
    let debugId: string | null = null;
    let type: "DISPUTE_EVIDENCE_SUBMITTED" | "DISPUTE_CLAIM_ACCEPTED" | "DISPUTE_UPDATED";
    try {
      if (job.payload.action === "PROVIDE_EVIDENCE") {
        const assembled = await assemblePack(deps, purchase.tenantId, purchase.id);
        if (assembled === null) return { status: "dead", error: "no evidence pack for this purchase" };
        const pdf = await evidencePdf(assembled.pack, assembled.verification);
        const response = await provideEvidence(deps.paypal.multipart, {
          disputeId: row.paypalDisputeId,
          evidences: [{ evidenceType: "PROOF_OF_FULFILLMENT", notes: note.slice(0, 2000) }],
          files: [{ filename: "writ-evidence.pdf", contentType: "application/pdf", data: pdf }],
          requestId: `${row.paypalDisputeId}:evidence:${job.payload.dispute_id}`,
        });
        debugId = response.debugId;
        type = "DISPUTE_EVIDENCE_SUBMITTED";
      } else if (job.payload.action === "ACCEPT_CLAIM") {
        const response = await acceptClaim(deps.paypal.http, { disputeId: row.paypalDisputeId, note: note.slice(0, 2000) });
        debugId = response.debugId;
        type = "DISPUTE_CLAIM_ACCEPTED";
      } else if (job.payload.action === "ESCALATE_TO_HUMAN") {
        return { status: "done" }; // Already with a person: needs_human stays set.
      } else {
        return { status: "dead", error: `${job.payload.action} is not automated; handle it in PayPal` };
      }
    } catch (error) {
      if (error instanceof PayPalApiError && error.status >= 400 && error.status < 500 && error.status !== 429) {
        deps.log.error({ err: error, dispute: row.id }, "PayPal refused the dispute action");
        await db.update(disputes).set({ needsHuman: true, updatedAt: deps.clock() }).where(eq(disputes.id, row.id));
        return { status: "dead", error: error.message.slice(0, 500) };
      }
      return { status: "retry", error: error instanceof Error ? error.message.slice(0, 500) : String(error) };
    }
    await deps.uow.run(job.tenantId, async (ctx) => {
      await ctx.appendLedger({ writId: purchase.writId, purchaseId: purchase.id, type, payload: { paypal_dispute_id: row.paypalDisputeId, action: job.payload.action, ...(debugId === null ? {} : { debug_id: debugId }) } });
      const [saved] = await ctx.db.update(disputes).set({ needsHuman: false, updatedAt: ctx.now }).where(eq(disputes.id, row.id)).returning();
      if (saved !== undefined) ctx.emit({ type: "dispute.updated", data: disputeView(saved) });
    });
    return { status: "done" };
  };

  return { handlers: { "dispute.sync": sync, "dispute.execute": execute }, periodic: [] };
}

export async function listDisputes(deps: CoreServices, tenantId: string): Promise<DisputeView[]> {
  const rows = await requireDb(deps).select().from(disputes).where(eq(disputes.tenantId, tenantId)).orderBy(desc(disputes.createdAt)).limit(500);
  return rows.map(disputeView);
}

export async function loadDispute(deps: CoreServices, tenantId: string, disputeId: string): Promise<DisputeRow> {
  const [row] = await requireDb(deps)
    .select()
    .from(disputes)
    .where(and(eq(disputes.id, disputeId), eq(disputes.tenantId, tenantId)));
  if (row === undefined) throw httpError.notFound("Dispute");
  return row;
}

/** A human click (console or Wallet): enqueue the action; PayPal is called after commit. */
export async function requestDisputeAction(deps: CoreServices, tenantId: string, disputeId: string, action: DisputeAction): Promise<DisputeView> {
  const row = await loadDispute(deps, tenantId, disputeId);
  return deps.uow.run(tenantId, async (ctx) => {
    await ctx.enqueue({ topic: "dispute.execute", payload: { dispute_id: row.id as never, action, requested_by: "human" }, dedupeKey: `dispute.execute:${row.id}:human:${action}` });
    return disputeView(row);
  });
}

/** Sandbox-only helpers for the demo: PayPal's own sandbox endpoints, labeled "sandbox adjudication" in the UI. */
export async function simulateDispute(deps: CoreServices, tenantId: string, purchaseId: string, request: SimulateDisputeRequest): Promise<DisputeView> {
  if (deps.paypal === null) throw httpError.unavailable("paypal_unconfigured", "PayPal is not configured on this gateway.");
  const [row] = await requireDb(deps)
    .select()
    .from(disputes)
    .where(and(eq(disputes.purchaseId, purchaseId), eq(disputes.tenantId, tenantId)));
  if (row === undefined) throw httpError.notFound("Dispute");
  const disputeId = row.paypalDisputeId;
  if (request.step === "escalate") await escalateDispute(deps.paypal.http, { disputeId, note: "Escalated for sandbox review." });
  else if (request.step === "require-evidence") await requireEvidence(deps.paypal.http, { disputeId, action: "SELLER_EVIDENCE" });
  else await adjudicate(deps.paypal.http, { disputeId, outcome: request.outcome ?? "SELLER_FAVOR" });
  await deps.uow.run(tenantId, async (ctx) => {
    await ctx.enqueue({ topic: "dispute.sync", payload: { paypal_dispute_id: disputeId, event_id: null } });
  });
  return disputeView(row);
}
