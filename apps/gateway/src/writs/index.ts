// Writ lifecycle (P0-1): draft → canonical body + hash (the single-use signing challenge) → signed →
// ACTIVE; revoke; kill switch; expiry sweep. A signature is verified outside the transaction; the move
// to ACTIVE is guarded on DRAFT, so a challenge cannot be used twice.
import {
  CATEGORY_LEAF_LABELS,
  CATEGORY_PARENT_LABELS,
  draftToWritBody,
  ITEM_KIND_LABELS,
  minorToPayPalValue,
  parseMinor,
  toBase64Url,
  toHex,
  verifyDeviceEd25519,
  WritBodySchema,
  WritDraftError,
  writHash,
  type JsonValue,
  type WritBody,
  type WritDraft,
  type WritSignature,
} from "@writ/core";
import { verifyWritSignature } from "@writ/core/signatures";
import type { CreateWritResponse, KillSwitchResponse, WritView } from "@writ/core/api";
import { and, desc, eq, isNull, lte } from "drizzle-orm";
import type { JobRegistration, PurchaseSaga } from "../contracts/index";
import type { Db } from "../db/client";
import { addressBook, agents, deviceKeys, passkeys, writBudgets, writs, type Writ } from "../db/schema";
import { requireDb, type CoreServices } from "../deps";
import { HttpError, httpError } from "../http/errors";
import { budgetView } from "../http/views";
import type { TxContext } from "../tx/unit-of-work";

const EXPIRY_SWEEP_MS = 60_000;

function dollars(minor: string, currency: string): string {
  return `$${minorToPayPalValue(parseMinor(minor), currency as "USD")}`;
}

/** The permission card in plain English: the same lines the user signs and agents plan within. */
export function writSummary(body: WritBody): string[] {
  const { limits, scope, ship_to: shipTo } = body;
  const lines = [`Can spend up to ${dollars(limits.total_minor, body.currency)}`];
  if (limits.max_per_order_minor !== limits.total_minor) lines.push(`At most ${dollars(limits.max_per_order_minor, body.currency)} per order`);
  lines.push(
    limits.require_human_above_minor === "0" ? "Must ask you before every purchase" : `Must ask you above ${dollars(limits.require_human_above_minor, body.currency)}`,
  );
  lines.push(`Up to ${limits.max_orders} order${limits.max_orders === 1 ? "" : "s"}`);
  lines.push(shipTo.locked ? `Ships only to ${shipTo.label}` : `Ships to your saved addresses (default ${shipTo.label})`);
  if (body.deliver_by !== null) lines.push(`Must arrive by ${body.deliver_by}`);
  const categories = scope.categories.map((c) => (CATEGORY_LEAF_LABELS as Record<string, string>)[c] ?? (CATEGORY_PARENT_LABELS as Record<string, string>)[c] ?? c);
  lines.push(`Only: ${categories.join(", ").slice(0, 260)}`);
  if (scope.deny_kinds.length > 0) lines.push(`Never: ${scope.deny_kinds.map((kind) => ITEM_KIND_LABELS[kind].toLowerCase()).join(", ").slice(0, 280)}`);
  lines.push(`Expires ${body.expires_at.slice(0, 10)}`);
  return lines;
}

export async function writView(db: Db, row: Writ): Promise<WritView> {
  const body = WritBodySchema.parse(row.body);
  const [budget] = await db.select().from(writBudgets).where(eq(writBudgets.writId, row.id));
  const signature = row.signature as { kind?: WritView["signature_kind"] } | null;
  return {
    writ_id: row.id as WritView["writ_id"],
    status: row.status,
    agent_id: body.agent_id,
    body,
    hash: toHex(row.bodyHash),
    summary: writSummary(body),
    signature_kind: signature?.kind ?? null,
    created_at: row.createdAt.toISOString(),
    signed_at: row.signedAt?.toISOString() ?? null,
    revoked_at: row.revokedAt?.toISOString() ?? null,
    expires_at: row.expiresAt.toISOString(),
    budget: budget === undefined ? null : budgetView(budget),
  };
}

async function loadWrit(db: Db, tenantId: string, writId: string): Promise<Writ> {
  const [row] = await db
    .select()
    .from(writs)
    .where(and(eq(writs.id, writId), eq(writs.tenantId, tenantId)));
  if (row === undefined) throw httpError.notFound("Writ");
  return row;
}

export async function getWrit(deps: CoreServices, tenantId: string, writId: string): Promise<WritView> {
  const db = requireDb(deps);
  return writView(db, await loadWrit(db, tenantId, writId));
}

export async function listWrits(deps: CoreServices, tenantId: string): Promise<WritView[]> {
  const db = requireDb(deps);
  const rows = await db.select().from(writs).where(eq(writs.tenantId, tenantId)).orderBy(desc(writs.createdAt)).limit(500);
  return Promise.all(rows.map((row) => writView(db, row)));
}

export async function createWrit(
  deps: CoreServices,
  input: { tenantId: string; userId: string; draft: WritDraft; agentId: string; shipToRef: string },
): Promise<CreateWritResponse> {
  const db = requireDb(deps);
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.userId, input.userId), isNull(agents.revokedAt)));
  if (agent === undefined) throw httpError.notFound("Agent");
  const [address] = await db
    .select({ id: addressBook.id, label: addressBook.label })
    .from(addressBook)
    .where(and(eq(addressBook.id, input.shipToRef), eq(addressBook.userId, input.userId)));
  if (address === undefined) throw httpError.notFound("Address");

  const writId = deps.ids("writ");
  let body: WritBody;
  try {
    body = draftToWritBody(input.draft, { writ_id: writId, user_id: input.userId, agent_id: input.agentId, ship_to: { ref: address.id, label: address.label }, now: deps.clock() });
  } catch (error) {
    if (error instanceof WritDraftError) throw new HttpError(422, error.code, error.message);
    throw error;
  }
  const hash = writHash(body);
  const [row] = await db
    .insert(writs)
    .values({
      id: writId,
      tenantId: input.tenantId,
      userId: input.userId,
      agentId: input.agentId,
      body: body as unknown as JsonValue,
      bodyHash: hash,
      status: "DRAFT",
      expiresAt: new Date(body.expires_at),
    })
    .returning();
  if (row === undefined) throw new Error("writ insert returned no row");

  const challenge = toBase64Url(hash);
  const webauthn = deps.config.webauthn;
  const credentials = await db.select({ id: passkeys.credentialId, transports: passkeys.transports }).from(passkeys).where(eq(passkeys.userId, input.userId));
  return {
    writ: await writView(db, row),
    challenge,
    sign_options:
      credentials.length === 0 || webauthn === null
        ? null
        : {
            challenge,
            rpId: webauthn.rpId,
            timeout: 120_000,
            userVerification: "required",
            allowCredentials: credentials.map((credential) => ({ id: credential.id, type: "public-key" as const, transports: credential.transports })),
          },
  };
}

/** Inside the caller's transaction: DRAFT → ACTIVE, the budget row and the chain's genesis. Judge mode uses it for its labeled demo signature. */
export async function activateSigned(ctx: TxContext, input: { writId: string; signature: WritSignature }): Promise<Writ> {
  await ctx.lockWrit(input.writId);
  const [row] = await ctx.db
    .update(writs)
    .set({ status: "ACTIVE", signature: input.signature as unknown as JsonValue, signedAt: ctx.now })
    .where(and(eq(writs.id, input.writId), eq(writs.status, "DRAFT")))
    .returning();
  if (row === undefined) throw httpError.conflict("writ_not_draft", "This Writ was already signed or is no longer a draft.");
  const body = WritBodySchema.parse(row.body);
  const [budget] = await ctx.db
    .insert(writBudgets)
    .values({
      writId: row.id,
      tenantId: ctx.tenantId,
      limitMinor: parseMinor(body.limits.total_minor),
      maxPerOrderMinor: parseMinor(body.limits.max_per_order_minor),
      maxOrders: body.limits.max_orders,
    })
    .returning();
  await ctx.appendLedger({ writId: row.id, type: "WRIT_SIGNED", payload: { writ_id: row.id, writ_hash: toHex(row.bodyHash), signature_kind: input.signature.kind } });
  if (budget !== undefined) ctx.emit({ type: "budget.updated", data: budgetView(budget) });
  return row;
}

export async function signWrit(deps: CoreServices, input: { tenantId: string; userId: string; writId: string; signature: WritSignature }): Promise<WritView> {
  const db = requireDb(deps);
  const row = await loadWrit(db, input.tenantId, input.writId);
  if (row.userId !== input.userId) throw httpError.notFound("Writ");
  if (row.status !== "DRAFT") throw httpError.conflict("writ_not_draft", "This Writ was already signed or is no longer a draft.");
  const body = WritBodySchema.parse(row.body);
  const userPasskeys = await db.select().from(passkeys).where(eq(passkeys.userId, input.userId));
  let counterUpdate: { id: string; counter: number } | null = null;

  if (input.signature.kind === "webauthn") {
    const webauthn = deps.config.webauthn;
    if (webauthn === null) throw httpError.unavailable("webauthn_unconfigured", "Passkeys are not configured on this gateway.");
    const credentialId = input.signature.credential_id;
    const credential = userPasskeys.find((passkey) => passkey.credentialId === credentialId);
    if (credential === undefined) throw httpError.forbidden("That passkey does not belong to this account.");
    const result = await verifyWritSignature(body, input.signature, {
      webauthn: {
        credential: { id: credential.credentialId, publicKeyCose: credential.publicKeyCose, counter: credential.counter },
        expectedOrigin: webauthn.origin,
        expectedRpId: webauthn.rpId,
        requireUserVerification: true,
      },
    });
    if (!result.ok) throw httpError.forbidden(`The passkey signature was rejected (${result.reason}).`);
    counterUpdate = { id: credential.id, counter: result.newCounter ?? credential.counter };
  } else {
    if (userPasskeys.length > 0) throw httpError.forbidden("This account has a passkey: sign with the passkey.");
    const keys = await db
      .select({ key: deviceKeys.publicKeyEd25519 })
      .from(deviceKeys)
      .where(and(eq(deviceKeys.userId, input.userId), isNull(deviceKeys.revokedAt)));
    const result = verifyDeviceEd25519(
      writHash(body),
      input.signature,
      keys.map((key) => key.key),
    );
    if (!result.ok) throw httpError.forbidden(`The device-key signature was rejected (${result.reason}).`);
  }

  return deps.uow.run(input.tenantId, async (ctx) => {
    const activated = await activateSigned(ctx, { writId: input.writId, signature: input.signature });
    if (counterUpdate !== null) await ctx.db.update(passkeys).set({ counter: counterUpdate.counter, lastUsedAt: ctx.now }).where(eq(passkeys.id, counterUpdate.id));
    const view = await writView(ctx.db, activated);
    ctx.emit({ type: "writ.updated", data: view });
    return view;
  });
}

export async function revokeWrit(deps: CoreServices & { saga: PurchaseSaga }, input: { tenantId: string; userId: string; writId: string; reason: string | undefined }): Promise<WritView> {
  return deps.uow.run(input.tenantId, async (ctx) => {
    await ctx.lockWrit(input.writId);
    const row = await loadWrit(ctx.db, input.tenantId, input.writId);
    if (row.userId !== input.userId) throw httpError.notFound("Writ");
    if (row.status === "REVOKED" || row.status === "EXPIRED") return writView(ctx.db, row);
    const [updated] = await ctx.db
      .update(writs)
      .set({ status: "REVOKED", revokedAt: ctx.now, revokeReason: input.reason ?? null })
      .where(eq(writs.id, row.id))
      .returning();
    if (updated === undefined) throw new Error("writ revoke returned no row");
    if (row.status === "ACTIVE") {
      await ctx.appendLedger({ writId: row.id, type: "WRIT_REVOKED", payload: { reason: input.reason ?? "revoked by the owner" } });
      await deps.saga.requestVoids(ctx, { writIds: [row.id], reason: "writ_revoked" });
    }
    const view = await writView(ctx.db, updated);
    ctx.emit({ type: "writ.updated", data: view });
    return view;
  });
}

/** Revokes every live Writ of the user and voids their in-flight authorizations, in one transaction. */
export async function killSwitch(deps: CoreServices & { saga: PurchaseSaga }, input: { tenantId: string; userId: string; reason: string | undefined }): Promise<KillSwitchResponse> {
  return deps.uow.run(input.tenantId, async (ctx) => {
    const live = await ctx.db
      .select({ id: writs.id })
      .from(writs)
      .where(and(eq(writs.tenantId, input.tenantId), eq(writs.userId, input.userId), eq(writs.status, "ACTIVE")))
      .orderBy(writs.id);
    const writIds = live.map((row) => row.id);
    for (const writId of writIds) {
      await ctx.lockWrit(writId);
      await ctx.db.update(writs).set({ status: "REVOKED", revokedAt: ctx.now, revokeReason: input.reason ?? "kill switch" }).where(eq(writs.id, writId));
      await ctx.appendLedger({ writId, type: "KILL_SWITCH", payload: { reason: input.reason ?? "kill switch" } });
    }
    const voided = await deps.saga.requestVoids(ctx, { writIds, reason: "kill_switch" });
    const response = { revoked_writ_ids: writIds, void_requested_purchase_ids: voided } as KillSwitchResponse;
    ctx.emit({ type: "kill_switch.engaged", data: response });
    return response;
  });
}

export function writJobs(deps: CoreServices & { saga: PurchaseSaga }): JobRegistration {
  const sweep = async (): Promise<void> => {
    const now = deps.clock();
    const overdue = await requireDb(deps)
      .select({ id: writs.id, tenantId: writs.tenantId })
      .from(writs)
      .where(and(eq(writs.status, "ACTIVE"), lte(writs.expiresAt, now)))
      .limit(100);
    for (const { id, tenantId } of overdue) {
      await deps.uow.run(tenantId, async (ctx) => {
        await ctx.lockWrit(id);
        const [updated] = await ctx.db
          .update(writs)
          .set({ status: "EXPIRED" })
          .where(and(eq(writs.id, id), eq(writs.status, "ACTIVE")))
          .returning();
        if (updated === undefined) return;
        await ctx.appendLedger({ writId: id, type: "WRIT_EXPIRED", payload: { expired_at: updated.expiresAt.toISOString() } });
        await deps.saga.requestVoids(ctx, { writIds: [id], reason: "writ_expired" });
        ctx.emit({ type: "writ.updated", data: await writView(ctx.db, updated) });
      });
    }
  };
  return { handlers: {}, periodic: [{ name: "writs.expiry", intervalMs: EXPIRY_SWEEP_MS, run: sweep }] };
}
