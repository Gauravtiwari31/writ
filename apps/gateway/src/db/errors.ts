// SQLSTATE helpers. Callers branch on constraint errors (an Idempotency-Key replay is a unique
// violation on purchases_agent_idempotency_unique, not a 500), so the codes live in one place.

export const PG_UNIQUE_VIOLATION = "23505";
export const PG_FOREIGN_KEY_VIOLATION = "23503";
export const PG_CHECK_VIOLATION = "23514";

export interface PgErrorInfo {
  code: string;
  constraint: string | undefined;
}

const SQLSTATE_RE = /^[0-9A-Z]{5}$/;

/**
 * The Postgres error behind `error`, if any. Drizzle wraps driver errors in DrizzleQueryError
 * (`cause`), and node-postgres and PGlite both expose `code` and `constraint`, so walk the chain.
 */
export function pgError(error: unknown): PgErrorInfo | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    if ("code" in current && typeof current.code === "string" && SQLSTATE_RE.test(current.code)) {
      const constraint = "constraint" in current && typeof current.constraint === "string" ? current.constraint : undefined;
      return { code: current.code, constraint };
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const info = pgError(error);
  return info?.code === PG_UNIQUE_VIOLATION && (constraint === undefined || info.constraint === constraint);
}

export function isCheckViolation(error: unknown, constraint?: string): boolean {
  const info = pgError(error);
  return info?.code === PG_CHECK_VIOLATION && (constraint === undefined || info.constraint === constraint);
}
