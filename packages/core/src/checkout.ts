// Checkout timing and scan limits (plan §6.2, §6.8; docs/ARCHITECTURE.md §3.3 and §5). One place
// for every number that the decision pipeline (api stream), the saga and its recovery (money), the
// agents' HTTP client (agents) and the judge's hero run (judge) must agree on, so that a live
// checkout can never be mistaken for a dead one.
//
// Invariants (asserted in test/contracts.test.ts):
//   AUTHORIZE_WAIT_MS + PIPELINE_DEADLINE_MS < CHECKOUT_BUDGET_MS < AGENT_API_TIMEOUT_MS
//   CHECKOUT_BUDGET_MS < STALLED_PIPELINE_MS
// so recovery only ever touches a purchase whose checkout request has certainly ended or died,
// whichever gateway instance ran it (Render overlaps the old and new instance during a deploy).

/** How long POST /v1/agent/checkout waits for the PayPal authorization (AUTHORIZING → AUTHORIZED | FAILED) before answering 202. */
export const AUTHORIZE_WAIT_MS = 20_000;

/**
 * Sentinel + Verifier together, from AUTHORIZED → VERIFYING until the combined record is built. A
 * stage still running at the deadline is recorded as { status: "timeout" } (REVIEW, fail closed)
 * and the pipeline calls saga.execute with what it has.
 */
export const PIPELINE_DEADLINE_MS = 45_000;

/** Upper bound of one POST /v1/agent/checkout, database work included. */
export const CHECKOUT_BUDGET_MS = 75_000;

/** AgentApiClient's default per-request timeout: longer than any checkout. */
export const AGENT_API_TIMEOUT_MS = 90_000;

/**
 * The saga's recovery task (every 30 s) fails closed a purchase that has sat in PROPOSED, RESERVED,
 * AUTHORIZED or VERIFYING (PIPELINE_PURCHASE_STATES) for longer than this, measured from
 * purchases.updated_at: PROPOSED → BLOCKED and RESERVED → FAILED (checkout_interrupted, no money
 * held), AUTHORIZED / VERIFYING → VOIDING (verification_interrupted).
 */
export const STALLED_PIPELINE_MS = 120_000;

/**
 * After a policy BLOCK the deterministic Sentinel rules (no model, no LLM budget) still scan the
 * cart's sources so the injected text can be shown and counted (hero scenes 5-6); the scan can
 * never change the BLOCK and is bounded by this.
 */
export const BLOCKED_SCAN_DEADLINE_MS = 15_000;

/** Distinct (by URL) agent-declared sources the pipeline fetches and scans per checkout; any beyond → one { status: "error" } signal (REVIEW). */
export const SENTINEL_MAX_SOURCES = 8;

/** Page fetches in flight at once while the pipeline scans sources. */
export const SENTINEL_FETCH_CONCURRENCY = 4;
