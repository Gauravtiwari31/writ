// The decision pipeline (P0-4, plan §6.2): schema → Writ validity + deterministic policy → reserve →
// AUTHORIZE → Sentinel + Verifier → combiner → execute. One decisions row per stage. LLM stages can only
// raise a decision: a policy BLOCK is final, and any timeout, parse error or missing role means REVIEW
// (§22 rules 9, 10). After a BLOCK the deterministic Sentinel rules still scan the sources, so the
// injected text can be shown and counted (hero scenes 5-6); that scan cannot change the BLOCK.
import {
  BLOCKED_SCAN_DEADLINE_MS,
  cartHash,
  CartSchema,
  CartSourcesSchema,
  combineDecision,
  evaluatePolicy,
  parseMinor,
  PIPELINE_DEADLINE_MS,
  policyDecisionHash,
  previewVerdict,
  ProductFactsSchema,
  SENTINEL_FETCH_CONCURRENCY,
  SENTINEL_MAX_SOURCES,
  VERIFICATION_SPEC,
  verificationRecordHash,
  WritBodySchema,
  toHex,
  type Cart,
  type CartSource,
  type CatalogItem,
  type JsonValue,
  type PolicyDecision,
  type ProductFacts,
  type SentinelSignal,
  type SentinelSummary,
  type Verdict,
  type VerificationRecord,
  type VerifierSignal,
  type VerifierSummary,
  type WritSignature,
} from "@writ/core";
import type { AgentPurchaseView, CheckoutResponse, PolicyPreviewView } from "@writ/core/api";
import { verifyStoredWritSignature } from "@writ/core/signatures";
import type { SentinelScan, VerifierRun } from "@writ/ai";
import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { AgentPrincipal } from "../auth/agent-keys";
import { PurchaseStateChangedError, type PurchaseSnapshot } from "../contracts/index";
import { policyBudgetOf } from "../budget/reservations";
import { resolveProducts } from "../catalog/index";
import type { Db } from "../db/client";
import { addressBook, attacks, carts, catalogItems, decisions, deviceKeys, passkeys, purchases, writBudgets, writs } from "../db/schema";
import { requireDb, type Services } from "../deps";
import { HttpError, httpError } from "../http/errors";
import { attackView, decisionView } from "../http/views";
import type { Decision } from "../db/schema";

type DecisionStage = Decision["stage"];

function policyContext(deps: Services) {
  const db = requireDb(deps);
  return {
    async verifySignature(writ: typeof writs.$inferSelect): Promise<boolean> {
      const signature = writ.signature as WritSignature | null;
      if (signature === null) return false;
      const body = WritBodySchema.parse(writ.body);
      if (signature.kind === "webauthn") {
        const webauthn = deps.config.webauthn;
        if (webauthn === null) return false;
        const [credential] = await db.select().from(passkeys).where(and(eq(passkeys.credentialId, signature.credential_id), eq(passkeys.userId, writ.userId)));
        if (credential === undefined) return false;
        const result = await verifyStoredWritSignature(body, signature, {
          webauthn: {
            credential: { id: credential.credentialId, publicKeyCose: credential.publicKeyCose, counter: credential.counter },
            expectedOrigin: webauthn.origin,
            expectedRpId: webauthn.rpId,
            requireUserVerification: true,
          },
        });
        return result.ok;
      }
      const keys = await db.select({ key: deviceKeys.publicKeyEd25519 }).from(deviceKeys).where(and(eq(deviceKeys.userId, writ.userId), isNull(deviceKeys.revokedAt)));
      const result = await verifyStoredWritSignature(body, signature, { deviceKeys: keys.map((row) => row.key) });
      return result.ok;
    },
  };
}

async function evaluate(deps: Services, agent: AgentPrincipal, cart: Cart, writ: typeof writs.$inferSelect, excludePurchaseId: string | null): Promise<PolicyDecision> {
  const db = requireDb(deps);
  const body = WritBodySchema.parse(writ.body);
  const [budget] = await db.select().from(writBudgets).where(eq(writBudgets.writId, writ.id));
  const now = deps.clock();
  const hourAgo = new Date(now.getTime() - 3_600_000);
  const [velocity] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(purchases)
    .where(
      and(
        eq(purchases.agentId, agent.agentId),
        gte(purchases.createdAt, hourAgo),
        excludePurchaseId === null ? undefined : sql`${purchases.id} <> ${excludePurchaseId}`,
      ),
    );
  const addresses = await db.select({ id: addressBook.id }).from(addressBook).where(eq(addressBook.userId, writ.userId));
  const signatureVerified = await policyContext(deps).verifySignature(writ);
  return evaluatePolicy({
    writ: body,
    writ_state: { status: writ.status, signature_verified: signatureVerified },
    agent_id: agent.agentId,
    cart,
    budget: budget === undefined ? { spent_minor: 0n, reserved_minor: 0n, orders_count: 0 } : policyBudgetOf(budget),
    velocity: { checkouts_last_hour: velocity?.count ?? 0 },
    known_ship_to_refs: addresses.map((address) => address.id),
    now: now.toISOString(),
  });
}

async function recordDecision(
  deps: Services,
  tenantId: string,
  input: { cartId: string; purchaseId: string | null; stage: DecisionStage; verdict: Verdict; reasons: unknown; output?: unknown; outputHash?: Uint8Array; model?: string | null; latencyMs?: number; tokens?: number },
): Promise<string> {
  const id = deps.ids("decision");
  await deps.uow.run(tenantId, async (ctx) => {
    const [row] = await ctx.db
      .insert(decisions)
      .values({
        id,
        tenantId,
        cartId: input.cartId,
        purchaseId: input.purchaseId,
        stage: input.stage,
        verdict: input.verdict,
        reasons: input.reasons as JsonValue,
        output: (input.output ?? null) as JsonValue,
        outputHash: input.outputHash ?? null,
        model: input.model ?? null,
        latencyMs: input.latencyMs ?? null,
        tokens: input.tokens ?? null,
        createdAt: ctx.now,
      })
      .returning();
    if (row !== undefined) ctx.emit({ type: "decision.recorded", data: decisionView(row) });
  });
  return id;
}

export async function proposeCart(
  deps: Services,
  agent: AgentPrincipal,
  input: { writId: string; items: readonly { product_ref: string; qty: number }[]; shipToRef: string; sources: readonly CartSource[] },
): Promise<{ cart_id: string; cart: Cart; preview: PolicyPreviewView }> {
  const db = requireDb(deps);
  const [writ] = await db
    .select()
    .from(writs)
    .where(and(eq(writs.id, input.writId), eq(writs.tenantId, agent.tenantId)));
  if (writ === undefined || writ.agentId !== agent.agentId) throw httpError.notFound("Writ");
  if (writ.status === "DRAFT") throw httpError.conflict("writ_not_active", "This Writ has not been signed yet.");
  const body = WritBodySchema.parse(writ.body);

  const products = await resolveProducts(deps, db, agent.tenantId, input.items.map((item) => item.product_ref));
  const lines = input.items.map((line) => {
    const product = products.get(line.product_ref);
    if (product === undefined) throw new HttpError(422, "unknown_product", `Unknown product ${line.product_ref}: search for it first.`);
    if (product.category === null) throw new HttpError(422, "unmapped_category", `${line.product_ref} has no known category, so it cannot be carted.`);
    return { product, qty: line.qty, category: product.category };
  });
  const total = lines.reduce((sum, line) => sum + parseMinor(line.product.price_minor) * BigInt(line.qty), 0n);
  const etaDays = Math.max(0, ...lines.map((line) => line.product.eta_days ?? 0));
  const eta = lines.some((line) => line.product.eta_days !== null) ? new Date(deps.clock().getTime() + etaDays * 86_400_000).toISOString().slice(0, 10) : null;
  const cartId = deps.ids("cart");
  const cart = CartSchema.parse({
    spec: "writ-cart/0.1",
    cart_id: cartId,
    writ_id: writ.id,
    agent_id: agent.agentId,
    currency: body.currency,
    items: lines.map((line) => ({
      product_ref: line.product.product_ref,
      title: line.product.title,
      merchant_id: line.product.merchant_id,
      category: line.category,
      kind: line.product.kind,
      unit_minor: line.product.price_minor,
      qty: line.qty,
    })),
    shipping_minor: "0",
    tax_minor: "0",
    total_minor: total.toString(),
    ship_to_ref: input.shipToRef,
    eta,
  });
  const hash = cartHash(cart);
  const sources = CartSourcesSchema.parse(input.sources);
  await deps.uow.run(agent.tenantId, async (ctx) => {
    await ctx.db.insert(carts).values({ id: cartId, tenantId: agent.tenantId, writId: writ.id, agentId: agent.agentId, body: cart as unknown as JsonValue, bodyHash: hash, sources: sources as unknown as JsonValue, createdAt: ctx.now });
    if (writ.signedAt !== null) {
      await ctx.appendLedger({ writId: writ.id, type: "CART_PROPOSED", payload: { cart_id: cartId, cart_hash: toHex(hash), total_minor: cart.total_minor } });
    }
  });
  const policy = await evaluate(deps, agent, cart, writ, null);
  const preview = previewVerdict(policy);
  await recordDecision(deps, agent.tenantId, { cartId, purchaseId: null, stage: "preview", verdict: preview.verdict, reasons: policy.reasons, output: policy });
  return {
    cart_id: cartId,
    cart,
    preview: { verdict: preview.verdict, reasons: policy.reasons, contributions: preview.contributions, pending_stages: preview.pending_stages },
  };
}

// ---------------------------------------------------------------- Sentinel and Verifier stages

interface ScanOutcome {
  source: CartSource;
  scan: SentinelScan | null;
  signal: SentinelSignal;
}

const SIGNAL_ERROR: SentinelSignal = { status: "error" };

function raceDeadline<T>(work: Promise<T>, deadlineAt: number, fallback: T): Promise<T> {
  const remaining = Math.max(0, deadlineAt - Date.now());
  return Promise.race([work, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), remaining))]);
}

async function scanOne(deps: Services, source: CartSource, catalogText: { title: string | null; description: string | null } | null): Promise<ScanOutcome> {
  try {
    if (source.kind === "page") {
      const page = await deps.pages.read(source.url);
      const scan = await deps.ai.sentinel.scan({ source, content: { kind: "html", html: page.html } });
      return { source, scan, signal: scan.signal };
    }
    const scan = await deps.ai.sentinel.scan({ source, content: { kind: "text", title: catalogText?.title ?? null, description: catalogText?.description ?? null } });
    return { source, scan, signal: scan.signal };
  } catch (error) {
    deps.log.warn({ err: error, url: source.url }, "sentinel could not scan a source; failing closed to REVIEW");
    return { source, scan: null, signal: SIGNAL_ERROR };
  }
}

/** Distinct sources up to the cap, plus one listing scan per cart line with a catalog URL: an agent that declares nothing still gets its titles scanned. */
async function runSentinel(deps: Services, tenantId: string, cart: Cart, declared: readonly CartSource[], deadlineAt: number): Promise<{ outcomes: ScanOutcome[]; overCap: boolean }> {
  const db = requireDb(deps);
  const refs = cart.items.map((item) => item.product_ref);
  const items = await db
    .select({ ref: catalogItems.productRef, title: catalogItems.title, url: catalogItems.url })
    .from(catalogItems)
    .where(and(eq(catalogItems.tenantId, tenantId), inArray(catalogItems.productRef, refs)));
  const textByUrl = new Map<string, { title: string | null; description: string | null }>();
  const listings: CartSource[] = [];
  const now = deps.clock().toISOString();
  for (const item of items) {
    if (item.url === null) continue;
    textByUrl.set(item.url, { title: item.title, description: null });
    listings.push({ url: item.url, kind: "listing", fetched_at: now as CartSource["fetched_at"], product_ref: item.ref });
  }
  const seen = new Set<string>();
  const unique: CartSource[] = [];
  for (const source of [...declared, ...listings]) {
    const key = `${source.kind}:${source.url}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(source);
    }
  }
  const overCap = unique.length > SENTINEL_MAX_SOURCES;
  const queue = unique.slice(0, SENTINEL_MAX_SOURCES);
  const outcomes: ScanOutcome[] = [];
  await Promise.all(
    Array.from({ length: SENTINEL_FETCH_CONCURRENCY }, async () => {
      for (let source = queue.shift(); source !== undefined; source = queue.shift()) {
        const current = source;
        outcomes.push(
          await raceDeadline(scanOne(deps, current, textByUrl.get(current.url) ?? null), deadlineAt, { source: current, scan: null, signal: { status: "timeout" } as SentinelSignal }),
        );
      }
    }),
  );
  return { outcomes, overCap };
}

async function recordAttacks(deps: Services, tenantId: string, context: { cartId: string; purchaseId: string | null; writId: string; agentId: string }, outcomes: readonly ScanOutcome[]): Promise<void> {
  for (const { source, scan } of outcomes) {
    if (scan === null) continue;
    await deps.uow.run(tenantId, async (ctx) => {
      await ctx.appendLedger({
        writId: context.writId,
        purchaseId: context.purchaseId,
        type: "SENTINEL_SCANNED",
        payload: { source_url: source.url, kind: source.kind, flagged: scan.flagged !== null, detector: scan.detector, visible_chars: scan.stats.visible_chars, hidden_chars: scan.stats.hidden_chars },
      });
      if (scan.flagged === null) return;
      const [row] = await ctx.db
        .insert(attacks)
        .values({
          id: deps.ids("attack"),
          tenantId,
          sourceUrl: source.url,
          category: scan.flagged.category,
          spans: scan.flagged.spans as unknown as JsonValue,
          score: scan.flagged.score,
          detector: scan.detector,
          cartId: context.cartId,
          purchaseId: context.purchaseId,
          writId: context.writId,
          agentId: context.agentId,
          createdAt: ctx.now,
        })
        .returning();
      if (row !== undefined) ctx.emit({ type: "attack.detected", data: attackView(row) });
    });
  }
}

/** Facts only from our own catalog, never from the agent; titles are datamarked inside the Verifier prompt. */
function factsFor(cart: Cart, products: ReadonlyMap<string, CatalogItem>): ProductFacts[] {
  return cart.items.flatMap((item) => {
    const product = products.get(item.product_ref);
    const parsed = ProductFactsSchema.safeParse({
      product_ref: item.product_ref,
      title: item.title.slice(0, 80),
      merchant_id: item.merchant_id,
      category: item.category,
      kind: item.kind,
      price_minor: item.unit_minor,
      currency: cart.currency,
      eta: cart.eta,
      attributes: [],
      signals: { pushes_add_on: false, pushes_shipping_change: false, pushes_payment_change: false },
    });
    if (parsed.success) return [parsed.data];
    return [{ product_ref: item.product_ref, title: `Item from ${product?.merchant_id ?? item.merchant_id}`, merchant_id: item.merchant_id, category: item.category, kind: item.kind, price_minor: item.unit_minor, currency: cart.currency, eta: cart.eta, attributes: [], signals: { pushes_add_on: false, pushes_shipping_change: false, pushes_payment_change: false } } as ProductFacts];
  });
}

function sentinelSummary(outcome: ScanOutcome): SentinelSummary {
  const signal = outcome.signal;
  if (signal.status === "ok") {
    return { source_url: outcome.source.url, status: "ok", is_injection: signal.result.is_injection, category: signal.result.category, score: signal.result.score };
  }
  return { source_url: outcome.source.url, status: signal.status, is_injection: null, category: null, score: null };
}

function verifierSummary(run: VerifierRun | null): VerifierSummary {
  if (run === null) return { status: "missing", output: null, model: null };
  const signal: VerifierSignal = run.signal;
  if (signal.status === "ok") return { status: "ok", output: signal.result, model: run.meta.model };
  return { status: signal.status, output: null, model: run.meta.model };
}

// ---------------------------------------------------------------- checkout

async function checkoutView(deps: Services, snapshot: PurchaseSnapshot, replayed: boolean, policy: PolicyDecision | null): Promise<CheckoutResponse> {
  const db = requireDb(deps);
  const rows = await db.select().from(decisions).where(eq(decisions.purchaseId, snapshot.purchaseId)).orderBy(asc(decisions.createdAt));
  const reasons = rows.flatMap((row) =>
    (Array.isArray(row.reasons) ? (row.reasons as { code?: unknown; message?: unknown }[]) : [])
      .filter((reason) => typeof reason.code === "string" && typeof reason.message === "string")
      .map((reason) => ({ stage: row.stage, code: String(reason.code).slice(0, 64), message: String(reason.message).slice(0, 1000) })),
  );
  const policyRow = rows.find((row) => row.stage === "policy");
  const policyReasons = policy?.reasons ?? (policyRow?.reasons as PolicyDecision["reasons"] | undefined) ?? [];
  const view: AgentPurchaseView = {
    purchase_id: snapshot.purchaseId as AgentPurchaseView["purchase_id"],
    status: snapshot.state,
    state_reason: snapshot.stateReason,
    verdict: snapshot.finalVerdict,
    reasons: reasons.slice(0, 100),
    policy_reasons: snapshot.finalVerdict === "BLOCK" && snapshot.state === "BLOCKED" ? policyReasons : [],
    amount_minor: snapshot.amountMinor.toString(),
    paypal: { order_id: snapshot.paypal.orderId, authorization_id: snapshot.paypal.authorizationId, capture_id: snapshot.paypal.captureId },
    approval: snapshot.approvalId !== null && snapshot.approvalExpiresAt !== null ? { approval_id: snapshot.approvalId as never, expires_at: snapshot.approvalExpiresAt.toISOString() } : null,
    money_moved: snapshot.paypal.captureId !== null,
    receipt_path: `/receipts/${snapshot.purchaseId}`,
  };
  return { ...view, replayed };
}

export async function getAgentPurchase(deps: Services, agent: AgentPrincipal, purchaseId: string): Promise<AgentPurchaseView> {
  const snapshot = await deps.saga.get({ tenantId: agent.tenantId, purchaseId });
  if (snapshot === null || snapshot.agentId !== agent.agentId) throw httpError.notFound("Purchase");
  const { replayed: _replayed, ...view } = await checkoutView(deps, snapshot, false, null);
  return view;
}

/** Status: 403 for a BLOCK ("$0 moved"), 202 while the outcome is still pending, 200 otherwise. */
export function checkoutStatus(view: CheckoutResponse): number {
  if (view.status === "BLOCKED") return 403;
  if (view.status === "PROPOSED" || view.status === "RESERVED" || view.status === "AUTHORIZING") return 202;
  return 200;
}

export async function runCheckout(deps: Services, agent: AgentPrincipal, input: { cartId: string; idempotencyKey: string }): Promise<CheckoutResponse> {
  const db: Db = requireDb(deps);
  const tenantId = agent.tenantId;
  const [cartRow] = await db
    .select()
    .from(carts)
    .where(and(eq(carts.id, input.cartId), eq(carts.tenantId, tenantId), eq(carts.agentId, agent.agentId)));
  if (cartRow === undefined) throw httpError.notFound("Cart");
  const parsedCart = CartSchema.safeParse(cartRow.body);
  if (!parsedCart.success) throw new HttpError(422, "invalid_cart", "The stored cart does not match the cart schema.");
  const cart = parsedCart.data;
  const [writ] = await db.select().from(writs).where(eq(writs.id, cartRow.writId));
  if (writ === undefined) throw httpError.notFound("Writ");

  const { purchase, replayed } = await deps.saga.open({
    tenantId,
    writId: writ.id,
    cartId: cartRow.id,
    agentId: agent.agentId,
    idempotencyKey: input.idempotencyKey,
    amountMinor: parseMinor(cart.total_minor),
    currency: cart.currency,
  });
  if (replayed) {
    if (purchase.cartId !== cartRow.id) throw httpError.conflict("idempotency_conflict", "This Idempotency-Key was already used for a different cart.");
    return checkoutView(deps, purchase, true, null);
  }
  const purchaseId = purchase.purchaseId;
  const context = { cartId: cartRow.id, purchaseId, writId: writ.id, agentId: agent.agentId };
  await recordDecision(deps, tenantId, { cartId: cartRow.id, purchaseId, stage: "schema", verdict: "APPROVE", reasons: [] });

  const policy = await evaluate(deps, agent, cart, writ, purchaseId);
  const policyHash = policyDecisionHash(policy);
  await recordDecision(deps, tenantId, { cartId: cartRow.id, purchaseId, stage: "policy", verdict: policy.verdict, reasons: policy.reasons, output: policy, outputHash: policyHash });
  const sources = CartSourcesSchema.safeParse(cartRow.sources);
  const declared = sources.success ? sources.data : [];

  if (policy.verdict === "BLOCK") {
    const blocked = await deps.saga.block({ tenantId, purchaseId, reason: "policy_blocked", detail: policy.reasons.map((reason) => reason.message).join(" ").slice(0, 1000), policy });
    // Telemetry only: the BLOCK above is already committed and final.
    const { outcomes } = await runSentinel(deps, tenantId, cart, declared, Date.now() + BLOCKED_SCAN_DEADLINE_MS);
    await recordAttacks(deps, tenantId, context, outcomes);
    return checkoutView(deps, blocked, false, policy);
  }

  const preview = previewVerdict(policy);
  await recordDecision(deps, tenantId, { cartId: cartRow.id, purchaseId, stage: "threshold", verdict: preview.verdict, reasons: preview.contributions });
  const authorized = await deps.saga.reserveAndAuthorize({ tenantId, purchaseId, policy });
  await recordDecision(deps, tenantId, { cartId: cartRow.id, purchaseId, stage: "reserve", verdict: authorized.state === "BLOCKED" ? "BLOCK" : "APPROVE", reasons: [] });
  if (authorized.state !== "AUTHORIZED") return checkoutView(deps, authorized, false, policy);
  await recordDecision(deps, tenantId, { cartId: cartRow.id, purchaseId, stage: "authorize", verdict: "APPROVE", reasons: [] });

  try {
    await deps.saga.beginVerification({ tenantId, purchaseId });
    const deadlineAt = Date.now() + PIPELINE_DEADLINE_MS;
    const { outcomes, overCap } = await runSentinel(deps, tenantId, cart, declared, deadlineAt);
    await recordAttacks(deps, tenantId, context, outcomes);
    const signals: SentinelSignal[] = outcomes.map((outcome) => outcome.signal);
    if (overCap) signals.push(SIGNAL_ERROR);
    const anyFlagged = outcomes.some((outcome) => outcome.scan?.flagged != null && outcome.source.product_ref == null);
    const flaggedRefs = outcomes.flatMap((outcome) => (outcome.scan?.flagged != null && outcome.source.product_ref != null ? [outcome.source.product_ref] : []));
    await recordDecision(deps, tenantId, {
      cartId: cartRow.id,
      purchaseId,
      stage: "sentinel",
      verdict: signals.some((signal) => signal.status !== "ok") || outcomes.some((outcome) => outcome.scan?.flagged != null) ? "REVIEW" : "APPROVE",
      reasons: [],
      output: outcomes.map(sentinelSummary),
    });

    const products = await resolveProducts(deps, db, tenantId, cart.items.map((item) => item.product_ref));
    const body = WritBodySchema.parse(writ.body);
    const verifier = deps.ai.verifier;
    const verifierRun =
      verifier === null
        ? null
        : await raceDeadline<VerifierRun | null>(
            verifier.verify({ writ: body, cart, facts: factsFor(cart, products), flagged_product_refs: flaggedRefs, any_source_flagged: anyFlagged }).catch(() => ({ signal: { status: "error" as const }, meta: { model: null, latencyMs: 0, tokens: 0, attempts: 0, repaired: false } })),
            deadlineAt,
            { signal: { status: "timeout" }, meta: { model: null, latencyMs: 0, tokens: 0, attempts: 0, repaired: false } },
          );
    const verifierSignal = verifierRun?.signal;
    await recordDecision(deps, tenantId, {
      cartId: cartRow.id,
      purchaseId,
      stage: "verifier",
      verdict: verifierSignal?.status === "ok" ? verifierSignal.result.verdict : "REVIEW",
      reasons: [],
      output: verifierSummary(verifierRun),
      ...(verifierRun === null ? {} : { model: verifierRun.meta.model, latencyMs: verifierRun.meta.latencyMs, tokens: verifierRun.meta.tokens }),
    });

    const combined = combineDecision({
      policy,
      cart_product_refs: cart.items.map((item) => item.product_ref),
      sentinel: signals,
      ...(verifierSignal === undefined ? {} : { verifier: verifierSignal }),
    });
    const snapshot = await deps.saga.get({ tenantId, purchaseId });
    if (snapshot === null || snapshot.cPre === null) throw new Error(`purchase ${purchaseId} lost C_pre`);
    const record: VerificationRecord = {
      spec: VERIFICATION_SPEC,
      purchase_id: purchaseId as VerificationRecord["purchase_id"],
      cart_hash: toHex(cartRow.bodyHash),
      c_pre: snapshot.cPre,
      sentinel: outcomes.map(sentinelSummary),
      verifier: verifierSummary(verifierRun),
      final: combined.final,
      contributions: combined.contributions as VerificationRecord["contributions"],
      decided_at: deps.clock().toISOString() as VerificationRecord["decided_at"],
    };
    const decisionId = await recordDecision(deps, tenantId, {
      cartId: cartRow.id,
      purchaseId,
      stage: "combiner",
      verdict: combined.final,
      reasons: combined.contributions,
      output: record,
      outputHash: verificationRecordHash(record),
    });
    const final = await deps.saga.execute({ tenantId, purchaseId, verification: record, decisionId });
    return await checkoutView(deps, final, false, policy);
  } catch (error) {
    if (error instanceof PurchaseStateChangedError) return checkoutView(deps, error.current, false, policy);
    throw error;
  }
}

