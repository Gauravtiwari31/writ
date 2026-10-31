// Postgres data model (plan §6.5). Every table carries tenant_id (judge-mode isolation) and
// created_at. Primary keys are app-generated prefixed ids (see ids.ts) except ledger_events.seq
// and webhook_events.paypal_event_id. Money is bigint minor units, never numeric/float.
import type { Currency, JsonValue } from "@writ/core";
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { bytea, literalList } from "./columns";
import { AGENT_KINDS, CURRENCIES, PURCHASE_STATES, VERDICTS, type AgentKind, type PurchaseState, type Verdict } from "./enums";

const tenantId = () => text("tenant_id").notNull();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    displayName: text("display_name").notNull(),
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
    vaultId: text("vault_id").notNull().unique("paypal_vault_tokens_vault_id_unique"),
    paypalCustomerId: text("paypal_customer_id"),
    status: text("status").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("paypal_vault_tokens_user_idx").on(t.userId)],
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
    // sha256 of the API key; the key itself is shown once and never stored.
    apiKeyHash: bytea("api_key_hash").notNull().unique("agents_api_key_hash_unique"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("agents_user_idx").on(t.userId),
    check("agents_kind_check", sql`${t.kind} in (${literalList(AGENT_KINDS)})`),
    check("agents_api_key_hash_check", sql`octet_length(${t.apiKeyHash}) = 32`),
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
    status: text("status").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("writs_user_idx").on(t.userId),
    index("writs_agent_idx").on(t.agentId),
    index("writs_tenant_created_idx").on(t.tenantId, t.createdAt),
    check("writs_body_hash_check", sql`octet_length(${t.bodyHash}) = 32`),
  ],
);

// The CHECKs restate the reservation guards (plan §6.8) so that even a buggy or hand-written
// UPDATE cannot push a Writ past its limit: the database refuses, not just the application.
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

export const decisions = pgTable(
  "decisions",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    cartId: text("cart_id")
      .notNull()
      .references(() => carts.id),
    stage: text("stage").notNull(),
    verdict: text("verdict").$type<Verdict>().notNull(),
    reasons: jsonb("reasons").$type<JsonValue>().notNull().default(sql`'[]'::jsonb`),
    model: text("model"),
    latencyMs: integer("latency_ms"),
    tokens: integer("tokens"),
    createdAt: createdAt(),
  },
  (t) => [
    index("decisions_cart_idx").on(t.cartId),
    check("decisions_verdict_check", sql`${t.verdict} in (${literalList(VERDICTS)})`),
    check("decisions_latency_check", sql`${t.latencyMs} >= 0`),
    check("decisions_tokens_check", sql`${t.tokens} >= 0`),
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
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").$type<Currency>().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    // PayPal ids are unique on PayPal's side; enforcing it here stops one webhook resolving to two purchases.
    paypalOrderId: text("paypal_order_id").unique("purchases_paypal_order_id_unique"),
    authorizationId: text("authorization_id").unique("purchases_authorization_id_unique"),
    captureId: text("capture_id").unique("purchases_capture_id_unique"),
    refundId: text("refund_id").unique("purchases_refund_id_unique"),
    cPre: bytea("c_pre"),
    cPost: bytea("c_post"),
    createdAt: createdAt(),
    // Lets the recovery job find sagas stuck in AUTHORIZING/CAPTURING/VOIDING for longer than N seconds.
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Threat T7: a replayed Idempotency-Key from the same agent can never create a second purchase.
    unique("purchases_agent_idempotency_unique").on(t.agentId, t.idempotencyKey),
    index("purchases_writ_idx").on(t.writId),
    index("purchases_cart_idx").on(t.cartId),
    index("purchases_state_updated_idx").on(t.state, t.updatedAt),
    index("purchases_tenant_created_idx").on(t.tenantId, t.createdAt),
    check("purchases_state_check", sql`${t.state} in (${literalList(PURCHASE_STATES)})`),
    check("purchases_amount_check", sql`${t.amountMinor} > 0`),
    check("purchases_currency_check", sql`${t.currency} in (${literalList(CURRENCIES)})`),
    check("purchases_idempotency_key_check", sql`char_length(${t.idempotencyKey}) between 1 and 255`),
    check("purchases_c_pre_check", sql`octet_length(${t.cPre}) = 32`),
    check("purchases_c_post_check", sql`octet_length(${t.cPost}) = 32`),
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
    status: text("status").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    assertion: jsonb("assertion").$type<JsonValue>(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("approvals_purchase_idx").on(t.purchaseId),
    index("approvals_status_expires_idx").on(t.status, t.expiresAt),
  ],
);

// Hash chain per Writ. unique(writ_id, prev_hash) means two events can never claim the same
// predecessor, so a concurrent writer that loses the race gets a constraint error instead of
// silently forking the chain. The genesis event uses ZERO_HASH as prev_hash.
export const ledgerEvents = pgTable(
  "ledger_events",
  {
    seq: bigserial("seq", { mode: "bigint" }).primaryKey(),
    tenantId: tenantId(),
    purchaseId: text("purchase_id").references(() => purchases.id),
    writId: text("writ_id")
      .notNull()
      .references(() => writs.id),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<JsonValue>().notNull(),
    prevHash: bytea("prev_hash").notNull(),
    hash: bytea("hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("ledger_events_writ_prev_hash_unique").on(t.writId, t.prevHash),
    unique("ledger_events_hash_unique").on(t.hash),
    index("ledger_events_purchase_idx").on(t.purchaseId),
    check("ledger_events_prev_hash_check", sql`octet_length(${t.prevHash}) = 32`),
    check("ledger_events_hash_check", sql`octet_length(${t.hash}) = 32`),
  ],
);

export const disputes = pgTable(
  "disputes",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    paypalDisputeId: text("paypal_dispute_id").notNull().unique("disputes_paypal_dispute_id_unique"),
    purchaseId: text("purchase_id").references(() => purchases.id),
    reason: text("reason"),
    status: text("status").notNull(),
    stage: text("stage"),
    analysis: jsonb("analysis").$type<JsonValue>(),
    action: text("action"),
    outcome: text("outcome"),
    createdAt: createdAt(),
  },
  (t) => [
    index("disputes_purchase_idx").on(t.purchaseId),
    index("disputes_tenant_created_idx").on(t.tenantId, t.createdAt),
  ],
);

// The PayPal event id is the primary key, so a redelivered webhook is a no-op insert (plan §6.8).
export const webhookEvents = pgTable(
  "webhook_events",
  {
    paypalEventId: text("paypal_event_id").primaryKey(),
    tenantId: tenantId(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<JsonValue>().notNull(),
    verified: boolean("verified").notNull().default(false),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("webhook_events_unprocessed_idx").on(t.createdAt).where(sql`${t.processedAt} is null`)],
);

export const attacks = pgTable(
  "attacks",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    sourceUrl: text("source_url").notNull(),
    category: text("category").notNull(),
    spans: jsonb("spans").$type<JsonValue>().notNull().default(sql`'[]'::jsonb`),
    cartId: text("cart_id").references(() => carts.id),
    agentId: text("agent_id").references(() => agents.id),
    createdAt: createdAt(),
  },
  (t) => [index("attacks_tenant_created_idx").on(t.tenantId, t.createdAt)],
);

export const outbox = pgTable(
  "outbox",
  {
    id: text("id").primaryKey(),
    tenantId: tenantId(),
    topic: text("topic").notNull(),
    payload: jsonb("payload").$type<JsonValue>().notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("outbox_unpublished_idx").on(t.createdAt).where(sql`${t.publishedAt} is null`)],
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
