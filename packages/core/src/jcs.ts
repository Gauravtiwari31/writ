// RFC 8785 JSON Canonicalization Scheme. Everything Writ signs or hashes goes through `jcs`.
import canonicalize from "canonicalize";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/**
 * Rejects anything JSON.stringify would silently drop or mangle (undefined, bigint, NaN,
 * functions, Dates, class instances), so a hash always covers exactly what was shown.
 */
export function assertJsonValue(value: unknown, path = "$"): asserts value is JsonValue {
  if (value === null) return;
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`${path}: non-finite number`);
      return;
    case "object": {
      if (Array.isArray(value)) {
        value.forEach((item, i) => assertJsonValue(item, `${path}[${i}]`));
        return;
      }
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new TypeError(`${path}: not a plain object`);
      for (const [key, item] of Object.entries(value)) assertJsonValue(item, `${path}.${key}`);
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
