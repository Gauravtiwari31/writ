// Ed25519 device-key fallback (plan §17 S6): used where passkeys are unavailable, and for the
// clearly labeled judge-mode demo key. The browser signs the same message with WebCrypto Ed25519.
import { ed25519 } from "@noble/curves/ed25519.js";
import { concatBytes, equalBytes, fromBase64Url, toBase64Url, utf8 } from "../bytes";
import { HASH_BYTES } from "../hash";
import {
  DeviceEd25519SignatureSchema,
  errorDetail,
  signatureFailure,
  type DeviceEd25519Signature,
  type SignatureFailure,
} from "./schema";

/** Domain separation: a device signature over a Writ hash can never double as any other Ed25519 signature. */
export const DEVICE_SIGNATURE_DOMAIN = "writ/0.1 device-signature\n";
const DOMAIN_BYTES = utf8(DEVICE_SIGNATURE_DOMAIN);

export type DeviceVerification = { ok: true } | SignatureFailure;

/** The exact bytes a device key signs: utf8(DEVICE_SIGNATURE_DOMAIN) ‖ hash. */
export function deviceSignatureMessage(hash: Uint8Array): Uint8Array {
  if (hash.length !== HASH_BYTES) throw new RangeError(`hash must be ${HASH_BYTES} bytes`);
  return concatBytes(DOMAIN_BYTES, hash);
}

export function generateDeviceKeyEd25519(): { secretKey: Uint8Array; publicKey: Uint8Array } {
  const { secretKey, publicKey } = ed25519.keygen();
  return { secretKey, publicKey };
}

export function signDeviceEd25519(hash: Uint8Array, secretKey: Uint8Array): DeviceEd25519Signature {
  const signature = ed25519.sign(deviceSignatureMessage(hash), secretKey);
  return {
    kind: "device-ed25519",
    public_key: toBase64Url(ed25519.getPublicKey(secretKey)),
    signature: toBase64Url(signature),
  };
}

/**
 * Verifies `signature` over `hash`. A valid signature only proves possession of the key it names,
 * so the key must also be one of `registeredPublicKeys` (the principal's device_keys rows).
 * Never throws.
 */
export function verifyDeviceEd25519(
  hash: Uint8Array,
  signature: DeviceEd25519Signature,
  registeredPublicKeys: readonly Uint8Array[],
): DeviceVerification {
  try {
    if (hash.length !== HASH_BYTES) return signatureFailure("malformed", `hash must be ${HASH_BYTES} bytes`);
    const parsed = DeviceEd25519SignatureSchema.safeParse(signature);
    if (!parsed.success) return signatureFailure("malformed", "signature does not match DeviceEd25519SignatureSchema");
    const publicKey = fromBase64Url(parsed.data.public_key);
    if (!registeredPublicKeys.some((key) => equalBytes(key, publicKey))) {
      return signatureFailure("unknown_device_key", "public key is not registered to this principal");
    }
    // Strict RFC 8032 verification (no ZIP-215 leniency) keeps signatures non-malleable.
    const valid = ed25519.verify(fromBase64Url(parsed.data.signature), deviceSignatureMessage(hash), publicKey, {
      zip215: false,
    });
    return valid ? { ok: true } : signatureFailure("bad_signature", "Ed25519 signature does not verify");
  } catch (error) {
    return signatureFailure("bad_signature", errorDetail(error));
  }
}
