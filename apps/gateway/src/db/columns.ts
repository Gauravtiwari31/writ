import { type SQL, sql } from "drizzle-orm";
import { customType } from "drizzle-orm/pg-core";

/**
 * bytea as Uint8Array. node-postgres returns a Buffer (often a view into a pooled slab) and PGlite
 * a plain Uint8Array; copying into a fresh Uint8Array gives both drivers identical, detached values.
 */
export const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return "bytea";
  },
  fromDriver(value) {
    return new Uint8Array(value);
  },
});

const SAFE_LITERAL_RE = /^[A-Za-z0-9_]+$/;

/**
 * Inlines constant values as a SQL literal list for CHECK constraints, which cannot carry bind
 * parameters. Only identifier-like constants are accepted, so nothing here can inject SQL.
 */
export function literalList(values: readonly string[]): SQL {
  for (const value of values) {
    if (!SAFE_LITERAL_RE.test(value)) throw new TypeError(`unsafe CHECK literal: ${value}`);
  }
  return sql.raw(values.map((value) => `'${value}'`).join(", "));
}
