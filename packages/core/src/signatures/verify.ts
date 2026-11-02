// Writ signature verification (plan §6.2 stage 2, threat T9). The hash is always recomputed from
// the body here; a caller-supplied hash is never trusted.
import { WritBodySchema, writHash, type WritBody } from "../writ";
import { verifyDeviceEd25519 } from "./device";
import { errorDetail, signatureFailure, WritSignatureSchema, type SignatureFailure, type WritSignature } from "./schema";
import { verifyWebAuthnOverHash, type WebAuthnOverHashInput } from "./webauthn";

/**
 * Verification material, all belonging to the Writ's principal (body.principal.user_id). Looking
 * it up by that user is the caller's job; a credential of another user must never be passed.
 */
export interface WritSignatureContext {
  /** The passkey found by signature.credential_id. Writ signing should require user verification. */
  webauthn?: Omit<WebAuthnOverHashInput, "hash" | "signature">;
  /** The principal's registered Ed25519 device keys (plan §6.5 device_keys). */
  deviceKeys?: readonly Uint8Array[];
}

export type WritSignatureVerification =
  | { ok: true; kind: "webauthn"; writHash: Uint8Array; newCounter: number; userVerified: boolean }
  | { ok: true; kind: "device-ed25519"; writHash: Uint8Array; newCounter: null; userVerified: false }
  | SignatureFailure;

/** Never throws. On a passkey success, persist `newCounter`. */
export async function verifyWritSignature(
  body: WritBody,
  signature: WritSignature,
  ctx: WritSignatureContext,
): Promise<WritSignatureVerification> {
  try {
    const parsedBody = WritBodySchema.safeParse(body);
    if (!parsedBody.success) return signatureFailure("invalid_body", "Writ body does not match WritBodySchema");
    const parsedSignature = WritSignatureSchema.safeParse(signature);
    if (!parsedSignature.success) return signatureFailure("malformed", "signature does not match WritSignatureSchema");
    const hash = writHash(parsedBody.data);
    const sig = parsedSignature.data;

    if (sig.kind === "webauthn") {
      if (!ctx.webauthn) return signatureFailure("no_verifier", "no passkey credential supplied");
      const result = await verifyWebAuthnOverHash({ ...ctx.webauthn, hash, signature: sig });
      if (!result.ok) return result;
      return { ok: true, kind: "webauthn", writHash: hash, newCounter: result.newCounter, userVerified: result.userVerified };
    }

    if (!ctx.deviceKeys || ctx.deviceKeys.length === 0) return signatureFailure("no_verifier", "no device keys supplied");
    const result = verifyDeviceEd25519(hash, sig, ctx.deviceKeys);
    if (!result.ok) return result;
    return { ok: true, kind: "device-ed25519", writHash: hash, newCounter: null, userVerified: false };
  } catch (error) {
    return signatureFailure("malformed", errorDetail(error));
  }
}

/**
 * Re-verifies a signature already accepted at signing time (every checkout, receipts, evidence). The
 * authenticator counter protects live ceremonies against replay; a stored assertion can never advance
 * past its own counter, so here the counter check is off. Everything else is still verified.
 */
export function verifyStoredWritSignature(
  body: WritBody,
  signature: WritSignature,
  ctx: WritSignatureContext,
): Promise<WritSignatureVerification> {
  const webauthn = ctx.webauthn === undefined ? undefined : { ...ctx.webauthn, skipCounterCheck: true };
  return verifyWritSignature(body, signature, { ...ctx, ...(webauthn === undefined ? {} : { webauthn }) });
}
