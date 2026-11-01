// Prefixed ULIDs: "<prefix>_<26 chars of lowercase Crockford base32>". 48-bit ms time first
// (index locality, sortable), then 80 random bits. Isomorphic: WebCrypto only.
import { z } from "zod";

export const ID_PREFIXES = ["wr", "crt", "pur", "agt", "usr", "adr", "apr"] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];

/** Milliseconds since the Unix epoch. Injected so tests and replays get deterministic ids. */
export type Clock = () => number;

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
const TIME_CHARS = 10;
/** 80 random bits → 16 base32 chars. */
const RANDOM_BYTES = 10;
const MAX_TIME = 2 ** 48 - 1;
/** 48 time bits fill 10 chars with 2 bits to spare, so the first char is always 0-7. */
const ULID_SOURCE = "[0-7][0-9a-hjkmnp-tv-z]{25}";
const ANY_ID_RE = new RegExp(`^(${ID_PREFIXES.join("|")})_(${ULID_SOURCE})$`);
const WRIT_ID_RE = new RegExp(`^wr_${ULID_SOURCE}$`);
export const WRIT_SHORT_CHARS = 12;

function encodeTime(time: number): string {
  let out = "";
  let rest = time;
  for (let i = 0; i < TIME_CHARS; i++) {
    out = CROCKFORD.charAt(rest % 32) + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD.charAt((acc >> bits) & 31);
    }
    acc &= (1 << bits) - 1;
  }
  return out;
}

export function newId(prefix: IdPrefix, clock: Clock = Date.now): string {
  if (!(ID_PREFIXES as readonly string[]).includes(prefix)) throw new TypeError(`unknown id prefix: ${prefix}`);
  const time = clock();
  if (!Number.isSafeInteger(time) || time < 0 || time > MAX_TIME) {
    throw new RangeError("clock must return integer milliseconds in [0, 2^48)");
  }
  const random = globalThis.crypto.getRandomValues(new Uint8Array(RANDOM_BYTES));
  return `${prefix}_${encodeTime(time)}${encodeRandom(random)}`;
}

export function idSchema(prefix: IdPrefix) {
  return z.string().regex(new RegExp(`^${prefix}_${ULID_SOURCE}$`), `expected a ${prefix}_ id`);
}

export function isId(prefix: IdPrefix, value: string): boolean {
  const match = ANY_ID_RE.exec(value);
  return match !== null && match[1] === prefix;
}

/** Creation time encoded in an id (ms since epoch). */
export function idTimestamp(id: string): number {
  const match = ANY_ID_RE.exec(id);
  if (!match) throw new TypeError(`not a Writ id: ${JSON.stringify(id)}`);
  let time = 0;
  for (const char of (match[2] as string).slice(0, TIME_CHARS)) time = time * 32 + CROCKFORD.indexOf(char);
  return time;
}

/**
 * 12 chars for the PayPal `custom_id` ("writ:<short>:…", which allows [a-z0-9]{6,16}). Taken from
 * the random part: Writs created in the same hour share their time prefix.
 */
export function writShort(writId: string): string {
  if (!WRIT_ID_RE.test(writId)) throw new TypeError(`not a writ id: ${JSON.stringify(writId)}`);
  const start = "wr_".length + TIME_CHARS;
  return writId.slice(start, start + WRIT_SHORT_CHARS);
}

/**
 * Merchant ids are lowercase slugs or domains ("writ-market", "etsy.com"). Lowercase-only keeps
 * Writ allow/deny lists exact-match: "Etsy.com" cannot slip past a deny entry for "etsy.com".
 */
export const MerchantIdSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9._:-]{0,62}[a-z0-9])?$/, "merchant id: lowercase slug or domain, 1-64 chars");
export type MerchantId = z.infer<typeof MerchantIdSchema>;
