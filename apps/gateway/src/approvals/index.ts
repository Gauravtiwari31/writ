// Human review (P0-6, plan §6.4). The human signs ApprovalBody = request + decision with a passkey,
// so the signature binds the exact purchase commitment and the choice. The decided ApprovalRecord is
// stored on the "human" decisions row (output, output_hash = H_approval); evidence reads it only from
// there (plan §6.7). A device key can decide only for a user with no passkey, so a stolen session
// cookie can never turn "approve with a passkey" into "approve with a cookie".
import {
  approvalBody,
  approvalHash,
  approvalRecordHash,
  ApprovalRecordSchema,
  ApprovalRequestSchema,
  CartSchema,
  commitPost,
  minorToString,
  toBase64Url,
  toHex,
  verifyDeviceEd25519,
  type ApprovalDecision,
  type ApprovalStatus,
  type JsonValue,
  type WritSignature,
} from "@writ/core";
import { ApprovalViewSchema, type ApprovalChallengeResponse, type ApprovalView, type DecideApprovalResponse, type StreamEvent } from "@writ/core/api";
import { verifyWebAuthnOverHash } from "@writ/core/signatures";
import { and, desc, eq, isNull, lte } from "drizzle-orm";
import type { JobHandler } from "../contracts/index";
import type { Db } from "../db/client";
import { approvals, carts, decisions, deviceKeys, passkeys, purchases, type Approval } from "../db/schema";
import { requireDb, type CoreServices } from "../deps";
import { httpError } from "../http/errors";
import { decisionView, purchaseView } from "../http/views";
import { holdToVoiding, lockPurchase, moveTo, settleHold, storedVerifierHash, writBlockReason } from "../saga/core";
import type { TxContext } from "../tx/unit-of-work";

const PLAIN_REASONS: Readonly<Record<string, string>> = {
  REVIEW_THRESHOLD: "This is above the amount you asked to approve yourself.",
  SENTINEL_FLAGGED: "A page behind this cart contained text that looks like instructions to the agent.",
  SENTINEL_ERROR: "The page safety check could not finish, so Writ is asking you.",
  SENTINEL_TIMEOUT: "The page safety check took too long, so Writ is asking you.",
  SENTINEL_MISSING: "The page safety check is not available, so Writ is asking you.",
  SENTINEL_INVALID_OUTPUT: "The page safety check gave an unusable answer, so Writ is asking you.",
  VERIFIER_MISSING: "The independent check is not available, so Writ is asking you.",
  VERIFIER_ERROR: "The independent check could not finish, so Writ is asking you.",
  VERIFIER_TIMEOUT: "The independent check took too long, so Writ is asking you.",
  VERIFIER_INVALID_OUTPUT: "The independent check gave an unusable answer, so Writ is asking you.",
  VERIFIER_REVIEW: "The independent check wants you to take a look.",
  VERIFIER_LOW_CONFIDENCE: "The independent check is not confident about this cart.",
  VERIFIER_ITEM_UNCLEAR: "The independent check is unsure an item fits what you asked for.",
  VERIFIER_DISAGREEMENT: "The independent checks disagree about this cart.",
};

export async function approvalView(db: Db, row: Approval): Promise<ApprovalView> {
  const request = ApprovalRequestSchema.parse(row.request);
  const [purchase] = await db.select({ cartId: purchases.cartId, amountMinor: purchases.amountMinor, currency: purchases.currency }).from(purchases).where(eq(purchases.id, row.purchaseId));
  if (purchase === undefined) throw new Error(`approval ${row.id} has no purchase`);
  const [cart] = await db.select({ body: carts.body }).from(carts).where(eq(carts.id, purchase.cartId));
  const parsedCart = CartSchema.parse(cart?.body);
  return ApprovalViewSchema.parse({
    approval_id: row.id,
    purchase_id: row.purchaseId,
    writ_id: request.writ_id,
    status: row.status,
    request,
    decision: row.decision,
    cart_summary: {
      items: parsedCart.items.map((item) => ({ title: item.title, qty: item.qty, unit_minor: item.unit_minor })),
      total_minor: minorToString(purchase.amountMinor),
      currency: purchase.currency,
    },
    reasons: request.review_codes.map((code) => PLAIN_REASONS[code] ?? `Needs your review (${code}).`),
    expires_at: row.expiresAt.toISOString(),
    decided_at: row.decidedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  });
}

export async function approvalUpdatedEvent(db: Db, approvalId: string): Promise<StreamEvent> {
  const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
  if (row === undefined) throw new Error(`approval ${approvalId} disappeared`);
  return { type: "approval.updated", data: await approvalView(db, row) };
}

async function loadApproval(db: Db, tenantId: string, approvalId: string): Promise<Approval> {
  const [row] = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.id, approvalId), eq(approvals.tenantId, tenantId)));
  if (row === undefined) throw httpError.notFound("Approval");
  return row;
}

export async function listApprovals(deps: CoreServices, tenantId: string, status: ApprovalStatus | undefined): Promise<ApprovalView[]> {
  const db = requireDb(deps);
  const rows = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.tenantId, tenantId), status === undefined ? undefined : eq(approvals.status, status)))
    .orderBy(desc(approvals.createdAt))
    .limit(200);
  return Promise.all(rows.map((row) => approvalView(db, row)));
}

export async function approvalChallenge(deps: CoreServices, tenantId: string, userId: string, approvalId: string): Promise<ApprovalChallengeResponse> {
  const db = requireDb(deps);
  const row = await loadApproval(db, tenantId, approvalId);
  const request = ApprovalRequestSchema.parse(row.request);
  const challenge = (decision: ApprovalDecision): string => toBase64Url(approvalHash(approvalBody(request, decision)));
  const credentials = await db.select({ id: passkeys.credentialId, transports: passkeys.transports }).from(passkeys).where(eq(passkeys.userId, userId));
  const webauthn = deps.config.webauthn;
  const options = (decision: ApprovalDecision) => ({
    challenge: challenge(decision),
    ...(webauthn === null ? {} : { rpId: webauthn.rpId }),
    timeout: 120_000,
    userVerification: "required" as const,
    allowCredentials: credentials.map((credential) => ({ id: credential.id, type: "public-key" as const, transports: credential.transports })),
  });
  return {
    approval: await approvalView(db, row),
    challenges: { APPROVE: challenge("APPROVE"), DECLINE: challenge("DECLINE") },
    options: credentials.length === 0 ? null : { APPROVE: options("APPROVE"), DECLINE: options("DECLINE") },
  };
}

/** Verifies outside the transaction; returns the passkey counter to persist. Throws 403 when the signature does not hold. */
async function verifyDecisionSignature(deps: CoreServices, userId: string, hash: Uint8Array, signature: WritSignature): Promise<{ passkeyId: string; newCounter: number } | null> {
  const db = requireDb(deps);
  const userPasskeys = await db.select().from(passkeys).where(eq(passkeys.userId, userId));
  if (signature.kind === "webauthn") {
    const webauthn = deps.config.webauthn;
    if (webauthn === null) throw httpError.unavailable("webauthn_unconfigured", "Passkeys are not configured on this gateway.");
    const credential = userPasskeys.find((passkey) => passkey.credentialId === signature.credential_id);
    if (credential === undefined) throw httpError.forbidden("That passkey does not belong to this account.");
    const result = await verifyWebAuthnOverHash({
      hash,
      signature,
      credential: { id: credential.credentialId, publicKeyCose: credential.publicKeyCose, counter: credential.counter },
      expectedOrigin: webauthn.origin,
      expectedRpId: webauthn.rpId,
      requireUserVerification: true,
    });
    if (!result.ok) throw httpError.forbidden(`The passkey signature was rejected (${result.reason}).`);
    return { passkeyId: credential.id, newCounter: result.newCounter };
  }
  if (userPasskeys.length > 0) throw httpError.forbidden("This account has a passkey: approve with the passkey.");
  const keys = await db
    .select({ key: deviceKeys.publicKeyEd25519 })
    .from(deviceKeys)
    .where(and(eq(deviceKeys.userId, userId), isNull(deviceKeys.revokedAt)));
  const result = verifyDeviceEd25519(
    hash,
    signature,
    keys.map((row) => row.key),
  );
  if (!result.ok) throw httpError.forbidden(`The device-key signature was rejected (${result.reason}).`);
  return null;
}

export async function decideApproval(
  deps: CoreServices,
  input: { tenantId: string; userId: string; approvalId: string; decision: ApprovalDecision; signature: WritSignature },
): Promise<DecideApprovalResponse> {
  const db = requireDb(deps);
  const pending = await loadApproval(db, input.tenantId, input.approvalId);
  if (pending.status !== "PENDING") throw httpError.conflict("approval_decided", `This approval is already ${pending.status}.`);
  const body = approvalBody(ApprovalRequestSchema.parse(pending.request), input.decision);
  const hash = approvalHash(body);
  const passkeyUpdate = await verifyDecisionSignature(deps, input.userId, hash, input.signature);

  await deps.uow.run(input.tenantId, async (ctx) => {
    const purchase = await lockPurchase(ctx, pending.purchaseId);
    const [approval] = await ctx.db.select().from(approvals).where(eq(approvals.id, input.approvalId)).for("update");
    if (approval === undefined || approval.status !== "PENDING" || purchase.state !== "AWAITING_HUMAN") {
      throw httpError.conflict("approval_decided", "This approval is no longer pending.");
    }
    if (approval.expiresAt.getTime() <= ctx.now.getTime()) throw httpError.conflict("approval_expired", "This approval has expired.");
    if (purchase.cPre === null) throw new Error(`purchase ${purchase.id} is awaiting a human without C_pre`);

    if (passkeyUpdate !== null) {
      await ctx.db.update(passkeys).set({ counter: passkeyUpdate.newCounter, lastUsedAt: ctx.now }).where(eq(passkeys.id, passkeyUpdate.passkeyId));
    }
    const record = ApprovalRecordSchema.parse({ body, signature: input.signature, decided_at: ctx.now.toISOString() });
    const approvalHashValue = approvalRecordHash(record);
    const verifierHash = await storedVerifierHash(ctx.db, purchase.id);
    if (verifierHash === null) throw new Error(`purchase ${purchase.id} is awaiting a human without a combiner decision`);
    const cPost = commitPost(purchase.cPre, verifierHash, approvalHashValue);

    await ctx.db
      .update(approvals)
      .set({
        status: input.decision === "APPROVE" ? "APPROVED" : "DECLINED",
        decision: input.decision,
        bodyHash: hash,
        assertion: input.signature as unknown as JsonValue,
        decidedAt: ctx.now,
      })
      .where(eq(approvals.id, approval.id));
    const [human] = await ctx.db
      .insert(decisions)
      .values({
        id: deps.ids("decision"),
        tenantId: ctx.tenantId,
        cartId: purchase.cartId,
        purchaseId: purchase.id,
        stage: "human",
        verdict: input.decision === "APPROVE" ? "APPROVE" : "BLOCK",
        reasons: [],
        output: record as unknown as JsonValue,
        outputHash: approvalHashValue,
        createdAt: ctx.now,
      })
      .returning();
    if (human !== undefined) ctx.emit({ type: "decision.recorded", data: decisionView(human) });
    await ctx.appendLedger({
      writId: purchase.writId,
      purchaseId: purchase.id,
      type: input.decision === "APPROVE" ? "HUMAN_APPROVED" : "HUMAN_DECLINED",
      payload: { approval_id: approval.id, approval_hash: toHex(approvalHashValue), signature_kind: input.signature.kind },
    });

    if (input.decision === "DECLINE") {
      await holdToVoiding(ctx, purchase, "human_declined", { cPost });
    } else {
      const stop = await writBlockReason(ctx, purchase.writId);
      if (stop !== null) {
        await holdToVoiding(ctx, purchase, stop, { cPost });
      } else if (await settleHold(ctx, purchase)) {
        await moveTo(ctx, purchase, "CAPTURING", { cPost });
        await ctx.enqueue({ topic: "purchase.capture", payload: { purchase_id: purchase.id } });
      } else {
        await holdToVoiding(ctx, purchase, "settle_refused", { cPost });
      }
    }
    ctx.emit(await approvalUpdatedEvent(ctx.db, approval.id));
  });

  const decided = await loadApproval(db, input.tenantId, input.approvalId);
  const [purchase] = await db.select().from(purchases).where(eq(purchases.id, decided.purchaseId));
  if (purchase === undefined) throw new Error(`approval ${decided.id} lost its purchase`);
  return { approval: await approvalView(db, decided), purchase: purchaseView(purchase) };
}

/** Still PENDING at expires_at → EXPIRED → VOIDING. No signature exists, so H_approval is the zero hash. */
async function expireOne(ctx: TxContext, approvalId: string): Promise<void> {
  const [ref] = await ctx.db.select({ purchaseId: approvals.purchaseId }).from(approvals).where(eq(approvals.id, approvalId));
  if (ref === undefined) return;
  const purchase = await lockPurchase(ctx, ref.purchaseId);
  const [approval] = await ctx.db.select().from(approvals).where(eq(approvals.id, approvalId)).for("update");
  if (approval === undefined || approval.status !== "PENDING" || approval.expiresAt.getTime() > ctx.now.getTime()) return;
  await ctx.db.update(approvals).set({ status: "EXPIRED" }).where(eq(approvals.id, approvalId));
  await ctx.appendLedger({ writId: purchase.writId, purchaseId: purchase.id, type: "HUMAN_REVIEW_EXPIRED", payload: { approval_id: approvalId } });
  if (purchase.state === "AWAITING_HUMAN") {
    const verifierHash = await storedVerifierHash(ctx.db, purchase.id);
    const cPost = purchase.cPre !== null && verifierHash !== null ? commitPost(purchase.cPre, verifierHash, null) : null;
    await holdToVoiding(ctx, purchase, "approval_expired", cPost === null ? {} : { cPost });
  }
  ctx.emit(await approvalUpdatedEvent(ctx.db, approvalId));
}

export function approvalExpireHandler(deps: CoreServices): JobHandler<"approval.expire"> {
  return async (job) => {
    await deps.uow.run(job.tenantId, (ctx) => expireOne(ctx, job.payload.approval_id));
    return { status: "done" };
  };
}

/** Backstop for a lost approval.expire job. */
export async function expireOverdueApprovals(deps: CoreServices): Promise<void> {
  const overdue = await requireDb(deps)
    .select({ id: approvals.id, tenantId: approvals.tenantId })
    .from(approvals)
    .where(and(eq(approvals.status, "PENDING"), lte(approvals.expiresAt, deps.clock())))
    .limit(100);
  for (const { id, tenantId } of overdue) {
    await deps.uow.run(tenantId, (ctx) => expireOne(ctx, id));
  }
}
