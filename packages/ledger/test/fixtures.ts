// A hero-story purchase (plan §4 scene 7) recorded through the real ledger functions.
import { generateKeyPairSync, sign, verify, createPublicKey } from "node:crypto";
import {
  commitPost,
  commitPre,
  fromBase64Url,
  fromHex,
  hashJcs,
  hashJcsHex,
  toBase64Url,
  toCustomId,
  toHex,
  toInvoiceId,
  writShort,
  type JsonValue,
} from "@writ/core";
import {
  appendEvent,
  buildEvidencePack,
  type AppendEventInput,
  type BuildEvidencePackInput,
  type JsonObject,
  type LedgerEvent,
  type WritSignatureVerifier,
} from "../src/index";

// Fixed @writ/core ids (wr_/pur_ + ULID), so hashes and packs are reproducible.
export const WRIT_ID = "wr_01m6gvezy0dr1r16bxj90g7evg";
export const WRIT_SHORT = writShort(WRIT_ID);
export const OTHER_WRIT_ID = "wr_01m6gv0000z9y8x7w6v5t4s3r2";
export const PURCHASE_ID = "pur_01m6gw3k2qa8bn4c7d9e5f6g0h";
export const ATTACK_PURCHASE_ID = "pur_01m6gvy9xd7t2bq8m4k6r3s5ab";
export const OTHER_PURCHASE_ID = "pur_01m6gv0002q9p8n7m6k5j4h3g2";
export const ORDER_ID = "5O190127TN364715T";
export const AUTHORIZATION_ID = "0VF52814937998046";
export const CAPTURE_ID = "3C679366HH908993F";
export const VOID_ID = "6RX10734L8462012K";

/**
 * review-capture: scene 7 (REVIEW → passkey → capture). auto-capture: APPROVE, no human.
 * void: verifier BLOCK → void. kill-switch: the user's kill switch voids the authorization before
 * the verifier ran, so there is no verifier record and no post-commitment.
 */
export type Path = "review-capture" | "auto-capture" | "void" | "kill-switch";

// Ed25519 stands in for the WebAuthn assertion: the pack treats signature/public key as opaque
// and delegates to the injected verifier, which is exactly what this exercises.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const rawPublicKey = fromBase64Url(publicKey.export({ format: "jwk" }).x ?? "");

export const writBody: JsonValue = {
  spec: "writ/0.1",
  writ_id: WRIT_ID,
  purpose: "Pottery-themed gift for my sister",
  currency: "USD",
  limit_minor: "6000",
  max_per_order_minor: "6000",
  require_human_above_minor: "4000",
  categories: ["home.ceramics", "gifts.handmade"],
  deny_kinds: ["gift_card", "protection_plan", "subscription"],
  ship_to_ref: "addr_home_austin",
  ship_to_locked: true,
  deliver_by: "2026-11-20",
  expires_at: "2026-11-10T14:02:00.000Z",
};

export function signWrit(body: JsonValue): JsonValue {
  return { alg: "Ed25519", sig: toBase64Url(sign(null, hashJcs(body), privateKey)) };
}

export const verifyWritSignature: WritSignatureVerifier = (body, signature, writ) => {
  if (typeof signature !== "object" || signature === null || Array.isArray(signature)) return false;
  const sig = signature["sig"];
  if (typeof sig !== "string" || writ.public_key_cose === null) return false;
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: writ.public_key_cose }, format: "jwk" });
  return verify(null, hashJcs(body), key, fromBase64Url(sig));
};

export const cart: JsonValue = {
  items: [{ product_ref: "ch3_pourover_771", title: "Hand-thrown ceramic pour-over set", qty: 1, unit_minor: "4400", category: "home.ceramics" }],
  total_minor: "4400",
  currency: "USD",
  ship_to_ref: "addr_home_austin",
  eta: "2026-11-17",
};

export function policyDecision(path: Path): JsonValue {
  // amount_minor: the computed total the policy approved, as in @writ/core's PolicyDecision.
  return {
    verdict: path === "auto-capture" ? "APPROVE" : "REVIEW",
    amount_minor: "4400",
    reasons: path === "auto-capture" ? [] : ["AMOUNT_ABOVE_HUMAN_THRESHOLD"],
  };
}

export function verifierRecord(path: Path): JsonValue | null {
  if (path === "kill-switch") return null;
  return {
    verdict: path === "void" ? "BLOCK" : "APPROVE",
    item_findings: [{ product_ref: "ch3_pourover_771", fit: path === "void" ? "no" : "yes", reason: "pottery-themed; ETA Nov 17 ≤ Nov 20" }],
    confidence: 0.92,
    model: "verifier-model-id",
  };
}

export const approvalRecord: JsonValue = {
  decision: "APPROVE",
  assertion: { authenticatorData: "SZYN5YgO", clientDataJSON: "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0", signature: "MEUCIQ" },
  decided_at: "2026-11-03T14:09:30.000Z",
};

export interface Recorded {
  input: BuildEvidencePackInput;
  events: LedgerEvent[];
}

export interface RecordOptions {
  /** Spike S8 fallback: PayPal rejected invoice_id, so the capture carries none and C_post is ledger-only. */
  s8Fallback?: boolean;
  /** Passkey-less signer (e.g. the device-key fallback): no COSE key in the pack. */
  noPublicKey?: boolean;
}

/** Records a full purchase into a fresh Writ chain, preceded by an earlier blocked attempt. */
export function recordPurchase(path: Path, options: RecordOptions = {}): Recorded {
  const policy = policyDecision(path);
  const verifier = verifierRecord(path);
  const approval = path === "review-capture" ? approvalRecord : null;
  const cPre = commitPre(hashJcs(writBody), hashJcs(cart), hashJcs(policy));
  const cPost = verifier === null ? null : commitPost(cPre, hashJcs(verifier), approval === null ? null : hashJcs(approval));
  const cPostHex = cPost === null ? null : toHex(cPost);

  const events: LedgerEvent[] = [];
  let clock = Date.parse("2026-11-03T14:02:00.000Z");
  const push = (type: AppendEventInput["type"], payload: JsonObject, purchaseId: string | null = PURCHASE_ID): void => {
    const tail = events[events.length - 1] ?? null;
    events.push(appendEvent(tail, { type, payload, purchase_id: purchaseId, ts: new Date(clock), writ_id: WRIT_ID }));
    clock += 1_234;
  };

  push("WRIT_SIGNED", { writ_hash: hashJcsHex(writBody), credential_id: "cred_ana_phone" }, null);
  // Scene 6: the hijacked cart, blocked before PayPal. Same Writ chain, different purchase.
  push("CART_PROPOSED", { cart_hash: "aa".repeat(32), total_minor: "8500" }, ATTACK_PURCHASE_ID);
  push("POLICY_DECIDED", { verdict: "BLOCK", reasons: ["OVER_MAX_PER_ORDER", "DENY_KIND_PROTECTION_PLAN", "SHIP_TO_LOCKED"] }, ATTACK_PURCHASE_ID);
  // Scene 7.
  push("CART_PROPOSED", { cart_hash: hashJcsHex(cart) });
  push("POLICY_DECIDED", { policy_hash: hashJcsHex(policy) });
  push("BUDGET_RESERVED", { amount_minor: "4400" });
  push("PAYPAL_ORDER_CREATED", {
    order_id: ORDER_ID,
    custom_id: toCustomId(WRIT_SHORT, cPre),
    c_pre: toHex(cPre),
    amount_minor: "4400",
    currency: "USD",
    debug_id: "f1e2d3c4b5a69",
  });
  // A COMPLETED create-order response carries the authorization: same call, same debug id.
  push("PAYPAL_AUTHORIZED", { order_id: ORDER_ID, authorization_id: AUTHORIZATION_ID, debug_id: "f1e2d3c4b5a69" });
  push("SENTINEL_SCANNED", { flagged_sources: 0 });
  if (verifier !== null) push("VERIFIER_DECIDED", { verifier_hash: hashJcsHex(verifier) });
  if (path === "review-capture") {
    push("HUMAN_REVIEW_REQUESTED", { expires_at: "2026-11-04T14:02:00.000Z" });
    push("HUMAN_APPROVED", { approval_hash: hashJcsHex(approvalRecord) });
  }
  const voided = path === "void" || path === "kill-switch";
  if (path === "kill-switch") {
    // Writ-wide, so not purchase-scoped; the void that follows is.
    push("KILL_SWITCH", { reason: "user pressed the kill switch" }, null);
    push("PAYPAL_VOIDED", { authorization_id: AUTHORIZATION_ID, void_id: VOID_ID, c_post: null, debug_id: "7d6c5b4a39281" });
    push("BUDGET_RELEASED", { amount_minor: "4400" });
  } else if (path === "void") {
    push("PAYPAL_VOIDED", { authorization_id: AUTHORIZATION_ID, c_post: cPostHex, debug_id: "9a8b7c6d5e4f3" });
    push("BUDGET_RELEASED", { amount_minor: "4400" });
  } else {
    if (cPost === null) throw new Error("a capture always follows a verifier decision");
    push("PAYPAL_CAPTURED", {
      authorization_id: AUTHORIZATION_ID,
      capture_id: CAPTURE_ID,
      amount_minor: "4400",
      currency: "USD",
      c_post: toHex(cPost),
      invoice_id: options.s8Fallback === true ? null : toInvoiceId(cPost),
      debug_id: "0c1d2e3f4a5b6",
    });
    push("BUDGET_SETTLED", { amount_minor: "4400" });
  }

  const input: BuildEvidencePackInput = {
    // A string here exercises the builder's other accepted form.
    generated_at: path === "kill-switch" ? new Date(clock).toISOString() : new Date(clock),
    writ: { id: WRIT_ID, body: writBody, signature: signWrit(writBody), public_key_cose: options.noPublicKey === true ? null : rawPublicKey },
    purchase: {
      purchase_id: PURCHASE_ID,
      amount_minor: 4400n,
      currency: "USD",
      paypal: {
        order_id: ORDER_ID,
        authorization_id: AUTHORIZATION_ID,
        capture_id: voided ? null : CAPTURE_ID,
        ...(path === "kill-switch" ? { void_id: VOID_ID } : {}),
      },
    },
    cart,
    policy_decision: policy,
    verifier,
    approval,
    events,
  };
  return { input, events };
}

export const buildPack = (path: Path, options?: RecordOptions) => buildEvidencePack(recordPurchase(path, options).input);

export const otherHex = (hex: string): string => toHex(fromHex(hex).map((byte) => byte ^ 0xff));
