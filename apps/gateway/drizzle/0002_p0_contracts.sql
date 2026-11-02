CREATE TABLE "agent_run_events" (
	"tenant_id" text NOT NULL,
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_run_events_pk" PRIMARY KEY("run_id","seq"),
	CONSTRAINT "agent_run_events_seq_check" CHECK ("agent_run_events"."seq" > 0)
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"writ_id" text NOT NULL,
	"agent_kind" text NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"goal" text NOT NULL,
	"failure_code" text,
	"failure_detail" text,
	"purchase_id" text,
	"steps" integer DEFAULT 0 NOT NULL,
	"tokens" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_runs_agent_kind_check" CHECK ("agent_runs"."agent_kind" in ('atlas', 'scout')),
	CONSTRAINT "agent_runs_mode_check" CHECK ("agent_runs"."mode" in ('manual', 'hero')),
	CONSTRAINT "agent_runs_status_check" CHECK ("agent_runs"."status" in ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
	CONSTRAINT "agent_runs_counts_check" CHECK ("agent_runs"."steps" >= 0 and "agent_runs"."tokens" >= 0)
);
--> statement-breakpoint
CREATE TABLE "auth_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text,
	"purpose" text NOT NULL,
	"challenge" "bytea" NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_challenges_purpose_check" CHECK ("auth_challenges"."purpose" in ('register', 'login')),
	CONSTRAINT "auth_challenges_challenge_check" CHECK (octet_length("auth_challenges"."challenge") = 32)
);
--> statement-breakpoint
CREATE TABLE "catalog_items" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"product_ref" text NOT NULL,
	"source" text NOT NULL,
	"title" text NOT NULL,
	"merchant_id" text NOT NULL,
	"merchant_name" text,
	"category" text,
	"kind" text NOT NULL,
	"price_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"eta_days" integer,
	"url" text,
	"image_url" text,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_items_tenant_ref_unique" UNIQUE("tenant_id","product_ref"),
	CONSTRAINT "catalog_items_source_check" CHECK ("catalog_items"."source" in ('channel3', 'fixture')),
	CONSTRAINT "catalog_items_price_check" CHECK ("catalog_items"."price_minor" >= 0),
	CONSTRAINT "catalog_items_currency_check" CHECK ("catalog_items"."currency" in ('USD')),
	CONSTRAINT "catalog_items_eta_check" CHECK ("catalog_items"."eta_days" >= 0)
);
--> statement-breakpoint
CREATE TABLE "evidence_links" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"purchase_id" text NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_accessed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_links_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "evidence_links_token_hash_check" CHECK (octet_length("evidence_links"."token_hash") = 32)
);
--> statement-breakpoint
CREATE TABLE "rate_counters" (
	"tenant_id" text NOT NULL,
	"bucket" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_counters_pk" PRIMARY KEY("tenant_id","bucket","window_start"),
	CONSTRAINT "rate_counters_count_check" CHECK ("rate_counters"."count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "disputes" DROP CONSTRAINT "disputes_paypal_dispute_id_unique";--> statement-breakpoint
ALTER TABLE "paypal_vault_tokens" DROP CONSTRAINT "paypal_vault_tokens_vault_id_unique";--> statement-breakpoint
ALTER TABLE "purchases" DROP CONSTRAINT "purchases_paypal_order_id_unique";--> statement-breakpoint
ALTER TABLE "purchases" DROP CONSTRAINT "purchases_authorization_id_unique";--> statement-breakpoint
ALTER TABLE "purchases" DROP CONSTRAINT "purchases_capture_id_unique";--> statement-breakpoint
ALTER TABLE "purchases" DROP CONSTRAINT "purchases_refund_id_unique";--> statement-breakpoint
DROP INDEX "approvals_purchase_idx";--> statement-breakpoint
DROP INDEX "outbox_unpublished_idx";--> statement-breakpoint
ALTER TABLE "paypal_vault_tokens" ALTER COLUMN "vault_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "builtin_kind" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "key_hint" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "request" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "decision" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "body_hash" "bytea";--> statement-breakpoint
ALTER TABLE "attacks" ADD COLUMN "score" double precision;--> statement-breakpoint
ALTER TABLE "attacks" ADD COLUMN "detector" text;--> statement-breakpoint
ALTER TABLE "attacks" ADD COLUMN "purchase_id" text;--> statement-breakpoint
ALTER TABLE "attacks" ADD COLUMN "writ_id" text;--> statement-breakpoint
ALTER TABLE "attacks" ADD COLUMN "synthetic" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "purchase_id" text;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "output" jsonb;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "output_hash" "bytea";--> statement-breakpoint
ALTER TABLE "device_keys" ADD COLUMN "label" text DEFAULT 'Device key' NOT NULL;--> statement-breakpoint
ALTER TABLE "device_keys" ADD COLUMN "demo" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "device_keys" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "liability" text;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "confidence" double precision;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "needs_human" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "amount_minor" bigint;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "currency" text;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "paypal_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "synthetic" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "available_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "dead_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "passkeys" ADD COLUMN "aaguid" text;--> statement-breakpoint
ALTER TABLE "passkeys" ADD COLUMN "backed_up" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "passkeys" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "paypal_vault_tokens" ADD COLUMN "setup_token_id" text;--> statement-breakpoint
ALTER TABLE "paypal_vault_tokens" ADD COLUMN "payer_hint" text;--> statement-breakpoint
ALTER TABLE "paypal_vault_tokens" ADD COLUMN "demo" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "paypal_vault_tokens" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "state_reason" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "state_detail" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "final_verdict" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "vault_token_id" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "synthetic" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "demo" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "resource_type" text;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "resource_id" text;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "writ_budgets" ADD COLUMN "held_orders" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "writs" ADD COLUMN "signed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "writs" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "writs" ADD COLUMN "revoke_reason" text;--> statement-breakpoint
ALTER TABLE "writs" ADD COLUMN "synthetic" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_writ_id_writs_id_fk" FOREIGN KEY ("writ_id") REFERENCES "public"."writs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_links" ADD CONSTRAINT "evidence_links_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_tenant_created_idx" ON "agent_runs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_active_idx" ON "agent_runs" USING btree ("status") WHERE "agent_runs"."status" in ('QUEUED', 'RUNNING');--> statement-breakpoint
CREATE INDEX "auth_challenges_expires_idx" ON "auth_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "evidence_links_purchase_idx" ON "evidence_links" USING btree ("purchase_id");--> statement-breakpoint
ALTER TABLE "attacks" ADD CONSTRAINT "attacks_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attacks" ADD CONSTRAINT "attacks_writ_id_writs_id_fk" FOREIGN KEY ("writ_id") REFERENCES "public"."writs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_vault_token_id_paypal_vault_tokens_id_fk" FOREIGN KEY ("vault_token_id") REFERENCES "public"."paypal_vault_tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attacks_purchase_idx" ON "attacks" USING btree ("purchase_id");--> statement-breakpoint
CREATE INDEX "decisions_purchase_idx" ON "decisions" USING btree ("purchase_id");--> statement-breakpoint
CREATE UNIQUE INDEX "disputes_live_paypal_id_idx" ON "disputes" USING btree ("paypal_dispute_id") WHERE "disputes"."synthetic" = false;--> statement-breakpoint
CREATE INDEX "outbox_due_idx" ON "outbox" USING btree ("available_at") WHERE "outbox"."published_at" is null and "outbox"."dead_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "paypal_vault_tokens_live_vault_id_idx" ON "paypal_vault_tokens" USING btree ("vault_id") WHERE "paypal_vault_tokens"."demo" = false;--> statement-breakpoint
CREATE UNIQUE INDEX "purchases_live_order_idx" ON "purchases" USING btree ("paypal_order_id") WHERE "purchases"."synthetic" = false;--> statement-breakpoint
CREATE UNIQUE INDEX "purchases_live_authorization_idx" ON "purchases" USING btree ("authorization_id") WHERE "purchases"."synthetic" = false;--> statement-breakpoint
CREATE UNIQUE INDEX "purchases_live_capture_idx" ON "purchases" USING btree ("capture_id") WHERE "purchases"."synthetic" = false;--> statement-breakpoint
CREATE UNIQUE INDEX "purchases_live_refund_idx" ON "purchases" USING btree ("refund_id") WHERE "purchases"."synthetic" = false;--> statement-breakpoint
CREATE INDEX "webhook_events_resource_idx" ON "webhook_events" USING btree ("resource_id");--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_purchase_unique" UNIQUE("purchase_id");--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_dedupe_key_unique" UNIQUE("dedupe_key");--> statement-breakpoint
ALTER TABLE "paypal_vault_tokens" ADD CONSTRAINT "paypal_vault_tokens_setup_token_id_unique" UNIQUE("setup_token_id");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_builtin_kind_check" CHECK ("agents"."builtin_kind" in ('atlas', 'scout'));--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_builtin_kind_presence_check" CHECK (("agents"."kind" = 'builtin') = ("agents"."builtin_kind" is not null));--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_status_check" CHECK ("approvals"."status" in ('PENDING', 'APPROVED', 'DECLINED', 'EXPIRED', 'CANCELLED'));--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decision_check" CHECK ("approvals"."decision" in ('APPROVE', 'DECLINE'));--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_body_hash_check" CHECK (octet_length("approvals"."body_hash") = 32);--> statement-breakpoint
ALTER TABLE "attacks" ADD CONSTRAINT "attacks_score_check" CHECK ("attacks"."score" >= 0 and "attacks"."score" <= 1);--> statement-breakpoint
ALTER TABLE "attacks" ADD CONSTRAINT "attacks_detector_check" CHECK ("attacks"."detector" in ('rules', 'llm', 'both'));--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_stage_check" CHECK ("decisions"."stage" in ('preview', 'schema', 'policy', 'threshold', 'reserve', 'authorize', 'sentinel', 'verifier', 'combiner', 'human'));--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_output_hash_check" CHECK (octet_length("decisions"."output_hash") = 32);--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_amount_check" CHECK ("disputes"."amount_minor" >= 0);--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_currency_check" CHECK ("disputes"."currency" in ('USD'));--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_confidence_check" CHECK ("disputes"."confidence" >= 0 and "disputes"."confidence" <= 1);--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_attempts_check" CHECK ("outbox"."attempts" >= 0);--> statement-breakpoint
ALTER TABLE "paypal_vault_tokens" ADD CONSTRAINT "paypal_vault_tokens_status_check" CHECK ("paypal_vault_tokens"."status" in ('PENDING', 'ACTIVE', 'REVOKED', 'FAILED'));--> statement-breakpoint
ALTER TABLE "paypal_vault_tokens" ADD CONSTRAINT "paypal_vault_tokens_active_vault_check" CHECK ("paypal_vault_tokens"."status" <> 'ACTIVE' or "paypal_vault_tokens"."vault_id" is not null);--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_state_reason_check" CHECK ("purchases"."state_reason" in ('policy_blocked', 'budget_exhausted', 'checkout_interrupted', 'paypal_unconfigured', 'paypal_not_connected', 'paypal_error', 'payer_action_required', 'authorization_declined', 'verifier_blocked', 'human_declined', 'approval_expired', 'kill_switch', 'writ_revoked', 'writ_expired', 'settle_refused', 'capture_failed', 'verification_interrupted', 'platform_liability', 'dispute_opened', 'dispute_won', 'dispute_lost'));--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_final_verdict_check" CHECK ("purchases"."final_verdict" in ('APPROVE', 'REVIEW', 'BLOCK'));--> statement-breakpoint
ALTER TABLE "writ_budgets" ADD CONSTRAINT "writ_budgets_held_orders_check" CHECK ("writ_budgets"."held_orders" >= 0);--> statement-breakpoint
ALTER TABLE "writ_budgets" ADD CONSTRAINT "writ_budgets_orders_within_max_check" CHECK ("writ_budgets"."orders_count" + "writ_budgets"."held_orders" <= "writ_budgets"."max_orders");