// Closed value lists enforced by CHECK constraints in schema.ts. Code that writes these columns
// imports the same lists, so a typo fails typecheck instead of a production INSERT.
//
// Every list below mirrors @writ/core (asserted in test/db.test.ts). They are kept local so
// drizzle-kit can load schema.ts without evaluating the core package graph.

/** Purchase state machine (plan §6.3). Must equal `PURCHASE_STATES` in @writ/core. */
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

/** purchases.state_reason. Must equal `PURCHASE_STATE_REASONS` in @writ/core. */
export const PURCHASE_STATE_REASONS = [
  "policy_blocked",
  "budget_exhausted",
  "checkout_interrupted",
  "paypal_unconfigured",
  "paypal_not_connected",
  "paypal_error",
  "payer_action_required",
  "authorization_declined",
  "verifier_blocked",
  "human_declined",
  "approval_expired",
  "kill_switch",
  "writ_revoked",
  "writ_expired",
  "settle_refused",
  "capture_failed",
  "verification_interrupted",
  "platform_liability",
  "dispute_opened",
  "dispute_won",
  "dispute_lost",
] as const;

/** Decision verdicts, ordered by severity (plan §6.2 combiner: BLOCK > REVIEW > APPROVE). */
export const VERDICTS = ["APPROVE", "REVIEW", "BLOCK"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** plan §6.5 agents.kind. Must equal `AGENT_KINDS` in @writ/core/api. */
export const AGENT_KINDS = ["builtin", "mcp", "sdk"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** agents.builtin_kind and agent_runs.agent_kind. Must equal `BUILTIN_AGENT_KINDS` in @writ/core/api. */
export const BUILTIN_AGENT_KINDS = ["atlas", "scout"] as const;
export type BuiltinAgentKind = (typeof BUILTIN_AGENT_KINDS)[number];

/** Must equal `CurrencySchema.options` in @writ/core. */
export const CURRENCIES = ["USD"] as const;

/** Must equal `WRIT_STATUSES` in @writ/core. Status lives in the DB, never in the signed body. */
export const WRIT_STATUSES = ["DRAFT", "ACTIVE", "REVOKED", "EXPIRED"] as const;
export type WritStatus = (typeof WRIT_STATUSES)[number];

/** decisions.stage. Must equal `DECISION_RECORD_STAGES` in @writ/core. */
export const DECISION_RECORD_STAGES = [
  "preview",
  "schema",
  "policy",
  "threshold",
  "reserve",
  "authorize",
  "sentinel",
  "verifier",
  "combiner",
  "human",
] as const;
export type DecisionRecordStage = (typeof DECISION_RECORD_STAGES)[number];

/** approvals.status. Must equal `APPROVAL_STATUSES` in @writ/core. */
export const APPROVAL_STATUSES = ["PENDING", "APPROVED", "DECLINED", "EXPIRED", "CANCELLED"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** approvals.decision. Must equal `APPROVAL_DECISIONS` in @writ/core. */
export const APPROVAL_DECISIONS = ["APPROVE", "DECLINE"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/** paypal_vault_tokens.status. Must equal `VAULT_TOKEN_STATUSES` in @writ/core/api. */
export const VAULT_TOKEN_STATUSES = ["PENDING", "ACTIVE", "REVOKED", "FAILED"] as const;
export type VaultTokenStatus = (typeof VAULT_TOKEN_STATUSES)[number];

/** agent_runs.status / .mode. Must equal `RUN_STATUSES` / `RUN_MODES` in @writ/core/api. */
export const RUN_STATUSES = ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const RUN_MODES = ["manual", "hero"] as const;
export type RunMode = (typeof RUN_MODES)[number];

/** catalog_items.source. Must equal `CATALOG_SOURCES` in @writ/core. */
export const CATALOG_SOURCES = ["channel3", "fixture"] as const;
export type CatalogSource = (typeof CATALOG_SOURCES)[number];

/** attacks.detector: which Sentinel layer flagged the span (deterministic rules, the LLM classifier, or both). */
export const ATTACK_DETECTORS = ["rules", "llm", "both"] as const;
export type AttackDetector = (typeof ATTACK_DETECTORS)[number];

/** auth_challenges.purpose: WebAuthn registration and discoverable sign-in (Writ and approval challenges are document hashes). */
export const CHALLENGE_PURPOSES = ["register", "login"] as const;
export type ChallengePurpose = (typeof CHALLENGE_PURPOSES)[number];

/**
 * tenant_id of rows that belong to no tenant yet: a PayPal webhook before its resource is resolved,
 * global rate counters (e.g. the daily LLM budget).
 */
export const SYSTEM_TENANT = "system";
