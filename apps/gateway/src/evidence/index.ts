// Evidence (P0-7): the pack is assembled only from stored records: the signed Writ, the cart, the exact
// documents that were hashed (decisions rows) and the ledger chain. Anyone with the capability link can
// re-check it offline. Only sha256(token) is stored, and the token appears in no log (app.ts masks it).
import { randomBytes } from "node:crypto";
import { fromBase64Url, minorToPayPalValue, sha256, toBase64Url, toHex, verifyDeviceEd25519, writHash, WritBodySchema, type JsonValue, type WritSignature } from "@writ/core";
import type { EvidenceLinkView, ReceiptView } from "@writ/core/api";
import { verifyStoredWritSignature } from "@writ/core/signatures";
import { buildEvidencePack, VERIFICATION_INSTRUCTIONS, verifyEvidencePack, type EvidencePack, type EvidenceVerification } from "@writ/ledger";
import { and, eq, isNull } from "drizzle-orm";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import type { Db } from "../db/client";
import { carts, decisions, deviceKeys, evidenceLinks, passkeys, purchases, writs, type Purchase } from "../db/schema";
import { requireDb, type CoreServices } from "../deps";
import { httpError } from "../http/errors";
import { purchaseView } from "../http/views";
import { ledgerEventView, loadChain } from "../tx/ledger";

interface Records {
  purchase: Purchase;
  writ: typeof writs.$inferSelect;
  cart: JsonValue;
  policy: JsonValue | null;
  verifier: JsonValue | null;
  approval: JsonValue | null;
  publicKey: Uint8Array | null;
}

async function loadRecords(db: Db, tenantId: string, purchaseId: string): Promise<Records> {
  const [purchase] = await db
    .select()
    .from(purchases)
    .where(and(eq(purchases.id, purchaseId), eq(purchases.tenantId, tenantId)));
  if (purchase === undefined) throw httpError.notFound("Purchase");
  const [writ] = await db.select().from(writs).where(eq(writs.id, purchase.writId));
  const [cart] = await db.select({ body: carts.body }).from(carts).where(eq(carts.id, purchase.cartId));
  if (writ === undefined || cart === undefined) throw httpError.notFound("Purchase");
  const rows = await db.select({ stage: decisions.stage, output: decisions.output }).from(decisions).where(eq(decisions.purchaseId, purchaseId));
  const output = (stage: string): JsonValue | null => rows.find((row) => row.stage === stage)?.output ?? null;
  const signature = writ.signature as WritSignature | null;
  let publicKey: Uint8Array | null = null;
  if (signature?.kind === "webauthn") {
    const [passkey] = await db.select({ key: passkeys.publicKeyCose }).from(passkeys).where(eq(passkeys.credentialId, signature.credential_id));
    publicKey = passkey?.key ?? null;
  }
  return { purchase, writ, cart: cart.body, policy: output("policy"), verifier: output("combiner"), approval: output("human"), publicKey };
}

export function packFrom(records: Records, events: Awaited<ReturnType<typeof loadChain>>, now: Date): EvidencePack | null {
  const { purchase, writ } = records;
  if (purchase.paypalOrderId === null || purchase.authorizationId === null || records.policy === null || writ.signature === null) return null;
  return buildEvidencePack({
    generated_at: now,
    writ: { id: writ.id, body: writ.body, signature: writ.signature, public_key_cose: records.publicKey },
    purchase: {
      purchase_id: purchase.id,
      amount_minor: purchase.amountMinor,
      currency: purchase.currency,
      paypal: { order_id: purchase.paypalOrderId, authorization_id: purchase.authorizationId, capture_id: purchase.captureId },
    },
    cart: records.cart,
    policy_decision: records.policy,
    verifier: records.verifier,
    approval: records.approval,
    events,
  });
}

/** The stored assertion is re-checked against the recomputed hash; the replay counter applies only to live ceremonies. */
function signatureVerifier(deps: CoreServices, db: Db, records: Records) {
  return async (_body: JsonValue, _signature: JsonValue): Promise<boolean> => {
    const signature = records.writ.signature as WritSignature | null;
    const body = WritBodySchema.safeParse(records.writ.body);
    if (signature === null || !body.success) return false;
    if (signature.kind === "webauthn") {
      const webauthn = deps.config.webauthn;
      if (webauthn === null || records.publicKey === null) return false;
      const result = await verifyStoredWritSignature(body.data, signature, {
        webauthn: { credential: { id: signature.credential_id, publicKeyCose: records.publicKey, counter: 0 }, expectedOrigin: webauthn.origin, expectedRpId: webauthn.rpId, requireUserVerification: true },
      });
      return result.ok;
    }
    const keys = await db.select({ key: deviceKeys.publicKeyEd25519 }).from(deviceKeys).where(and(eq(deviceKeys.userId, records.writ.userId), isNull(deviceKeys.revokedAt)));
    return verifyDeviceEd25519(writHash(body.data), signature, keys.map((row) => row.key)).ok;
  };
}

export async function assemblePack(deps: CoreServices, tenantId: string, purchaseId: string): Promise<{ pack: EvidencePack; verification: EvidenceVerification } | null> {
  const db = requireDb(deps);
  const records = await loadRecords(db, tenantId, purchaseId);
  const pack = packFrom(records, await loadChain(db, records.writ.id), deps.clock());
  if (pack === null) return null;
  return { pack, verification: await verifyEvidencePack(pack, { verifyWritSignature: signatureVerifier(deps, db, records) }) };
}

export async function receipt(deps: CoreServices, tenantId: string, purchaseId: string): Promise<ReceiptView> {
  const db = requireDb(deps);
  const records = await loadRecords(db, tenantId, purchaseId);
  const events = await loadChain(db, records.writ.id);
  const pack = packFrom(records, events, deps.clock());
  const verification = pack === null ? null : await verifyEvidencePack(pack, { verifyWritSignature: signatureVerifier(deps, db, records) });
  const { purchase, writ } = records;
  const [policyRow] = await db.select({ hash: decisions.outputHash }).from(decisions).where(and(eq(decisions.purchaseId, purchaseId), eq(decisions.stage, "policy")));
  const [combiner] = await db.select({ hash: decisions.outputHash }).from(decisions).where(and(eq(decisions.purchaseId, purchaseId), eq(decisions.stage, "combiner")));
  const [human] = await db.select({ hash: decisions.outputHash }).from(decisions).where(and(eq(decisions.purchaseId, purchaseId), eq(decisions.stage, "human")));
  const [cart] = await db.select({ hash: carts.bodyHash }).from(carts).where(eq(carts.id, purchase.cartId));
  const hex = (value: Uint8Array | null | undefined): string | null => (value === null || value === undefined ? null : toHex(value));
  const signature = writ.signature as WritSignature | null;
  const orderEvent = events.find((event) => event.purchase_id === purchaseId && event.type === "PAYPAL_ORDER_CREATED");
  const captureEvent = events.find((event) => event.purchase_id === purchaseId && event.type === "PAYPAL_CAPTURED");
  return {
    purchase: purchaseView(purchase),
    writ: {
      writ_id: writ.id as ReceiptView["writ"]["writ_id"],
      purpose: String((writ.body as { purpose?: unknown }).purpose ?? "").slice(0, 140) || "Writ",
      hash: toHex(writ.bodyHash),
      signature_kind: signature?.kind ?? "device-ed25519",
      signed_at: (writ.signedAt ?? writ.createdAt).toISOString(),
    },
    commitments: {
      h_w: toHex(writ.bodyHash),
      h_c: hex(cart?.hash) ?? toHex(sha256("")),
      h_p: hex(policyRow?.hash),
      c_pre: hex(purchase.cPre),
      h_verifier: hex(combiner?.hash),
      h_approval: hex(human?.hash),
      c_post: hex(purchase.cPost),
      custom_id: typeof orderEvent?.payload["custom_id"] === "string" ? orderEvent.payload["custom_id"] : null,
      invoice_id: typeof captureEvent?.payload["invoice_id"] === "string" ? captureEvent.payload["invoice_id"] : null,
    },
    // The whole chain, so the Wallet can re-verify it in the browser; this purchase is marked by purchase_id.
    events: events.map(ledgerEventView),
    checks: (verification?.checks ?? []).map((check) => ({ name: check.name, status: check.status, detail: check.detail.slice(0, 500) })),
    pack_available: pack !== null,
  };
}

// ------------------------------------------------------------------ capability links

function linkView(row: typeof evidenceLinks.$inferSelect, token: string): EvidenceLinkView {
  return {
    link_id: row.id,
    purchase_id: row.purchaseId as EvidenceLinkView["purchase_id"],
    json_path: `/v1/evidence/${token}.json`,
    pdf_path: `/v1/evidence/${token}.pdf`,
    expires_at: row.expiresAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}

export async function createEvidenceLink(deps: CoreServices, tenantId: string, purchaseId: string): Promise<EvidenceLinkView> {
  const db = requireDb(deps);
  const records = await loadRecords(db, tenantId, purchaseId);
  if (records.purchase.paypalOrderId === null) throw httpError.conflict("no_evidence", "This purchase never reached PayPal, so there is no evidence pack.");
  const token = toBase64Url(new Uint8Array(randomBytes(32)));
  const [row] = await db
    .insert(evidenceLinks)
    .values({ id: deps.ids("evidenceLink"), tenantId, purchaseId, tokenHash: sha256(token) })
    .returning();
  if (row === undefined) throw new Error("evidence link insert returned no row");
  return linkView(row, token);
}

export async function resolveEvidenceToken(deps: CoreServices, token: string): Promise<{ tenantId: string; purchaseId: string }> {
  const db = requireDb(deps);
  let hash: Uint8Array;
  try {
    fromBase64Url(token);
    hash = sha256(token);
  } catch {
    throw httpError.notFound("Evidence");
  }
  const [row] = await db.select().from(evidenceLinks).where(eq(evidenceLinks.tokenHash, hash));
  const now = deps.clock();
  if (row === undefined || row.revokedAt !== null || (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime())) throw httpError.notFound("Evidence");
  await db.update(evidenceLinks).set({ lastAccessedAt: now }).where(eq(evidenceLinks.id, row.id));
  return { tenantId: row.tenantId, purchaseId: row.purchaseId };
}

// ------------------------------------------------------------------ PDF (plan §8.6)

/** pdf-lib's standard fonts encode WinAnsi only; merchant titles and hash symbols must not crash a dispute reply. */
function winAnsi(text: string): string {
  return text.replaceAll("‖", "||").replace(/[^\x20-\x7e]/g, "?");
}

function wrapLine(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of winAnsi(text).split(/\s+/)) {
    for (let piece = word; piece !== ""; piece = piece.slice(maxChars)) {
      const head = piece.slice(0, maxChars);
      if (`${line} ${head}`.trim().length > maxChars) {
        lines.push(line);
        line = head;
      } else {
        line = `${line} ${head}`.trim();
      }
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

export async function evidencePdf(pack: EvidencePack, verification: EvidenceVerification): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle("Writ evidence summary");
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);
  const ink = rgb(0.06, 0.07, 0.08);

  let page = pdf.addPage([595, 842]);
  let y = 790;
  const write = (text: string, options: { font?: typeof regular; size?: number; gap?: number; chars?: number } = {}): void => {
    const size = options.size ?? 10.5;
    for (const line of wrapLine(text, options.chars ?? 92)) {
      if (y < 60) {
        page = pdf.addPage([595, 842]);
        y = 790;
      }
      page.drawText(line, { x: 50, y, size, font: options.font ?? regular, color: ink });
      y -= size + 4;
    }
    y -= options.gap ?? 4;
  };

  const body = WritBodySchema.safeParse(pack.writ.body);
  const signature = pack.writ.signature as { kind?: string };
  const amount = `$${minorToPayPalValue(BigInt(pack.purchase.amount_minor), pack.purchase.currency)} ${pack.purchase.currency}`;
  const signed = pack.events[0]?.ts ?? pack.generated_at;

  write("Writ evidence summary", { font: bold, size: 18, gap: 6 });
  write("Sandbox transaction. Delivery is simulated.", { size: 9, gap: 12 });
  write("What happened", { font: bold, size: 12 });
  write(
    `On ${signed.slice(0, 16).replace("T", " at ")} UTC the account holder signed a spending mandate with ${signature.kind === "webauthn" ? "a device passkey" : "a device key"}${body.success ? ` for this purpose: "${body.data.purpose}"` : ""}.`,
  );
  if (body.success) write(`The mandate allowed up to $${minorToPayPalValue(BigInt(body.data.limits.total_minor), body.data.currency)}, and required the holder's approval above $${minorToPayPalValue(BigInt(body.data.limits.require_human_above_minor), body.data.currency)}.`);
  write(`The purchase of ${amount} was checked against that mandate before PayPal captured anything.`);
  write(pack.approval === null ? "No separate human approval was needed for this amount." : "The account holder approved this exact purchase with a separate signature.");
  write(`PayPal order ${pack.purchase.paypal.order_id}, authorization ${pack.purchase.paypal.authorization_id}${pack.purchase.paypal.capture_id === null ? "" : `, capture ${pack.purchase.paypal.capture_id}`}.`, { gap: 12 });
  write("Checks recomputed from this pack", { font: bold, size: 12 });
  for (const check of verification.checks) write(`${check.status.padEnd(4)}  ${check.name}`, { font: mono, size: 9, gap: 0 });
  y -= 10;

  page = pdf.addPage([595, 842]);
  y = 790;
  write("How to verify this yourself", { font: bold, size: 14, gap: 8 });
  for (const instruction of VERIFICATION_INSTRUCTIONS) write(instruction);
  y -= 8;
  write("Hashes", { font: bold, size: 12 });
  const commitments = pack.commitments as Record<string, unknown>;
  for (const [name, value] of Object.entries(commitments)) if (typeof value === "string") write(`${name}: ${value}`, { font: mono, size: 8.5, gap: 2, chars: 100 });
  y -= 8;
  write("The full machine-readable pack is available as JSON at the same link.", { size: 9 });
  return pdf.save();
}
