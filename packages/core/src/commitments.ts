// PayPal anchoring (plan §6.7). The pre-commitment rides in the order's `custom_id`, the
// post-commitment in the capture's `invoice_id`, so the PayPal record itself pins the evidence.
import { concatBytes, toHex } from "./bytes";
import { HASH_BYTES, sha256 } from "./hash";

/** Stands in for H_approval when no human review happened (auto-APPROVE path). */
export const ZERO_HASH: Uint8Array = new Uint8Array(HASH_BYTES);

/** Hex characters of a commitment carried in PayPal fields (160 bits). */
export const ANCHOR_HEX_CHARS = 40;

const WRIT_SHORT_RE = /^[a-z0-9]{6,16}$/;
const CUSTOM_ID_RE = /^writ:([a-z0-9]{6,16}):([0-9a-f]{40})$/;
const INVOICE_ID_RE = /^wv-([0-9a-f]{40})$/;

function assertHash(name: string, hash: Uint8Array): void {
  if (hash.length !== HASH_BYTES) throw new RangeError(`${name} must be ${HASH_BYTES} bytes`);
}

/** C_pre = sha256(H_w ‖ H_c ‖ H_p). Inputs are fixed-length, so plain concatenation is unambiguous. */
export function commitPre(writHash: Uint8Array, cartHash: Uint8Array, policyHash: Uint8Array): Uint8Array {
  assertHash("H_w", writHash);
  assertHash("H_c", cartHash);
  assertHash("H_p", policyHash);
  return sha256(concatBytes(writHash, cartHash, policyHash));
}

/** C_post = sha256(C_pre ‖ H_verifier ‖ H_approval); H_approval = ZERO_HASH when no human review. */
export function commitPost(cPre: Uint8Array, verifierHash: Uint8Array, approvalHash: Uint8Array | null): Uint8Array {
  assertHash("C_pre", cPre);
  assertHash("H_verifier", verifierHash);
  const approval = approvalHash ?? ZERO_HASH;
  assertHash("H_approval", approval);
  return sha256(concatBytes(cPre, verifierHash, approval));
}

/** Order `custom_id`: "writ:<writ_short>:<first 40 hex of C_pre>" (≤ 127 chars). */
export function toCustomId(writShort: string, cPre: Uint8Array): string {
  if (!WRIT_SHORT_RE.test(writShort)) throw new TypeError("writ_short must be 6-16 chars of [a-z0-9]");
  assertHash("C_pre", cPre);
  return `writ:${writShort}:${toHex(cPre).slice(0, ANCHOR_HEX_CHARS)}`;
}

/** Capture `invoice_id`: "wv-<first 40 hex of C_post>". Unique per merchant because C_post is. */
export function toInvoiceId(cPost: Uint8Array): string {
  assertHash("C_post", cPost);
  return `wv-${toHex(cPost).slice(0, ANCHOR_HEX_CHARS)}`;
}

export function parseCustomId(customId: string): { writShort: string; cPrePrefix: string } | null {
  const match = CUSTOM_ID_RE.exec(customId);
  return match ? { writShort: match[1] as string, cPrePrefix: match[2] as string } : null;
}

export function parseInvoiceId(invoiceId: string): { cPostPrefix: string } | null {
  const match = INVOICE_ID_RE.exec(invoiceId);
  return match ? { cPostPrefix: match[1] as string } : null;
}

export function customIdMatches(customId: string, writShort: string, cPre: Uint8Array): boolean {
  const parsed = parseCustomId(customId);
  return parsed !== null && parsed.writShort === writShort && parsed.cPrePrefix === toHex(cPre).slice(0, ANCHOR_HEX_CHARS);
}

export function invoiceIdMatches(invoiceId: string, cPost: Uint8Array): boolean {
  const parsed = parseInvoiceId(invoiceId);
  return parsed !== null && parsed.cPostPrefix === toHex(cPost).slice(0, ANCHOR_HEX_CHARS);
}
