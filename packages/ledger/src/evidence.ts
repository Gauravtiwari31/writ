// Evidence pack, JSON form (plan §6.7). Everything in it can be re-checked offline from the pack
// alone plus the PayPal order/capture it names: "Don't trust us — verify."
import {
  commitPost,
  commitPre,
  CurrencySchema,
  customIdMatches,
  fromBase64Url,
  fromHex,
  hashJcsHex,
  invoiceIdMatches,
  MinorAmountSchema,
  minorToString,
  toBase64Url,
  toHex,
  writShort,
  type Currency,
  type JsonValue,
} from "@writ/core";
import { z } from "zod";
import { verifyChain } from "./chain";
import {
  Hex32Schema,
  LedgerEventSchema,
  LedgerTimestampSchema,
  payloadSchemaFor,
  PayPalCapturedPayloadSchema,
  PayPalIdSchema,
  PayPalOrderCreatedPayloadSchema,
  PayPalVoidedPayloadSchema,
  PurchaseIdSchema,
  WritIdSchema,
  WritSignedPayloadSchema,
  type LedgerEvent,
  type LedgerEventType,
} from "./events";
import { JsonValueSchema } from "./json";

export const EVIDENCE_SPEC = "writ-evidence/0.1";

const WritShortSchema = z.string().regex(/^[a-z0-9]{6,16}$/, "writ short id: 6-16 chars of [a-z0-9]");

/** Canonical only (no padding, zero trailing bits), so one key has exactly one spelling in a pack. */
const Base64UrlSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((text) => {
    try {
      return toBase64Url(fromBase64Url(text)) === text;
    } catch {
      return false;
    }
  }, "expected canonical unpadded base64url");
const PayPalFieldSchema = z.string().min(1).max(127);

export const EvidencePackSchema = z.strictObject({
  spec: z.literal(EVIDENCE_SPEC),
  generated_at: LedgerTimestampSchema,
  writ: z.strictObject({
    id: WritIdSchema,
    /** writShort(id): the <writ_short> inside the order's custom_id. */
    short: WritShortSchema,
    body: JsonValueSchema,
    hash: Hex32Schema,
    /** A @writ/core WritSignature over `hash` (passkey assertion or device key); opaque here, checked by the injected verifier. */
    signature: JsonValueSchema,
    public_key_cose: Base64UrlSchema.nullable(),
  }),
  purchase: z.strictObject({
    purchase_id: PurchaseIdSchema,
    amount_minor: MinorAmountSchema,
    currency: CurrencySchema,
    paypal: z.strictObject({
      order_id: PayPalIdSchema,
      authorization_id: PayPalIdSchema,
      capture_id: PayPalIdSchema.nullable(),
      void_id: PayPalIdSchema.optional(),
      debug_ids: z.array(PayPalIdSchema).max(1000),
    }),
  }),
  commitments: z.strictObject({
    h_w: Hex32Schema,
    h_c: Hex32Schema,
    h_p: Hex32Schema,
    c_pre: Hex32Schema,
    h_verifier: Hex32Schema.nullable(),
    /** null when no human review happened; C_post then uses 32 zero bytes. */
    h_approval: Hex32Schema.nullable(),
    c_post: Hex32Schema.nullable(),
    custom_id: PayPalFieldSchema,
    /** null when not captured, or under the Spike S8 fallback (C_post kept in the ledger only). */
    invoice_id: PayPalFieldSchema.nullable(),
  }),
  cart: JsonValueSchema,
  policy_decision: JsonValueSchema,
  verifier: JsonValueSchema.nullable(),
  approval: JsonValueSchema.nullable(),
  /** The full Writ chain, genesis first. */
  events: z.array(LedgerEventSchema).min(1).max(10_000),
  verification: z.strictObject({
    instructions: z.array(z.string().max(1000)).max(50),
  }),
});
export type EvidencePack = z.infer<typeof EvidencePackSchema>;

export const VERIFICATION_INSTRUCTIONS: readonly string[] = [
  "All hashes are SHA-256 in lowercase hex; JCS is RFC 8785 JSON canonicalization, encoded as UTF-8.",
  "writ.body.writ_id must equal writ.id, and writ.short is the 12 characters of writ.id that follow 'wr_' and its 10-character time part.",
  "writ.hash and commitments.h_w must equal SHA-256(JCS(writ.body)).",
  "writ.signature signs writ.hash: either a WebAuthn assertion (kind 'webauthn') whose challenge is writ.hash, verified with writ.public_key_cose, or an Ed25519 device-key signature (kind 'device-ed25519') that carries its own public key.",
  "commitments.h_c = SHA-256(JCS(cart)); commitments.h_p = SHA-256(JCS(policy_decision)).",
  "commitments.c_pre = SHA-256(h_w ‖ h_c ‖ h_p) over the raw 32-byte hashes.",
  "commitments.custom_id must be 'writ:' + writ.short + ':' + the first 40 hex chars of c_pre, and must equal custom_id on the PayPal order purchase.paypal.order_id.",
  "commitments.h_verifier = SHA-256(JCS(verifier)); commitments.h_approval = SHA-256(JCS(approval)), or null when no human review happened.",
  "commitments.c_post = SHA-256(c_pre ‖ h_verifier ‖ h_approval), using 32 zero bytes for a null h_approval.",
  "commitments.invoice_id, when present, must be 'wv-' + the first 40 hex chars of c_post, and must equal invoice_id on the PayPal capture purchase.paypal.capture_id.",
  "Ledger: each event's hash = SHA-256(prev_hash ‖ u32be(len) ‖ type ‖ u32be(len) ‖ JCS(payload) ‖ u32be(len) ‖ ts), text as UTF-8, prev_hash as 32 raw bytes; the first event is WRIT_SIGNED with prev_hash = 32 zero bytes and each later prev_hash equals the previous hash.",
  "The WRIT_SIGNED payload.writ_hash must equal writ.hash; the PAYPAL_* events for purchase.purchase_id must carry the PayPal IDs, custom_id, invoice_id and amount shown above.",
  "The PAYPAL_ORDER_CREATED event records the full c_pre, and every PAYPAL_CAPTURED or PAYPAL_VOIDED event records the full c_post (null when voided before the verifier ran); both must equal commitments.c_pre and commitments.c_post.",
  "verifyEvidencePack() in the Writ repository (packages/ledger) performs every check above offline, except the comparison with PayPal's own order and capture records.",
];

export interface BuildEvidencePackInput {
  generated_at: Date | string;
  writ: {
    /** A wr_ id; the pack's writ.short is derived from it. */
    id: string;
    body: JsonValue;
    signature: JsonValue;
    public_key_cose: Uint8Array | null;
  };
  purchase: {
    purchase_id: string;
    amount_minor: bigint;
    currency: Currency;
    paypal: { order_id: string; authorization_id: string; capture_id: string | null; void_id?: string };
  };
  cart: JsonValue;
  policy_decision: JsonValue;
  /** null when the purchase never reached the verifier. */
  verifier: JsonValue | null;
  /** null when no human review happened. */
  approval: JsonValue | null;
  /** The full Writ chain, genesis first. */
  events: readonly LedgerEvent[];
}

function purchaseEvents(events: readonly LedgerEvent[], purchaseId: string): { event: LedgerEvent; index: number }[] {
  return events.flatMap((event, index) => (event.purchase_id === purchaseId ? [{ event, index }] : []));
}

/** Every PayPal-Debug-Id logged for the purchase, deduplicated, in chain order (plan §7). */
function debugIdsOf(events: readonly { event: LedgerEvent }[]): string[] {
  const seen = new Set<string>();
  for (const { event } of events) {
    const debugId = event.payload["debug_id"];
    if (typeof debugId === "string" && PayPalIdSchema.safeParse(debugId).success) seen.add(debugId);
  }
  return [...seen];
}

/**
 * Assembles a pack from stored records. Hashes and commitments are recomputed from the documents;
 * custom_id and invoice_id are taken from the ledger, i.e. what was actually sent to PayPal, so
 * verification compares the two. Throws if the purchase has no PAYPAL_ORDER_CREATED event.
 */
export function buildEvidencePack(input: BuildEvidencePackInput): EvidencePack {
  const { writ, purchase } = input;
  const hW = hashJcsHex(writ.body);
  const hC = hashJcsHex(input.cart);
  const hP = hashJcsHex(input.policy_decision);
  const cPre = commitPre(fromHex(hW), fromHex(hC), fromHex(hP));
  const hV = input.verifier === null ? null : hashJcsHex(input.verifier);
  const hA = input.approval === null ? null : hashJcsHex(input.approval);
  const cPost = hV === null ? null : commitPost(cPre, fromHex(hV), hA === null ? null : fromHex(hA));

  const mine = purchaseEvents(input.events, purchase.purchase_id);
  const orderEvent = mine.find(({ event }) => event.type === "PAYPAL_ORDER_CREATED");
  if (orderEvent === undefined) {
    throw new Error(`no PAYPAL_ORDER_CREATED event for purchase ${purchase.purchase_id}`);
  }
  const order = PayPalOrderCreatedPayloadSchema.parse(orderEvent.event.payload);
  const captureEvent = mine.find(({ event }) => event.type === "PAYPAL_CAPTURED");
  const invoiceId = captureEvent === undefined ? null : PayPalCapturedPayloadSchema.parse(captureEvent.event.payload).invoice_id;

  const { void_id: voidId, ...paypalIds } = purchase.paypal;
  return EvidencePackSchema.parse({
    spec: EVIDENCE_SPEC,
    generated_at: typeof input.generated_at === "string" ? input.generated_at : input.generated_at.toISOString(),
    writ: {
      id: writ.id,
      short: writShort(writ.id),
      body: writ.body,
      hash: hW,
      signature: writ.signature,
      public_key_cose: writ.public_key_cose === null ? null : toBase64Url(writ.public_key_cose),
    },
    purchase: {
      purchase_id: purchase.purchase_id,
      amount_minor: minorToString(purchase.amount_minor),
      currency: purchase.currency,
      paypal: { ...paypalIds, ...(voidId === undefined ? {} : { void_id: voidId }), debug_ids: debugIdsOf(mine) },
    },
    commitments: {
      h_w: hW,
      h_c: hC,
      h_p: hP,
      c_pre: toHex(cPre),
      h_verifier: hV,
      h_approval: hA,
      c_post: cPost === null ? null : toHex(cPost),
      custom_id: order.custom_id,
      invoice_id: invoiceId,
    },
    cart: input.cart,
    policy_decision: input.policy_decision,
    verifier: input.verifier,
    approval: input.approval,
    events: [...input.events],
    verification: { instructions: [...VERIFICATION_INSTRUCTIONS] },
  });
}

export const EVIDENCE_CHECK_NAMES = [
  "schema",
  "chain",
  "writ_signed_event",
  "writ_id",
  "writ_hash",
  "writ_signature",
  "h_w",
  "h_c",
  "h_p",
  "c_pre",
  "custom_id",
  "h_verifier",
  "h_approval",
  "c_post",
  "invoice_id",
  "paypal_ids",
  "paypal_anchors",
  "ledger_commitments",
  "paypal_amounts",
  "debug_ids",
] as const;
export type EvidenceCheckName = (typeof EVIDENCE_CHECK_NAMES)[number];
export type EvidenceCheckStatus = "PASS" | "FAIL" | "SKIP";

export interface EvidenceCheck {
  name: EvidenceCheckName;
  status: EvidenceCheckStatus;
  detail: string;
}

export interface EvidenceVerification {
  /** True when no check FAILed (SKIP = not applicable, e.g. no human review). */
  ok: boolean;
  checks: EvidenceCheck[];
}

export type WritSignatureVerifier = (
  body: JsonValue,
  signature: JsonValue,
  writ: EvidencePack["writ"],
) => boolean | Promise<boolean>;

export interface VerifyEvidenceOptions {
  /** e.g. WebAuthn verification against writ.public_key_cose; omitted → the check is SKIP. */
  verifyWritSignature?: WritSignatureVerifier;
}

const pass = (name: EvidenceCheckName, detail: string): EvidenceCheck => ({ name, status: "PASS", detail });
const failed = (name: EvidenceCheckName, detail: string): EvidenceCheck => ({ name, status: "FAIL", detail });
const skip = (name: EvidenceCheckName, detail: string): EvidenceCheck => ({ name, status: "SKIP", detail });

function equalCheck(name: EvidenceCheckName, label: string, claimed: string, recomputed: string): EvidenceCheck {
  return claimed === recomputed
    ? pass(name, `${label} = ${recomputed}`)
    : failed(name, `${label}: pack says ${claimed}, recomputed ${recomputed}`);
}

/** H of an optional record: both absent → SKIP; one absent → FAIL; else compare. */
function optionalDocCheck(
  name: EvidenceCheckName,
  label: string,
  doc: JsonValue | null,
  claimed: string | null,
  absentDetail: string,
): EvidenceCheck {
  if (doc === null && claimed === null) return skip(name, absentDetail);
  if (doc === null) return failed(name, `${label} is set but the record it hashes is missing`);
  if (claimed === null) return failed(name, `record present but ${label} is null`);
  return equalCheck(name, label, claimed, hashJcsHex(doc));
}

function signedEventCheck(pack: EvidencePack): EvidenceCheck {
  const genesis = pack.events[0];
  if (genesis === undefined || genesis.type !== "WRIT_SIGNED") return failed("writ_signed_event", "chain does not start with WRIT_SIGNED");
  if (genesis.writ_id !== pack.writ.id) {
    return failed("writ_signed_event", `chain belongs to writ ${genesis.writ_id}, pack is for ${pack.writ.id}`);
  }
  const payload = WritSignedPayloadSchema.safeParse(genesis.payload);
  if (!payload.success) return failed("writ_signed_event", "WRIT_SIGNED payload lacks writ_id/writ_hash");
  return payload.data.writ_hash === pack.writ.hash
    ? pass("writ_signed_event", `WRIT_SIGNED (seq ${genesis.seq}) records writ hash ${pack.writ.hash}`)
    : failed("writ_signed_event", `WRIT_SIGNED records ${payload.data.writ_hash}, pack says ${pack.writ.hash}`);
}

/** The signed body names this Writ, and the short id inside custom_id is derived from it. */
function writIdCheck(pack: EvidencePack): EvidenceCheck {
  const { id, short, body } = pack.writ;
  const problems: string[] = [];
  const bodyId = typeof body === "object" && body !== null && !Array.isArray(body) ? body["writ_id"] : undefined;
  if (bodyId !== id) problems.push(`writ.body.writ_id is ${JSON.stringify(bodyId ?? null)}, pack is for ${id}`);
  if (short !== writShort(id)) problems.push(`writ.short ${short} is not derived from ${id}`);
  return problems.length === 0 ? pass("writ_id", `signed body names ${id} (short ${short})`) : failed("writ_id", problems.join("; "));
}

async function signatureCheck(pack: EvidencePack, verify: WritSignatureVerifier | undefined): Promise<EvidenceCheck> {
  if (verify === undefined) return skip("writ_signature", "no signature verifier supplied");
  try {
    return (await verify(pack.writ.body, pack.writ.signature, pack.writ)) === true
      ? pass("writ_signature", "Writ signature verifies")
      : failed("writ_signature", "Writ signature does not verify");
  } catch (error) {
    return failed("writ_signature", `signature verifier threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function cPostCheck(pack: EvidencePack): EvidenceCheck {
  const { c_pre: cPre, h_verifier: hV, h_approval: hA, c_post: cPost } = pack.commitments;
  if (cPost === null) {
    return pack.purchase.paypal.capture_id === null
      ? skip("c_post", "no post-commitment (purchase not captured)")
      : failed("c_post", "captured without a post-commitment");
  }
  if (hV === null) return failed("c_post", "C_post present without H_verifier");
  const recomputed = toHex(commitPost(fromHex(cPre), fromHex(hV), hA === null ? null : fromHex(hA)));
  return equalCheck("c_post", "C_post", cPost, recomputed);
}

function invoiceIdCheck(pack: EvidencePack): EvidenceCheck {
  const { invoice_id: invoiceId, c_post: cPost } = pack.commitments;
  if (invoiceId === null) return skip("invoice_id", "no invoice_id (not captured, or post-commitment kept in the ledger only)");
  if (cPost === null) return failed("invoice_id", "invoice_id present without C_post");
  return invoiceIdMatches(invoiceId, fromHex(cPost))
    ? pass("invoice_id", `${invoiceId} anchors C_post`)
    : failed("invoice_id", `${invoiceId} does not match C_post ${cPost}`);
}

type Located = { event: LedgerEvent; index: number };

const ofType = (events: readonly Located[], type: LedgerEventType): Located[] =>
  events.filter(({ event }) => event.type === type);

function paypalIdsCheck(pack: EvidencePack, mine: readonly Located[]): EvidenceCheck {
  const ids = pack.purchase.paypal;
  const problems: string[] = [];
  const expected: Record<string, string | null> = {
    order_id: ids.order_id,
    authorization_id: ids.authorization_id,
    capture_id: ids.capture_id,
    void_id: ids.void_id ?? null,
  };

  const paypalEvents = mine.filter(({ event }) => event.type.startsWith("PAYPAL_"));
  for (const { event } of paypalEvents) {
    const contract = payloadSchemaFor(event.type);
    if (contract !== undefined && !contract.safeParse(event.payload).success) {
      problems.push(`${event.type} seq ${event.seq}: malformed payload`);
    }
    for (const [field, want] of Object.entries(expected)) {
      if (Object.hasOwn(event.payload, field) && event.payload[field] !== want) {
        problems.push(`${event.type} seq ${event.seq}: ${field} ${JSON.stringify(event.payload[field])} ≠ ${JSON.stringify(want)}`);
      }
    }
  }

  const orders = ofType(paypalEvents, "PAYPAL_ORDER_CREATED");
  const auths = ofType(paypalEvents, "PAYPAL_AUTHORIZED");
  const captures = ofType(paypalEvents, "PAYPAL_CAPTURED");
  const voids = ofType(paypalEvents, "PAYPAL_VOIDED");
  if (orders.length === 0) problems.push("no PAYPAL_ORDER_CREATED event");
  if (auths.length === 0) problems.push("no PAYPAL_AUTHORIZED event");
  if (ids.capture_id !== null && captures.length === 0) problems.push("capture_id has no PAYPAL_CAPTURED event");
  if (ids.capture_id === null && captures.length > 0) problems.push("ledger records a capture the purchase block omits");
  if (ids.void_id !== undefined && voids.length === 0) problems.push("void_id has no PAYPAL_VOIDED event");
  if (captures.length > 0 && voids.length > 0) problems.push("authorization both captured and voided");

  const firstIndex = (list: readonly Located[]): number => list[0]?.index ?? Number.POSITIVE_INFINITY;
  const settled = Math.min(firstIndex(captures), firstIndex(voids));
  if (firstIndex(orders) > firstIndex(auths) || (settled !== Number.POSITIVE_INFINITY && firstIndex(auths) > settled)) {
    problems.push("PayPal events out of order (order → authorize → capture/void)");
  }

  return problems.length === 0
    ? pass("paypal_ids", `${paypalEvents.length} PayPal events carry order ${ids.order_id}, authorization ${ids.authorization_id}${ids.capture_id === null ? "" : `, capture ${ids.capture_id}`}`)
    : failed("paypal_ids", problems.join("; "));
}

function paypalAnchorsCheck(pack: EvidencePack, mine: readonly Located[]): EvidenceCheck {
  const { custom_id: customId, invoice_id: invoiceId } = pack.commitments;
  const problems: string[] = [];
  const orders = ofType(mine, "PAYPAL_ORDER_CREATED");
  if (orders.length === 0) problems.push("custom_id is not recorded in the ledger");
  for (const { event } of orders) {
    const payload = PayPalOrderCreatedPayloadSchema.safeParse(event.payload);
    if (!payload.success) problems.push(`order event seq ${event.seq}: malformed payload`);
    else if (payload.data.custom_id !== customId) problems.push(`order sent custom_id ${payload.data.custom_id}`);
  }
  const captures = ofType(mine, "PAYPAL_CAPTURED");
  if (captures.length === 0 && invoiceId !== null) problems.push("invoice_id is not recorded in the ledger");
  for (const { event } of captures) {
    const payload = PayPalCapturedPayloadSchema.safeParse(event.payload);
    if (!payload.success) problems.push(`capture event seq ${event.seq}: malformed payload`);
    else if (payload.data.invoice_id !== invoiceId) problems.push(`capture sent invoice_id ${String(payload.data.invoice_id)}`);
  }
  return problems.length === 0
    ? pass("paypal_anchors", "custom_id and invoice_id match what the ledger recorded as sent to PayPal")
    : failed("paypal_anchors", problems.join("; "));
}

/**
 * The full commitments the ledger recorded at order creation and at settlement. This binds the
 * verifier and approval records even where no invoice_id reached PayPal (void path, Spike S8 fallback).
 */
function ledgerCommitmentsCheck(pack: EvidencePack, mine: readonly Located[]): EvidenceCheck {
  const { c_pre: cPre, c_post: cPost } = pack.commitments;
  const problems: string[] = [];
  const orders = ofType(mine, "PAYPAL_ORDER_CREATED");
  if (orders.length === 0) problems.push("C_pre is not recorded in the ledger");
  for (const { event } of orders) {
    const payload = PayPalOrderCreatedPayloadSchema.safeParse(event.payload);
    if (!payload.success) problems.push(`order event seq ${event.seq}: malformed payload`);
    else if (payload.data.c_pre !== cPre) problems.push(`order event seq ${event.seq} recorded C_pre ${payload.data.c_pre}`);
  }
  let settlements = 0;
  for (const { event } of mine) {
    if (event.type !== "PAYPAL_CAPTURED" && event.type !== "PAYPAL_VOIDED") continue;
    settlements++;
    const payload = (event.type === "PAYPAL_CAPTURED" ? PayPalCapturedPayloadSchema : PayPalVoidedPayloadSchema).safeParse(event.payload);
    if (!payload.success) problems.push(`${event.type} seq ${event.seq}: malformed payload`);
    else if (payload.data.c_post !== cPost) {
      problems.push(`${event.type} seq ${event.seq} recorded C_post ${String(payload.data.c_post)}, pack says ${String(cPost)}`);
    }
  }
  if (problems.length > 0) return failed("ledger_commitments", problems.join("; "));
  return pass(
    "ledger_commitments",
    settlements === 0 ? "ledger recorded the same C_pre (purchase not settled yet)" : "ledger recorded the same C_pre and C_post",
  );
}

function paypalAmountsCheck(pack: EvidencePack, mine: readonly Located[]): EvidenceCheck {
  const { amount_minor: amount, currency } = pack.purchase;
  const problems: string[] = [];
  let seen = 0;
  for (const { event } of mine) {
    if (event.type !== "PAYPAL_ORDER_CREATED" && event.type !== "PAYPAL_CAPTURED") continue;
    const payload = (event.type === "PAYPAL_ORDER_CREATED" ? PayPalOrderCreatedPayloadSchema : PayPalCapturedPayloadSchema).safeParse(event.payload);
    if (!payload.success) {
      problems.push(`${event.type} seq ${event.seq}: malformed payload`);
      continue;
    }
    seen++;
    if (payload.data.amount_minor !== amount || payload.data.currency !== currency) {
      problems.push(`${event.type} seq ${event.seq}: ${payload.data.amount_minor} ${payload.data.currency} ≠ ${amount} ${currency}`);
    }
  }
  if (seen === 0 && problems.length === 0) problems.push("no PayPal amount recorded in the ledger");
  return problems.length === 0
    ? pass("paypal_amounts", `order and capture amounts equal ${amount} ${currency} (minor units)`)
    : failed("paypal_amounts", problems.join("; "));
}

function debugIdsCheck(pack: EvidencePack, mine: readonly Located[]): EvidenceCheck {
  const recorded = debugIdsOf(mine);
  const listed = pack.purchase.paypal.debug_ids;
  const same = recorded.length === listed.length && recorded.every((id, i) => id === listed[i]);
  return same
    ? pass("debug_ids", `${listed.length} PayPal-Debug-Id(s) match the ledger`)
    : failed("debug_ids", `pack lists [${listed.join(", ")}], ledger records [${recorded.join(", ")}]`);
}

/**
 * Runs every check independently and reports each one; each check verifies one link
 * (document → hash → commitment → PayPal anchor, and ledger ↔ purchase), so all PASS means the
 * documents are bound to the PayPal record. The pack is untrusted input.
 */
export async function verifyEvidencePack(input: unknown, options: VerifyEvidenceOptions = {}): Promise<EvidenceVerification> {
  const parsed = EvidencePackSchema.safeParse(input);
  if (!parsed.success) return { ok: false, checks: [failed("schema", z.prettifyError(parsed.error))] };
  const pack = parsed.data;
  const { commitments: c } = pack;

  const checks: EvidenceCheck[] = [pass("schema", `matches ${EVIDENCE_SPEC}`)];

  const chain = verifyChain(pack.events);
  checks.push(
    chain.ok
      ? pass("chain", `${pack.events.length} events, head ${pack.events[pack.events.length - 1]?.hash ?? ""}`)
      : failed("chain", `event ${chain.index}: ${chain.reason} (${chain.detail})`),
  );
  checks.push(signedEventCheck(pack));
  checks.push(writIdCheck(pack));

  const bodyHash = hashJcsHex(pack.writ.body);
  checks.push(equalCheck("writ_hash", "writ.hash", pack.writ.hash, bodyHash));
  checks.push(await signatureCheck(pack, options.verifyWritSignature));

  checks.push(equalCheck("h_w", "H_w", c.h_w, bodyHash));
  checks.push(equalCheck("h_c", "H_c", c.h_c, hashJcsHex(pack.cart)));
  checks.push(equalCheck("h_p", "H_p", c.h_p, hashJcsHex(pack.policy_decision)));
  checks.push(equalCheck("c_pre", "C_pre", c.c_pre, toHex(commitPre(fromHex(c.h_w), fromHex(c.h_c), fromHex(c.h_p)))));
  checks.push(
    customIdMatches(c.custom_id, pack.writ.short, fromHex(c.c_pre))
      ? pass("custom_id", `${c.custom_id} anchors C_pre`)
      : failed("custom_id", `${c.custom_id} does not match writ ${pack.writ.short} and C_pre ${c.c_pre}`),
  );
  checks.push(optionalDocCheck("h_verifier", "H_verifier", pack.verifier, c.h_verifier, "no verifier record"));
  checks.push(
    optionalDocCheck("h_approval", "H_approval", pack.approval, c.h_approval, "no human review (C_post uses 32 zero bytes)"),
  );
  checks.push(cPostCheck(pack));
  checks.push(invoiceIdCheck(pack));

  const mine = purchaseEvents(pack.events, pack.purchase.purchase_id);
  checks.push(paypalIdsCheck(pack, mine));
  checks.push(paypalAnchorsCheck(pack, mine));
  checks.push(ledgerCommitmentsCheck(pack, mine));
  checks.push(paypalAmountsCheck(pack, mine));
  checks.push(debugIdsCheck(pack, mine));

  return { ok: checks.every((check) => check.status !== "FAIL"), checks };
}
