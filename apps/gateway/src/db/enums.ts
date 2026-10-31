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

/** Must equal `CurrencySchema.options` in @writ/core (asserted in test/db.test.ts). Kept local so drizzle-kit can load the schema without the core package graph. */
export const CURRENCIES = ["USD"] as const;
