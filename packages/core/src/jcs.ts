// RFC 8785 JSON Canonicalization Scheme. Everything Writ signs or hashes goes through `jcs`.
import canonicalize from "canonicalize";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

// A lone UTF-16 surrogate (the u flag pairs valid ones into a single code point).
const LONE_SURROGATE_RE = /\p{Cs}/u;

function assertWellFormed(text: string, path: string): void {
  // RFC 8785 requires I-JSON (RFC 7493 §2.1): a non-JS verifier could not reproduce such a hash.
  if (LONE_SURROGATE_RE.test(text)) throw new TypeError(`${path}: string contains a lone surrogate`);
}

/**
 * Rejects anything JSON.stringify would silently drop or mangle (undefined, bigint, NaN,
 * functions, Dates, class instances, array holes, lone surrogates), so a hash always covers
 * exactly what was shown.
 */
export function assertJsonValue(value: unknown, path = "$"): asserts value is JsonValue {
  if (value === null) return;
  switch (typeof value) {
    case "string":
      assertWellFormed(value, path);
      return;
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`${path}: non-finite number`);
      return;
    case "object": {
      if (Array.isArray(value)) {
        // Indexed, not forEach: a hole reads as undefined and is rejected instead of skipped.
        for (let i = 0; i < value.length; i++) assertJsonValue(value[i], `${path}[${i}]`);
        return;
      }
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new TypeError(`${path}: not a plain object`);
      for (const [key, item] of Object.entries(value)) {
        assertWellFormed(key, `${path} key`);
        assertJsonValue(item, `${path}.${key}`);
      }
      return;
    }
    default:
      throw new TypeError(`${path}: ${typeof value} is not a JSON value`);
  }
}

export function jcs(value: unknown): string {
  assertJsonValue(value);
  const out = canonicalize(value);
  if (out === undefined) throw new TypeError("value is not JSON-serializable");
  return out;
}
