// App-generated primary keys: "<prefix>_<26 chars of base32>" (128 random bits). The prefix makes
// an id self-describing in logs, evidence packs and PayPal custom_id values; the random part is
// lowercase [a-z2-7] so a slice of it is a valid writ_short for the order custom_id (plan §6.7).

export const ID_PREFIXES = {
  user: "usr",
  passkey: "pk",
  deviceKey: "dk",
  vaultToken: "vt",
  address: "adr",
  agent: "ag",
  writ: "wr",
  cart: "ct",
  decision: "dc",
  purchase: "pu",
  approval: "ap",
  dispute: "dp",
  attack: "atk",
  outbox: "ob",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const RANDOM_BYTES = 16;

function base32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32.charAt((buffer >>> bits) & 31);
    }
  }
  if (bits > 0) out += BASE32.charAt((buffer << (5 - bits)) & 31);
  return out;
}

export function newId(kind: IdKind): string {
  const bytes = new Uint8Array(RANDOM_BYTES);
  crypto.getRandomValues(bytes);
  return `${ID_PREFIXES[kind]}_${base32(bytes)}`;
}

const ID_RE = /^([a-z]+)_([a-z2-7]{26})$/;

/** True when `id` has the shape newId(kind) produces; use it before trusting an id from a URL or body. */
export function isId(kind: IdKind, id: string): boolean {
  const match = ID_RE.exec(id);
  return match !== null && match[1] === ID_PREFIXES[kind];
}
