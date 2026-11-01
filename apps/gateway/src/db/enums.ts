// Closed value lists enforced by CHECK constraints in schema.ts. Code that writes these columns
// imports the same lists, so a typo fails typecheck instead of a production INSERT.

/** Purchase state machine (plan §6.3). */
export const PURCHASE_STATES = [
  "PROPOSED",
  "BLOCKED",
  "RESERVED",
  "AUTHORIZING",
  "AUTHORIZED",
  "FAILED",
  "VERIFYING",
  "CAPTURING",
  "AWAITING_HUMAN",
  "VOIDING",
  "CAPTURED",
  "VOIDED",
  "REFUNDED",
  "DISPUTED",
  "DISPUTE_WON",
  "DISPUTE_LOST",
] as const;
export type PurchaseState = (typeof PURCHASE_STATES)[number];

/** Decision verdicts, ordered by severity (plan §6.2 combiner: BLOCK > REVIEW > APPROVE). */
export const VERDICTS = ["APPROVE", "REVIEW", "BLOCK"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** plan §6.5 agents.kind. */
export const AGENT_KINDS = ["builtin", "mcp", "sdk"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

// The two lists below mirror @writ/core (asserted in test/db.test.ts). They are kept local so
// drizzle-kit can load schema.ts without evaluating the core package graph.

/** Must equal `CurrencySchema.options` in @writ/core. */
export const CURRENCIES = ["USD"] as const;

/** Must equal `WRIT_STATUSES` in @writ/core. Status lives in the DB, never in the signed body. */
export const WRIT_STATUSES = ["DRAFT", "ACTIVE", "REVOKED", "EXPIRED"] as const;
export type WritStatus = (typeof WRIT_STATUSES)[number];
