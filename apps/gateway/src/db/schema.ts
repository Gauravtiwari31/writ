// Postgres data model (plan §6.5). Every table carries tenant_id (judge-mode isolation) and
// created_at. Primary keys are app-generated @writ/core ids (see ids.ts) except ledger_events.seq,
// webhook_events.paypal_event_id, agent_run_events (run_id, seq) and rate_counters (tenant_id,
// bucket, window_start). Money is bigint minor units, never numeric/float.
//
// FROZEN for the parallel build (docs/ARCHITECTURE.md): no stream changes this file; a needed
// column is a request to the architect, who adds a migration.
import type { Currency, JsonValue } from "@writ/core";
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { bytea, literalList } from "./columns";
import {
  AGENT_KINDS,
  APPROVAL_DECISIONS,
  APPROVAL_STATUSES,
  ATTACK_DETECTORS,
  BUILTIN_AGENT_KINDS,
  CATALOG_SOURCES,
  CHALLENGE_PURPOSES,
  CURRENCIES,
  DECISION_RECORD_STAGES,
  PURCHASE_STATE_REASONS,
  PURCHASE_STATES,
  RUN_MODES,
  RUN_STATUSES,
  VAULT_TOKEN_STATUSES,
  VERDICTS,
  WRIT_STATUSES,
  type AgentKind,
  type ApprovalDecision,
  type ApprovalStatus,
  type AttackDetector,
  type BuiltinAgentKind,
  type CatalogSource,
  type ChallengePurpose,
  type DecisionRecordStage,
  type PurchaseState,
  type RunMode,
  type RunStatus,
  type VaultTokenStatus,
  type Verdict,
  type WritStatus,
} from "./enums";

const tenantId = () => text("tenant_id").notNull();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });
/** Seeded console history (plan §11): rows carry is_synthetic and the UI shows a "synthetic history" badge. */
const synthetic = () => boolean("synthetic").notNull().default(false);

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    displayName: text("display_name").notNull(),
    /** The seeded judge-mode "Ana" (plan §18); the Wallet labels demo accounts. */
    demo: boolean("demo").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("users_tenant_idx").on(t.tenantId)],
);

export const passkeys = pgTable(
  "passkeys",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    // base64url credential id, as @simplewebauthn reports it.
    credentialId: text("credential_id").notNull().unique("passkeys_credential_id_unique"),
    publicKeyCose: bytea("public_key_cose").notNull(),
    // WebAuthn signCount is a uint32, so it fits a JS number exactly.
    counter: bigint("counter", { mode: "number" }).notNull().default(0),
    transports: text("transports").array().notNull().default(sql`'{}'::text[]`),
    aaguid: text("aaguid"),
    backedUp: boolean("backed_up").notNull().default(false),
    lastUsedAt: ts("last_used_at"),
    createdAt: createdAt(),
  },
  (t) => [index("passkeys_user_idx").on(t.userId), check("passkeys_counter_check", sql`${t.counter} >= 0`)],
);

export const deviceKeys = pgTable(
  "device_keys",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    publicKeyEd25519: bytea("public_key_ed25519").notNull(),
    label: text("label").notNull().default("Device key"),
    /** The clearly labeled judge-mode demo key that pre-signs the seeded Writ (plan §18). */
    demo: boolean("demo").notNull().default(false),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("device_keys_user_idx").on(t.userId),
    check("device_keys_public_key_check", sql`octet_length(${t.publicKeyEd25519}) = 32`),
  ],
);

export const paypalVaultTokens = pgTable(
  "paypal_vault_tokens",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    // Null while PENDING (setup token created, buyer not yet approved). Unique for real tokens only:
    // every judge tenant holds the same labeled demo token (plan §18).
    vaultId: text("vault_id"),
    setupTokenId: text("setup_token_id").unique("paypal_vault_tokens_setup_token_id_unique"),
    paypalCustomerId: text("paypal_customer_id"),
    status: text("status").$type<VaultTokenStatus>().notNull(),
    /** Masked payer email for display ("a***@example.com"); never the full address. */
    payerHint: text("payer_hint"),
    /** Judge-mode pre-vaulted sandbox token (DEMO_PAYPAL_VAULT_ID), labeled in the UI. */
    demo: boolean("demo").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("paypal_vault_tokens_user_idx").on(t.userId),
    uniqueIndex("paypal_vault_tokens_live_vault_id_idx").on(t.vaultId).where(sql`${t.demo} = false`),
    check("paypal_vault_tokens_status_check", sql`${t.status} in (${literalList(VAULT_TOKEN_STATUSES)})`),
    check("paypal_vault_tokens_active_vault_check", sql`${t.status} <> 'ACTIVE' or ${t.vaultId} is not null`),
  ],
);

// Agents only ever see id + label (threat T2/T6); the raw address never leaves the gateway.
export const addressBook = pgTable(
  "address_book",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    label: text("label").notNull(),
    line1: text("line1").notNull(),
    city: text("city").notNull(),
    region: text("region"),
    postal: text("postal").notNull(),
    country: text("country").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("address_book_user_label_unique").on(t.userId, t.label),
    check("address_book_country_check", sql`${t.country} ~ '^[A-Z]{2}$'`),
  ],
);

export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    kind: text("kind").$type<AgentKind>().notNull(),
    /** atlas | scout for kind = 'builtin', else null. */
    builtinKind: text("builtin_kind").$type<BuiltinAgentKind>(),
    // sha256 of the API key; the key itself is shown once and never stored. Built-in agents get a
    // fresh key at the start of each run (the runner holds it in memory only).
    apiKeyHash: bytea("api_key_hash").notNull().unique("agents_api_key_hash_unique"),
    /** Last 4 characters of the current key, for recognition in the Wallet. */
    keyHint: text("key_hint").notNull().default(""),
    lastUsedAt: ts("last_used_at"),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("agents_user_idx").on(t.userId),
    check("agents_kind_check", sql`${t.kind} in (${literalList(AGENT_KINDS)})`),
    check("agents_api_key_hash_check", sql`octet_length(${t.apiKeyHash}) = 32`),
    check("agents_builtin_kind_check", sql`${t.builtinKind} in (${literalList(BUILTIN_AGENT_KINDS)})`),
    check("agents_builtin_kind_presence_check", sql`(${t.kind} = 'builtin') = (${t.builtinKind} is not null)`),
  ],
);

export const writs = pgTable(
  "writs",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    // Null until an agent is bound; the pipeline requires a match (plan §6.2 step 2).
    agentId: text("agent_id").references(() => agents.id),
    body: jsonb("body").$type<JsonValue>().notNull(),
    bodyHash: bytea("body_hash").notNull(),
    signature: jsonb("signature").$type<JsonValue>(),
    status: text("status").$type<WritStatus>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    signedAt: ts("signed_at"),
    revokedAt: ts("revoked_at"),
    revokeReason: text("revoke_reason"),
    synthetic: synthetic(),
    createdAt: createdAt(),
  },
  (t) => [
    index("writs_user_idx").on(t.userId),
    index("writs_agent_idx").on(t.agentId),
    index("writs_tenant_created_idx").on(t.tenantId, t.createdAt),
    check("writs_body_hash_check", sql`octet_length(${t.bodyHash}) = 32`),
    check("writs_status_check", sql`${t.status} in (${literalList(WRIT_STATUSES)})`),
  ],
);

// The CHECKs restate the reservation guards (plan §6.8) so that even a buggy or hand-written
// UPDATE cannot push a Writ past its limit: the database refuses, not just the application.
// held_orders counts orders holding a reservation (in flight); orders_count counts settled ones.
export const writBudgets = pgTable(
  "writ_budgets",
  {
    writId: text("writ_id")
      .primaryKey()
      .references(() => writs.id),
    tenantId: tenantId(),
    limitMinor: bigint("limit_minor", { mode: "bigint" }).notNull(),
    maxPerOrderMinor: bigint("max_per_order_minor", { mode: "bigint" }).notNull(),
    reservedMinor: bigint("reserved_minor", { mode: "bigint" }).notNull().default(sql`0`),
    spentMinor: bigint("spent_minor", { mode: "bigint" }).notNull().default(sql`0`),
    ordersCount: integer("orders_count").notNull().default(0),
    heldOrders: integer("held_orders").notNull().default(0),
    maxOrders: integer("max_orders").notNull(),
    version: integer("version").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    check("writ_budgets_limit_check", sql`${t.limitMinor} > 0`),
    check("writ_budgets_max_per_order_check", sql`${t.maxPerOrderMinor} > 0`),
    check("writ_budgets_reserved_check", sql`${t.reservedMinor} >= 0`),
    check("writ_budgets_spent_check", sql`${t.spentMinor} >= 0`),
    check("writ_budgets_within_limit_check", sql`${t.spentMinor} + ${t.reservedMinor} <= ${t.limitMinor}`),
    check("writ_budgets_max_orders_check", sql`${t.maxOrders} > 0`),
    check("writ_budgets_orders_count_check", sql`${t.ordersCount} >= 0 and ${t.ordersCount} <= ${t.maxOrders}`),
    check("writ_budgets_held_orders_check", sql`${t.heldOrders} >= 0`),
    check("writ_budgets_orders_within_max_check", sql`${t.ordersCount} + ${t.heldOrders} <= ${t.maxOrders}`),
  ],
);

export const carts = pgTable(
  "carts",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    writId: text("writ_id")
      .notNull()
      .references(() => writs.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    body: jsonb("body").$type<JsonValue>().notNull(),
    bodyHash: bytea("body_hash").notNull(),
    // Tainted inputs that influenced the cart (pages, titles); the Sentinel scans exactly these.
    sources: jsonb("sources").$type<JsonValue>().notNull().default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    index("carts_writ_idx").on(t.writId),
    check("carts_body_hash_check", sql`octet_length(${t.bodyHash}) = 32`),
  ],
);

export const purchases = pgTable(
  "purchases",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    writId: text("writ_id")
      .notNull()
      .references(() => writs.id),
    cartId: text("cart_id")
      .notNull()
      .references(() => carts.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    state: text("state").$type<PurchaseState>().notNull(),
    /** Why the purchase is in its state: a PURCHASE_STATE_REASONS code from @writ/core. */
    stateReason: text("state_reason"),
    /** Human-readable detail for the reason (never secrets, never untrusted page text). */
    stateDetail: text("state_detail"),
    finalVerdict: text("final_verdict").$type<Verdict>(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").$type<Currency>().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    /** The vaulted wallet the authorization was made against. */
    vaultTokenId: text("vault_token_id").references(() => paypalVaultTokens.id),
    // PayPal ids are unique on PayPal's side; the partial unique indexes below stop one webhook resolving
    // to two live purchases. Seeded judge history (synthetic) repeats ids across tenants and is never acted on.
    paypalOrderId: text("paypal_order_id"),
    authorizationId: text("authorization_id"),
    captureId: text("capture_id"),
    refundId: text("refund_id"),
    cPre: bytea("c_pre"),
    cPost: bytea("c_post"),
    synthetic: synthetic(),
    createdAt: createdAt(),
    // Lets the recovery job find sagas stuck in AUTHORIZING/CAPTURING/VOIDING for longer than N seconds.
    updatedAt: updatedAt(),
  },
  (t) => [
    // Threat T7: a replayed Idempotency-Key from the same agent can never create a second purchase.
    unique("purchases_agent_idempotency_unique").on(t.agentId, t.idempotencyKey),
    uniqueIndex("purchases_live_order_idx").on(t.paypalOrderId).where(sql`${t.synthetic} = false`),
    uniqueIndex("purchases_live_authorization_idx").on(t.authorizationId).where(sql`${t.synthetic} = false`),
    uniqueIndex("purchases_live_capture_idx").on(t.captureId).where(sql`${t.synthetic} = false`),
    uniqueIndex("purchases_live_refund_idx").on(t.refundId).where(sql`${t.synthetic} = false`),
    index("purchases_writ_idx").on(t.writId),
    index("purchases_cart_idx").on(t.cartId),
    index("purchases_state_updated_idx").on(t.state, t.updatedAt),
    index("purchases_tenant_created_idx").on(t.tenantId, t.createdAt),
    check("purchases_state_check", sql`${t.state} in (${literalList(PURCHASE_STATES)})`),
    check("purchases_state_reason_check", sql`${t.stateReason} in (${literalList(PURCHASE_STATE_REASONS)})`),
    check("purchases_final_verdict_check", sql`${t.finalVerdict} in (${literalList(VERDICTS)})`),
    check("purchases_amount_check", sql`${t.amountMinor} > 0`),
    check("purchases_currency_check", sql`${t.currency} in (${literalList(CURRENCIES)})`),
    check("purchases_idempotency_key_check", sql`char_length(${t.idempotencyKey}) between 1 and 255`),
    check("purchases_c_pre_check", sql`octet_length(${t.cPre}) = 32`),
    check("purchases_c_post_check", sql`octet_length(${t.cPost}) = 32`),
  ],
);

export const decisions = pgTable(
  "decisions",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    cartId: text("cart_id")
      .notNull()
      .references(() => carts.id),
    /** Null for a cart-propose preview; set for every checkout stage. */
    purchaseId: text("purchase_id").references(() => purchases.id),
    stage: text("stage").$type<DecisionRecordStage>().notNull(),
    verdict: text("verdict").$type<Verdict>().notNull(),
    reasons: jsonb("reasons").$type<JsonValue>().notNull().default(sql`'[]'::jsonb`),
    /**
     * The stage's full typed output exactly as hashed: the PolicyDecision (H_p) for "policy", the
     * VerificationRecord (H_verifier) for "combiner", raw role outputs for the LLM stages.
     */
    output: jsonb("output").$type<JsonValue>(),
    outputHash: bytea("output_hash"),
    model: text("model"),
    latencyMs: integer("latency_ms"),
    tokens: integer("tokens"),
    createdAt: createdAt(),
  },
  (t) => [
    index("decisions_cart_idx").on(t.cartId),
    index("decisions_purchase_idx").on(t.purchaseId),
    check("decisions_stage_check", sql`${t.stage} in (${literalList(DECISION_RECORD_STAGES)})`),
    check("decisions_verdict_check", sql`${t.verdict} in (${literalList(VERDICTS)})`),
    check("decisions_output_hash_check", sql`octet_length(${t.outputHash}) = 32`),
    check("decisions_latency_check", sql`${t.latencyMs} >= 0`),
    check("decisions_tokens_check", sql`${t.tokens} >= 0`),
  ],
);

export const approvals = pgTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    purchaseId: text("purchase_id")
      .notNull()
      .references(() => purchases.id),
    status: text("status").$type<ApprovalStatus>().notNull(),
    /** The ApprovalRequest (@writ/core) shown to the human; the signed body is request + decision. */
    request: jsonb("request").$type<JsonValue>().notNull(),
    decision: text("decision").$type<ApprovalDecision>(),
    /** sha256(JCS(ApprovalBody)) that the assertion signed. */
    bodyHash: bytea("body_hash"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    assertion: jsonb("assertion").$type<JsonValue>(),
    decidedAt: ts("decided_at"),
    createdAt: createdAt(),
  },
  (t) => [
    // One human review per purchase (a purchase enters AWAITING_HUMAN at most once).
    unique("approvals_purchase_unique").on(t.purchaseId),
    index("approvals_status_expires_idx").on(t.status, t.expiresAt),
    check("approvals_status_check", sql`${t.status} in (${literalList(APPROVAL_STATUSES)})`),
    check("approvals_decision_check", sql`${t.decision} in (${literalList(APPROVAL_DECISIONS)})`),
    check("approvals_body_hash_check", sql`octet_length(${t.bodyHash}) = 32`),
  ],
);

// Hash chain per Writ. unique(writ_id, prev_hash) means two events can never claim the same
// predecessor, so a concurrent writer that loses the race gets a constraint error instead of
// silently forking the chain. The genesis event uses ZERO_HASH as prev_hash.
export const ledgerEvents = pgTable(
  "ledger_events",
  {
    // A JS number, like @writ/ledger's LedgerEvent.seq; a sequence will not reach 2^53.
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    tenantId: tenantId(),
    purchaseId: text("purchase_id").references(() => purchases.id),
    writId: text("writ_id")
      .notNull()
      .references(() => writs.id),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<JsonValue>().notNull(),
    prevHash: bytea("prev_hash").notNull(),
    hash: bytea("hash").notNull(),
    // The exact timestamp string inside the hash preimage (Date#toISOString form). Stored as text,
    // not derived from created_at, so re-verifying a chain from the DB never depends on how a driver
    // or column precision round-trips time.
    ts: text("ts").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("ledger_events_writ_prev_hash_unique").on(t.writId, t.prevHash),
    unique("ledger_events_hash_unique").on(t.hash),
    // Loading a chain (or its tail) in order.
    index("ledger_events_writ_seq_idx").on(t.writId, t.seq),
    index("ledger_events_purchase_idx").on(t.purchaseId),
    check("ledger_events_prev_hash_check", sql`octet_length(${t.prevHash}) = 32`),
    check("ledger_events_hash_check", sql`octet_length(${t.hash}) = 32`),
    check(
      "ledger_events_ts_check",
      sql`${t.ts} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'`,
    ),
  ],
);

export const disputes = pgTable(
  "disputes",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    // Unique for real disputes only: seeded judge history repeats ids across tenants (plan §18).
    paypalDisputeId: text("paypal_dispute_id").notNull(),
    purchaseId: text("purchase_id").references(() => purchases.id),
    reason: text("reason"),
    status: text("status").notNull(),
    stage: text("stage"),
    /** The Dispute Analyst output (DisputeAnalysis) that the action was based on. */
    analysis: jsonb("analysis").$type<JsonValue>(),
    action: text("action"),
    liability: text("liability"),
    confidence: doublePrecision("confidence"),
    /** True while the recommended action waits for a human click (anything not auto-executed). */
    needsHuman: boolean("needs_human").notNull().default(false),
    outcome: text("outcome"),
    amountMinor: bigint("amount_minor", { mode: "bigint" }),
    currency: text("currency").$type<Currency>(),
    /** The last GET /v1/customer/disputes/{id} answer, as re-fetched before acting (§22 rule 15). */
    paypalSnapshot: jsonb("paypal_snapshot").$type<JsonValue>(),
    resolvedAt: ts("resolved_at"),
    synthetic: synthetic(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("disputes_live_paypal_id_idx").on(t.paypalDisputeId).where(sql`${t.synthetic} = false`),
    index("disputes_purchase_idx").on(t.purchaseId),
    index("disputes_tenant_created_idx").on(t.tenantId, t.createdAt),
    check("disputes_amount_check", sql`${t.amountMinor} >= 0`),
    check("disputes_currency_check", sql`${t.currency} in (${literalList(CURRENCIES)})`),
    check("disputes_confidence_check", sql`${t.confidence} >= 0 and ${t.confidence} <= 1`),
  ],
);

// The PayPal event id is the primary key, so a redelivered webhook is a no-op insert (plan §6.8).
// tenant_id is SYSTEM_TENANT until the handler resolves the resource to a purchase.
export const webhookEvents = pgTable(
  "webhook_events",
  {
    paypalEventId: text("paypal_event_id").primaryKey(),
    tenantId: tenantId(),
    type: text("type").notNull(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    payload: jsonb("payload").$type<JsonValue>().notNull(),
    verified: boolean("verified").notNull().default(false),
    processedAt: ts("processed_at"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [
    index("webhook_events_unprocessed_idx").on(t.createdAt).where(sql`${t.processedAt} is null`),
    index("webhook_events_resource_idx").on(t.resourceId),
  ],
);

export const attacks = pgTable(
  "attacks",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    sourceUrl: text("source_url").notNull(),
    category: text("category").notNull(),
    spans: jsonb("spans").$type<JsonValue>().notNull().default(sql`'[]'::jsonb`),
    score: doublePrecision("score"),
    detector: text("detector").$type<AttackDetector>(),
    cartId: text("cart_id").references(() => carts.id),
    purchaseId: text("purchase_id").references(() => purchases.id),
    writId: text("writ_id").references(() => writs.id),
    agentId: text("agent_id").references(() => agents.id),
    synthetic: synthetic(),
    createdAt: createdAt(),
  },
  (t) => [
    index("attacks_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("attacks_purchase_idx").on(t.purchaseId),
    check("attacks_score_check", sql`${t.score} >= 0 and ${t.score} <= 1`),
    check("attacks_detector_check", sql`${t.detector} in (${literalList(ATTACK_DETECTORS)})`),
  ],
);

// Transactional outbox and durable job queue (plan §6.1, §6.8, §22 rule 14). A row is written in
// the same transaction as the state change it follows from; the in-process poller claims due rows
// with FOR UPDATE SKIP LOCKED (lease = locked_until), runs the idempotent handler for `topic`, and
// sets published_at when done. Failures back off via available_at; dead_at marks a given-up job.
export const outbox = pgTable(
  "outbox",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    topic: text("topic").notNull(),
    payload: jsonb("payload").$type<JsonValue>().notNull(),
    /** Enqueue-once key (e.g. "purchase.capture:pur_..."); null = no dedupe. */
    dedupeKey: text("dedupe_key").unique("outbox_dedupe_key_unique"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: ts("locked_until"),
    lastError: text("last_error"),
    publishedAt: ts("published_at"),
    deadAt: ts("dead_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("outbox_due_idx").on(t.availableAt).where(sql`${t.publishedAt} is null and ${t.deadAt} is null`),
    check("outbox_attempts_check", sql`${t.attempts} >= 0`),
  ],
);

// Single-use WebAuthn challenges for passkey registration and discoverable sign-in. (Writ and
// approval signatures use the document hash as the challenge instead; see plan §6.6.)
export const authChallenges = pgTable(
  "auth_challenges",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    /** The (pending, for registration) user; null for a discoverable sign-in. No FK: the user may not exist yet. */
    userId: text("user_id"),
    purpose: text("purpose").$type<ChallengePurpose>().notNull(),
    challenge: bytea("challenge").notNull(),
    /** Registration context (display name, pending tenant) for the verify step. */
    context: jsonb("context").$type<JsonValue>().notNull().default(sql`'{}'::jsonb`),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: ts("consumed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("auth_challenges_expires_idx").on(t.expiresAt),
    check("auth_challenges_purpose_check", sql`${t.purpose} in (${literalList(CHALLENGE_PURPOSES)})`),
    check("auth_challenges_challenge_check", sql`octet_length(${t.challenge}) = 32`),
  ],
);

// Built-in agent runs (Atlas/Scout) started from the Wallet or judge mode. They execute in the
// gateway process but reach the gateway only through the public agent API (plan decision 6).
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    writId: text("writ_id")
      .notNull()
      .references(() => writs.id),
    agentKind: text("agent_kind").$type<BuiltinAgentKind>().notNull(),
    mode: text("mode").$type<RunMode>().notNull(),
    status: text("status").$type<RunStatus>().notNull(),
    goal: text("goal").notNull(),
    failureCode: text("failure_code"),
    failureDetail: text("failure_detail"),
    purchaseId: text("purchase_id").references(() => purchases.id),
    steps: integer("steps").notNull().default(0),
    tokens: integer("tokens").notNull().default(0),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("agent_runs_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("agent_runs_active_idx").on(t.status).where(sql`${t.status} in ('QUEUED', 'RUNNING')`),
    check("agent_runs_agent_kind_check", sql`${t.agentKind} in (${literalList(BUILTIN_AGENT_KINDS)})`),
    check("agent_runs_mode_check", sql`${t.mode} in (${literalList(RUN_MODES)})`),
    check("agent_runs_status_check", sql`${t.status} in (${literalList(RUN_STATUSES)})`),
    check("agent_runs_counts_check", sql`${t.steps} >= 0 and ${t.tokens} >= 0`),
  ],
);

/** One timeline row per run step (RunEvent in @writ/core/api); seq is 1-based and gap-free per run. */
export const agentRunEvents = pgTable(
  "agent_run_events",
  {
    tenantId: tenantId(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<JsonValue>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ name: "agent_run_events_pk", columns: [t.runId, t.seq] }), check("agent_run_events_seq_check", sql`${t.seq} > 0`)],
);

// Capability links to an evidence pack (GET /v1/evidence/<token>.json|.pdf). The token is random;
// only its sha256 is stored, so a database leak does not leak working links.
export const evidenceLinks = pgTable(
  "evidence_links",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    purchaseId: text("purchase_id")
      .notNull()
      .references(() => purchases.id),
    tokenHash: bytea("token_hash").notNull().unique("evidence_links_token_hash_unique"),
    expiresAt: ts("expires_at"),
    revokedAt: ts("revoked_at"),
    lastAccessedAt: ts("last_accessed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("evidence_links_purchase_idx").on(t.purchaseId),
    check("evidence_links_token_hash_check", sql`octet_length(${t.tokenHash}) = 32`),
  ],
);

// Products an agent can cart, resolved by the gateway (CatalogItem in @writ/core): Channel3 search
// results cached per tenant, and the security test fixture catalog. Carts are built from these
// rows, never from agent-declared prices or categories.
export const catalogItems = pgTable(
  "catalog_items",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    productRef: text("product_ref").notNull(),
    source: text("source").$type<CatalogSource>().notNull(),
    title: text("title").notNull(),
    merchantId: text("merchant_id").notNull(),
    merchantName: text("merchant_name"),
    category: text("category"),
    kind: text("kind").notNull(),
    priceMinor: bigint("price_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").$type<Currency>().notNull(),
    etaDays: integer("eta_days"),
    url: text("url"),
    imageUrl: text("image_url"),
    /** The provider's response snapshot for this product (Channel3 JSON); kept for re-checks. */
    raw: jsonb("raw").$type<JsonValue>().notNull().default(sql`'{}'::jsonb`),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("catalog_items_tenant_ref_unique").on(t.tenantId, t.productRef),
    check("catalog_items_source_check", sql`${t.source} in (${literalList(CATALOG_SOURCES)})`),
    check("catalog_items_price_check", sql`${t.priceMinor} >= 0`),
    check("catalog_items_currency_check", sql`${t.currency} in (${literalList(CURRENCIES)})`),
    check("catalog_items_eta_check", sql`${t.etaDays} >= 0`),
  ],
);

// Fixed-window counters for judge-mode limits: hero runs per tenant per hour, the global daily LLM
// budget (tenant_id = SYSTEM_TENANT). One atomic upsert per increment.
export const rateCounters = pgTable(
  "rate_counters",
  {
    tenantId: tenantId(),
    bucket: text("bucket").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: "rate_counters_pk", columns: [t.tenantId, t.bucket, t.windowStart] }),
    check("rate_counters_count_check", sql`${t.count} >= 0`),
  ],
);

export type User = typeof users.$inferSelect;
export type Passkey = typeof passkeys.$inferSelect;
export type DeviceKey = typeof deviceKeys.$inferSelect;
export type PaypalVaultToken = typeof paypalVaultTokens.$inferSelect;
export type Address = typeof addressBook.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type Writ = typeof writs.$inferSelect;
export type WritBudget = typeof writBudgets.$inferSelect;
export type NewWritBudget = typeof writBudgets.$inferInsert;
export type Cart = typeof carts.$inferSelect;
export type Decision = typeof decisions.$inferSelect;
export type Purchase = typeof purchases.$inferSelect;
export type NewPurchase = typeof purchases.$inferInsert;
export type Approval = typeof approvals.$inferSelect;
export type LedgerEvent = typeof ledgerEvents.$inferSelect;
export type NewLedgerEvent = typeof ledgerEvents.$inferInsert;
export type Dispute = typeof disputes.$inferSelect;
export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type Attack = typeof attacks.$inferSelect;
export type OutboxRow = typeof outbox.$inferSelect;
export type AuthChallenge = typeof authChallenges.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;
export type AgentRunEvent = typeof agentRunEvents.$inferSelect;
export type EvidenceLink = typeof evidenceLinks.$inferSelect;
export type CatalogItemRow = typeof catalogItems.$inferSelect;
export type RateCounter = typeof rateCounters.$inferSelect;
