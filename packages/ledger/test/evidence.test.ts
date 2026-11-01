import { generateKeyPairSync } from "node:crypto";
import {
  commitPost,
  commitPre,
  fromBase64Url,
  fromHex,
  hashJcs,
  hashJcsHex,
  isId,
  toBase64Url,
  toCustomId,
  toHex,
  toInvoiceId,
  writShort,
} from "@writ/core";
import { describe, expect, it } from "vitest";
import {
  appendEvent,
  buildEvidencePack,
  EVIDENCE_CHECK_NAMES,
  EVIDENCE_SPEC,
  verifyEvidencePack,
  type EvidenceCheckName,
  type EvidencePack,
  type JsonObject,
  type LedgerEvent,
  type VerifyEvidenceOptions,
} from "../src/index";
import {
  ATTACK_PURCHASE_ID,
  AUTHORIZATION_ID,
  buildPack,
  CAPTURE_ID,
  cart,
  ORDER_ID,
  OTHER_PURCHASE_ID,
  OTHER_WRIT_ID,
  otherHex,
  PURCHASE_ID,
  recordPurchase,
  signWrit,
  verifierRecord,
  verifyWritSignature,
  VOID_ID,
  WRIT_ID,
  WRIT_SHORT,
  writBody,
  approvalRecord,
  policyDecision,
} from "./fixtures";

const withSignature: VerifyEvidenceOptions = { verifyWritSignature };

const at = <T>(list: readonly T[], index: number): T => {
  const item = list[index];
  if (item === undefined) throw new Error(`no item at ${index}`);
  return item;
};

async function failing(pack: unknown, options: VerifyEvidenceOptions = withSignature): Promise<EvidenceCheckName[]> {
  const result = await verifyEvidencePack(pack, options);
  const failed = result.checks.filter((check) => check.status === "FAIL").map((check) => check.name);
  expect(result.ok).toBe(failed.length === 0);
  return failed.sort();
}

async function statuses(pack: unknown, options?: VerifyEvidenceOptions): Promise<Record<string, string>> {
  const result = await verifyEvidencePack(pack, options);
  return Object.fromEntries(result.checks.map((check) => [check.name, check.status]));
}

/** Re-appends events in the given order (seq 1..n) with optional payload edits: a consistent re-hash. */
function rehash(events: readonly LedgerEvent[], edit: (event: LedgerEvent) => JsonObject = (event) => event.payload): LedgerEvent[] {
  const out: LedgerEvent[] = [];
  events.forEach((event, i) => {
    out.push(
      appendEvent(out[out.length - 1] ?? null, {
        type: event.type,
        payload: edit(event),
        ts: event.ts,
        purchase_id: event.purchase_id,
        writ_id: event.writ_id,
        seq: i + 1,
      }),
    );
  });
  return out;
}

const indexOfType = (events: readonly LedgerEvent[], type: LedgerEvent["type"]): number => {
  const index = events.findIndex((event) => event.type === type && event.purchase_id === PURCHASE_ID);
  if (index < 0) throw new Error(`no ${type}`);
  return index;
};

describe("buildEvidencePack", () => {
  it("uses @writ/core ids throughout the fixtures", () => {
    expect([WRIT_ID, OTHER_WRIT_ID].every((id) => isId("wr", id))).toBe(true);
    expect([PURCHASE_ID, ATTACK_PURCHASE_ID, OTHER_PURCHASE_ID].every((id) => isId("pur", id))).toBe(true);
    expect(WRIT_SHORT).toBe(writShort(WRIT_ID));
  });

  it("assembles a writ-evidence/0.1 pack with recomputed commitments and ledger anchors", () => {
    const { input, events } = recordPurchase("review-capture");
    const pack = buildEvidencePack(input);
    const cPre = commitPre(hashJcs(writBody), hashJcs(cart), hashJcs(policyDecision("review-capture")));
    const cPost = commitPost(cPre, hashJcs(verifierRecord("review-capture")), hashJcs(approvalRecord));

    expect(pack.spec).toBe(EVIDENCE_SPEC);
    expect(pack.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(pack.writ).toMatchObject({ id: WRIT_ID, short: WRIT_SHORT, hash: hashJcsHex(writBody) });
    expect(fromBase64Url(pack.writ.public_key_cose ?? "")).toHaveLength(32);
    expect(pack.purchase).toEqual({
      purchase_id: PURCHASE_ID,
      amount_minor: "4400",
      currency: "USD",
      paypal: {
        order_id: ORDER_ID,
        authorization_id: AUTHORIZATION_ID,
        capture_id: CAPTURE_ID,
        // Deduplicated: the create-order call also returned the authorization.
        debug_ids: ["f1e2d3c4b5a69", "0c1d2e3f4a5b6"],
      },
    });
    expect(pack.commitments).toEqual({
      h_w: hashJcsHex(writBody),
      h_c: hashJcsHex(cart),
      h_p: hashJcsHex(policyDecision("review-capture")),
      c_pre: toHex(cPre),
      h_verifier: hashJcsHex(verifierRecord("review-capture")),
      h_approval: hashJcsHex(approvalRecord),
      c_post: toHex(cPost),
      custom_id: toCustomId(WRIT_SHORT, cPre),
      invoice_id: toInvoiceId(cPost),
    });
    expect(pack.events).toEqual(events);
    expect(pack.verification.instructions.length).toBeGreaterThan(5);
  });

  it("omits void_id unless given and never leaves undefined in the JSON", () => {
    const { input } = recordPurchase("void");
    const pack = buildEvidencePack(input);
    expect("void_id" in pack.purchase.paypal).toBe(false);
    expect(JSON.parse(JSON.stringify(pack))).toEqual(pack);
  });

  it("refuses a purchase that never reached PayPal", () => {
    const { input } = recordPurchase("review-capture");
    expect(() => buildEvidencePack({ ...input, events: input.events.filter((event) => event.type !== "PAYPAL_ORDER_CREATED") })).toThrow(
      /PAYPAL_ORDER_CREATED/,
    );
  });
});

describe("verifyEvidencePack", () => {
  it("passes every check for the hero purchase (review → passkey → capture), after a JSON round trip", async () => {
    const pack = buildPack("review-capture");
    const roundTripped: unknown = JSON.parse(JSON.stringify(pack));
    expect(roundTripped).toEqual(pack);

    const result = await verifyEvidencePack(roundTripped, withSignature);
    expect(result.checks.map((check) => check.name)).toEqual([...EVIDENCE_CHECK_NAMES]);
    expect(result.checks.filter((check) => check.status !== "PASS")).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("verifies a kill-switch void before the verifier ran (no verifier record, no post-commitment)", async () => {
    const { input } = recordPurchase("kill-switch", { noPublicKey: true });
    const pack = buildEvidencePack(input);
    expect(pack.generated_at).toBe(input.generated_at);
    expect(pack.writ.public_key_cose).toBeNull();
    expect(pack.verifier).toBeNull();
    expect(pack.purchase.paypal).toMatchObject({ capture_id: null, void_id: VOID_ID });
    expect(pack.commitments).toMatchObject({ h_verifier: null, h_approval: null, c_post: null, invoice_id: null });
    expect(await failing(pack, {})).toEqual([]);
    expect(await statuses(pack, {})).toMatchObject({
      h_verifier: "SKIP",
      h_approval: "SKIP",
      c_post: "SKIP",
      invoice_id: "SKIP",
      writ_signature: "SKIP",
      ledger_commitments: "PASS",
      paypal_ids: "PASS",
    });

    // Grafting a verifier record onto it afterwards is caught by the void event's recorded C_post (null).
    const forged = structuredClone(pack);
    forged.verifier = verifierRecord("auto-capture");
    forged.commitments.h_verifier = hashJcsHex(forged.verifier);
    forged.commitments.c_post = toHex(commitPost(fromHex(forged.commitments.c_pre), hashJcs(forged.verifier), null));
    expect(await failing(forged, {})).toEqual(["ledger_commitments"]);
  });

  it("marks not-applicable checks SKIP on the auto-approve path and without a signature verifier", async () => {
    const pack = buildPack("auto-capture");
    expect(await failing(pack, {})).toEqual([]);
    const result = await statuses(pack);
    expect(Object.entries(result).filter(([, status]) => status === "SKIP").map(([name]) => name).sort()).toEqual(["h_approval", "writ_signature"]);
  });

  it("verifies the void path (verifier BLOCK → void, no capture, no invoice)", async () => {
    const pack = buildPack("void");
    expect(pack.purchase.paypal.capture_id).toBeNull();
    expect(pack.commitments.invoice_id).toBeNull();
    expect(await failing(pack)).toEqual([]);
    const result = await statuses(pack, withSignature);
    expect(result).toMatchObject({ c_post: "PASS", invoice_id: "SKIP", h_approval: "SKIP", paypal_ids: "PASS", ledger_commitments: "PASS" });
  });

  const base = buildPack("review-capture");
  const mutate = (fn: (pack: EvidencePack) => void): EvidencePack => {
    const copy = structuredClone(base);
    fn(copy);
    return copy;
  };
  const otherKey = toBase64Url(fromBase64Url(generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x ?? ""));
  const captureIndex = indexOfType(base.events, "PAYPAL_CAPTURED");
  const orderIndex = indexOfType(base.events, "PAYPAL_ORDER_CREATED");

  it.each<[string, (pack: EvidencePack) => void, EvidenceCheckName[]]>([
    ["writ.body", (p) => void ((p.writ.body as JsonObject)["limit_minor"] = "600000"), ["h_w", "writ_hash", "writ_signature"]],
    ["writ.body.writ_id", (p) => void ((p.writ.body as JsonObject)["writ_id"] = OTHER_WRIT_ID), ["h_w", "writ_hash", "writ_id", "writ_signature"]],
    ["writ.hash", (p) => void (p.writ.hash = otherHex(p.writ.hash)), ["writ_hash", "writ_signed_event"]],
    ["writ.id", (p) => void (p.writ.id = OTHER_WRIT_ID), ["writ_id", "writ_signed_event"]],
    ["writ.short", (p) => void (p.writ.short = "deadbeef"), ["custom_id", "writ_id"]],
    ["writ.signature", (p) => void (p.writ.signature = signWrit({ forged: true })), ["writ_signature"]],
    ["writ.public_key_cose", (p) => void (p.writ.public_key_cose = otherKey), ["writ_signature"]],
    ["commitments.h_w", (p) => void (p.commitments.h_w = otherHex(p.commitments.h_w)), ["c_pre", "h_w"]],
    ["commitments.h_c", (p) => void (p.commitments.h_c = otherHex(p.commitments.h_c)), ["c_pre", "h_c"]],
    ["commitments.h_p", (p) => void (p.commitments.h_p = otherHex(p.commitments.h_p)), ["c_pre", "h_p"]],
    ["commitments.c_pre", (p) => void (p.commitments.c_pre = otherHex(p.commitments.c_pre)), ["c_post", "c_pre", "custom_id", "ledger_commitments"]],
    ["commitments.custom_id", (p) => void (p.commitments.custom_id = `writ:${WRIT_SHORT}:${"0".repeat(40)}`), ["custom_id", "paypal_anchors"]],
    ["commitments.h_verifier", (p) => void (p.commitments.h_verifier = otherHex(p.commitments.h_verifier ?? "")), ["c_post", "h_verifier"]],
    ["commitments.h_approval", (p) => void (p.commitments.h_approval = otherHex(p.commitments.h_approval ?? "")), ["c_post", "h_approval"]],
    ["commitments.h_approval → null", (p) => void (p.commitments.h_approval = null), ["c_post", "h_approval"]],
    ["commitments.c_post", (p) => void (p.commitments.c_post = otherHex(p.commitments.c_post ?? "")), ["c_post", "invoice_id", "ledger_commitments"]],
    ["commitments.c_post → null", (p) => void (p.commitments.c_post = null), ["c_post", "invoice_id", "ledger_commitments"]],
    ["commitments.invoice_id", (p) => void (p.commitments.invoice_id = `wv-${"0".repeat(40)}`), ["invoice_id", "paypal_anchors"]],
    ["commitments.invoice_id → null", (p) => void (p.commitments.invoice_id = null), ["paypal_anchors"]],
    ["cart", (p) => void ((p.cart as JsonObject)["total_minor"] = "440"), ["h_c"]],
    ["policy_decision", (p) => void ((p.policy_decision as JsonObject)["verdict"] = "APPROVE"), ["h_p"]],
    ["verifier", (p) => void ((p.verifier as JsonObject)["confidence"] = 0.99), ["h_verifier"]],
    ["verifier → null", (p) => void (p.verifier = null), ["h_verifier"]],
    ["approval", (p) => void ((p.approval as JsonObject)["decision"] = "DECLINE"), ["h_approval"]],
    ["approval → null", (p) => void (p.approval = null), ["h_approval"]],
    ["an event payload", (p) => void (at(p.events, 3).payload["cart_hash"] = "00".repeat(32)), ["chain"]],
    ["the WRIT_SIGNED payload", (p) => void (at(p.events, 0).payload["writ_hash"] = otherHex(p.writ.hash)), ["chain", "writ_signed_event"]],
    ["the PAYPAL_CAPTURED event (deleted)", (p) => void p.events.splice(captureIndex, 1), ["chain", "debug_ids", "paypal_anchors", "paypal_ids"]],
    ["the genesis event (deleted)", (p) => void p.events.shift(), ["chain", "writ_signed_event"]],
    ["the WRIT_SIGNED payload's writ_hash (deleted)", (p) => void delete at(p.events, 0).payload["writ_hash"], ["chain", "writ_signed_event"]],
    ["writ.body → not an object", (p) => void (p.writ.body = "a pottery gift"), ["h_w", "writ_hash", "writ_id", "writ_signature"]],
    ["verifier and h_verifier → null", (p) => void ((p.verifier = null), (p.commitments.h_verifier = null)), ["c_post"]],
    [
      "the c_post recorded by PAYPAL_CAPTURED (deleted)",
      (p) => void delete at(p.events, captureIndex).payload["c_post"],
      ["chain", "ledger_commitments", "paypal_amounts", "paypal_anchors", "paypal_ids"],
    ],
    [
      "the c_pre recorded by PAYPAL_ORDER_CREATED (edited in place)",
      (p) => void (at(p.events, orderIndex).payload["c_pre"] = otherHex(p.commitments.c_pre)),
      ["chain", "ledger_commitments", "paypal_amounts", "paypal_anchors", "paypal_ids"],
    ],
    [
      "the c_post recorded by PAYPAL_CAPTURED (edited in place)",
      (p) => void (at(p.events, captureIndex).payload["c_post"] = otherHex(p.commitments.c_post ?? "")),
      ["chain", "ledger_commitments", "paypal_amounts", "paypal_anchors", "paypal_ids"],
    ],
    [
      "purchase.purchase_id",
      (p) => void (p.purchase.purchase_id = OTHER_PURCHASE_ID),
      ["debug_ids", "ledger_commitments", "paypal_amounts", "paypal_anchors", "paypal_ids"],
    ],
    ["purchase.paypal.order_id", (p) => void (p.purchase.paypal.order_id = "8XX00000000000000"), ["paypal_ids"]],
    ["purchase.paypal.authorization_id", (p) => void (p.purchase.paypal.authorization_id = "9YY00000000000000"), ["paypal_ids"]],
    ["purchase.paypal.capture_id", (p) => void (p.purchase.paypal.capture_id = "7ZZ00000000000000"), ["paypal_ids"]],
    ["purchase.paypal.capture_id → null", (p) => void (p.purchase.paypal.capture_id = null), ["paypal_ids"]],
    ["purchase.paypal.void_id (added)", (p) => void (p.purchase.paypal.void_id = "VOID1"), ["paypal_ids"]],
    ["purchase.amount_minor", (p) => void (p.purchase.amount_minor = "4401"), ["paypal_amounts"]],
    ["purchase.paypal.debug_ids", (p) => void p.purchase.paypal.debug_ids.pop(), ["debug_ids"]],
  ])("fails exactly the checks that cover %s", async (_field, fn, expected) => {
    expect(await failing(mutate(fn))).toEqual(expected);
  });

  it.each<[string, unknown]>([
    ["null", null],
    ["a non-object", "evidence"],
    ["another spec", { ...base, spec: "writ-evidence/9.9" }],
    ["an unknown top-level field", { ...base, trust_me: true }],
    ["an unknown nested field", { ...base, commitments: { ...base.commitments, note: "x" } }],
    ["a float amount", { ...base, purchase: { ...base.purchase, amount_minor: 44 } }],
    ["a writ id that is not a core wr_ id", { ...base, writ: { ...base.writ, id: "writ_7f3a9c21" } }],
    ["a padded public key", { ...base, writ: { ...base.writ, public_key_cose: `${base.writ.public_key_cose ?? ""}=` } }],
    ["uppercase hex", { ...base, commitments: { ...base.commitments, c_pre: base.commitments.c_pre.toUpperCase() } }],
    ["no events", { ...base, events: [] }],
    ["a bad timestamp", { ...base, generated_at: "Nov 3 2026" }],
  ])("rejects %s at the schema check and runs nothing else", async (_name, input) => {
    const result = await verifyEvidencePack(input, withSignature);
    expect(result.ok).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ name: "schema", status: "FAIL" });
  });

  it("reports a throwing or rejecting signature verifier as FAIL", async () => {
    const thrown = await verifyEvidencePack(base, {
      verifyWritSignature: () => {
        throw new Error("bad COSE key");
      },
    });
    expect(thrown.checks.find((check) => check.name === "writ_signature")).toMatchObject({ status: "FAIL", detail: expect.stringContaining("bad COSE key") });
    const rejected = await verifyEvidencePack(base, { verifyWritSignature: () => Promise.reject("no key") });
    expect(rejected.checks.find((check) => check.name === "writ_signature")).toMatchObject({ status: "FAIL", detail: expect.stringContaining("no key") });
    // Only a literal `true` passes: a truthy non-boolean from a sloppy callback must not.
    const truthy = await statuses(base, { verifyWritSignature: () => "yes" as unknown as boolean });
    expect(truthy["writ_signature"]).toBe("FAIL");
  });

  it("accepts an async signature verifier", async () => {
    expect(await failing(base, { verifyWritSignature: async (...args) => verifyWritSignature(...args) })).toEqual([]);
  });

  it("catches a re-hashed chain whose PayPal events disagree with the commitments", async () => {
    const forgedCPre = "f".repeat(64);
    const forgedEvents = rehash(base.events, (event) =>
      event.type === "PAYPAL_ORDER_CREATED"
        ? { ...event.payload, c_pre: forgedCPre, custom_id: `writ:${WRIT_SHORT}:${forgedCPre.slice(0, 40)}` }
        : event.payload,
    );
    const pack = { ...base, events: forgedEvents };
    expect(await failing(pack)).toEqual(["ledger_commitments", "paypal_anchors"]);
  });

  it("binds the verifier and approval records under the Spike S8 fallback (no invoice_id at PayPal)", async () => {
    const fallback = buildPack("review-capture", { s8Fallback: true });
    expect(fallback.commitments.invoice_id).toBeNull();
    const result = await statuses(fallback, withSignature);
    expect(Object.values(result).every((status) => status !== "FAIL")).toBe(true);
    expect(result).toMatchObject({ invoice_id: "SKIP", ledger_commitments: "PASS", c_post: "PASS" });

    // Swap the approval and recompute every pack-side hash: only the ledger still remembers C_post.
    const forgedApproval = { ...(approvalRecord as JsonObject), decided_at: "2026-11-03T16:00:00.000Z" };
    const hA = hashJcs(forgedApproval);
    const forged = structuredClone(fallback);
    forged.approval = forgedApproval;
    forged.commitments.h_approval = toHex(hA);
    forged.commitments.c_post = toHex(commitPost(fromHex(forged.commitments.c_pre), fromHex(forged.commitments.h_verifier ?? ""), hA));
    expect(await failing(forged)).toEqual(["ledger_commitments"]);
  });

  it("binds the verifier record on the void path, where nothing reaches PayPal after authorization", async () => {
    const voided = buildPack("void");
    const forgedVerifier = { ...(voided.verifier as JsonObject), verdict: "APPROVE" };
    const hV = hashJcs(forgedVerifier);
    const forged = structuredClone(voided);
    forged.verifier = forgedVerifier;
    forged.commitments.h_verifier = toHex(hV);
    forged.commitments.c_post = toHex(commitPost(fromHex(forged.commitments.c_pre), hV, null));
    expect(await failing(forged)).toEqual(["ledger_commitments"]);
  });

  it("catches PayPal events recorded out of order", async () => {
    const events = [...base.events];
    const [authorized] = events.splice(indexOfType(events, "PAYPAL_AUTHORIZED"), 1);
    events.splice(indexOfType(events, "PAYPAL_CAPTURED") + 1, 0, authorized as LedgerEvent);
    expect(await failing({ ...base, events: rehash(events) })).toEqual(["paypal_ids"]);
  });

  it("catches an authorization that is both captured and voided, or a foreign PayPal ID", async () => {
    const tail = at(base.events, base.events.length - 1);
    const voided = appendEvent(tail, {
      type: "PAYPAL_VOIDED",
      purchase_id: PURCHASE_ID,
      ts: "2026-11-03T15:00:00.000Z",
      payload: { authorization_id: AUTHORIZATION_ID, c_post: base.commitments.c_post },
    });
    expect(await failing({ ...base, events: [...base.events, voided] })).toEqual(["paypal_ids"]);

    const foreign = appendEvent(tail, { type: "PAYPAL_AUTHORIZED", purchase_id: PURCHASE_ID, ts: "2026-11-03T15:00:00.000Z", payload: { order_id: ORDER_ID, authorization_id: "1AB00000000000000" } });
    expect(await failing({ ...base, events: [...base.events, foreign] })).toEqual(["paypal_ids"]);
  });

  it("is internally consistent after a wholesale re-forgery, which is why writ-verify must also compare custom_id/invoice_id with PayPal", async () => {
    // An attacker who controls the whole pack can swap the cart and recompute everything except the
    // Writ signature (the Writ is unchanged) and the PayPal record, which still holds the original anchors.
    const forgedCart = { ...(cart as JsonObject), total_minor: "9900" };
    const { input } = recordPurchase("review-capture");
    const cPre = commitPre(hashJcs(writBody), hashJcs(forgedCart), hashJcs(input.policy_decision));
    const cPost = commitPost(cPre, hashJcs(input.verifier), hashJcs(input.approval));
    const events = rehash(input.events, (event) => {
      if (event.type === "PAYPAL_ORDER_CREATED") return { ...event.payload, custom_id: toCustomId(WRIT_SHORT, cPre), c_pre: toHex(cPre) };
      if (event.type === "PAYPAL_CAPTURED") return { ...event.payload, invoice_id: toInvoiceId(cPost), c_post: toHex(cPost) };
      return event.payload;
    });
    const forged = buildEvidencePack({ ...input, cart: forgedCart, events });
    expect(await failing(forged)).toEqual([]);
    expect(forged.commitments.custom_id).not.toBe(base.commitments.custom_id);
    expect(forged.commitments.invoice_id).not.toBe(base.commitments.invoice_id);
  });
});
