// Signatures over a 32-byte document hash: a Writ hash (plan §6.6 sign) or an approval hash (P0-6).
// Passkeys (WebAuthn) are the primary signer; an Ed25519 device key is the S6 fallback.
import { z } from "zod";
import { fromBase64Url, toBase64Url } from "../bytes";

/** Rejects padding and non-zero trailing bits, so one byte string has exactly one stored spelling. */
function isCanonicalBase64Url(text: string): boolean {
  try {
    return toBase64Url(fromBase64Url(text)) === text;
  } catch {
    return false;
  }
}

function base64Url(maxChars: number) {
  return z.string().min(1).max(maxChars).refine(isCanonicalBase64Url, "expected canonical unpadded base64url");
}

function base64UrlOfLength(bytes: number) {
  return z
    .string()
    .length(Math.ceil((bytes * 4) / 3))
    .refine(isCanonicalBase64Url, `expected canonical base64url of ${bytes} bytes`);
}

/** A WebAuthn assertion as returned by navigator.credentials.get(), fields base64url-encoded. */
export const WebAuthnSignatureSchema = z.strictObject({
  kind: z.literal("webauthn"),
  /** ≤ 1023 bytes per WebAuthn L3. */
  credential_id: base64Url(1366),
  authenticator_data: base64Url(8192),
  client_data_json: base64Url(8192),
  signature: base64Url(8192),
  /** ≤ 64 bytes; null when the authenticator returned none. */
  user_handle: base64Url(86).nullable(),
});
export type WebAuthnSignature = z.infer<typeof WebAuthnSignatureSchema>;

export const DeviceEd25519SignatureSchema = z.strictObject({
  kind: z.literal("device-ed25519"),
  public_key: base64UrlOfLength(32),
  signature: base64UrlOfLength(64),
});
export type DeviceEd25519Signature = z.infer<typeof DeviceEd25519SignatureSchema>;

/** Stored in writs.signature and approvals.assertion; also embedded in the evidence pack. */
export const WritSignatureSchema = z.discriminatedUnion("kind", [WebAuthnSignatureSchema, DeviceEd25519SignatureSchema]);
export type WritSignature = z.infer<typeof WritSignatureSchema>;
export type SignatureKind = WritSignature["kind"];

export type SignatureFailureReason =
  /** Wrong shape, encoding or length (signature, hash or client data). */
  | "malformed"
  /** The assertion names a different credential than the one supplied for verification. */
  | "credential_mismatch"
  /** clientDataJSON.type is not "webauthn.get" (e.g. a registration response replayed). */
  | "type_mismatch"
  /** The assertion was made over a different hash: the document was edited, or it is a replay. */
  | "challenge_mismatch"
  | "origin_mismatch"
  /** Made inside a cross-origin iframe; Writ never asks for signatures there. */
  | "cross_origin"
  | "rp_id_mismatch"
  | "user_not_present"
  | "user_not_verified"
  /** Signature counter did not advance: a cloned authenticator or a replayed assertion. */
  | "counter_replay"
  /** The cryptographic signature does not verify against the registered public key. */
  | "bad_signature"
  /** The verification library refused the assertion for a reason not listed above. */
  | "assertion_rejected"
  /** The Ed25519 key is not one registered to the principal. */
  | "unknown_device_key"
  /** The caller supplied no credential or device key for this signature kind. */
  | "no_verifier"
  /** The Writ body itself does not match WritBodySchema. */
  | "invalid_body";

export interface SignatureFailure {
  ok: false;
  reason: SignatureFailureReason;
  detail: string;
}

export function signatureFailure(reason: SignatureFailureReason, detail: string): SignatureFailure {
  return { ok: false, reason, detail };
}

export function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
