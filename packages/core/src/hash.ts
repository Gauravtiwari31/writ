import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { toHex, utf8 } from "./bytes";
import { jcs } from "./jcs";

export const HASH_BYTES = 32;

export function sha256(data: Uint8Array | string): Uint8Array {
  return nobleSha256(typeof data === "string" ? utf8(data) : data);
}

/** sha256(JCS(value)) — the hash of a signed or committed document (plan §6.7: H_w, H_c, H_p). */
export function hashJcs(value: unknown): Uint8Array {
  return sha256(jcs(value));
}

export function hashJcsHex(value: unknown): string {
  return toHex(hashJcs(value));
}
