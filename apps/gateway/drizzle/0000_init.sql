CREATE TABLE "address_book" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"line1" text NOT NULL,
	"city" text NOT NULL,
	"region" text,
	"postal" text NOT NULL,
	"country" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "address_book_user_label_unique" UNIQUE("user_id","label"),
	CONSTRAINT "address_book_country_check" CHECK ("address_book"."country" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"api_key_hash" "bytea" NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_api_key_hash_unique" UNIQUE("api_key_hash"),
	CONSTRAINT "agents_kind_check" CHECK ("agents"."kind" in ('builtin', 'mcp', 'sdk')),
	CONSTRAINT "agents_api_key_hash_check" CHECK (octet_length("agents"."api_key_hash") = 32)
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"purchase_id" text NOT NULL,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"assertion" jsonb,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attacks" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"source_url" text NOT NULL,
	"category" text NOT NULL,
	"spans" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cart_id" text,
	"agent_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "carts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"writ_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"body" jsonb NOT NULL,
	"body_hash" "bytea" NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "carts_body_hash_check" CHECK (octet_length("carts"."body_hash") = 32)
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"cart_id" text NOT NULL,
	"stage" text NOT NULL,
	"verdict" text NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model" text,
	"latency_ms" integer,
	"tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decisions_verdict_check" CHECK ("decisions"."verdict" in ('APPROVE', 'REVIEW', 'BLOCK')),
	CONSTRAINT "decisions_latency_check" CHECK ("decisions"."latency_ms" >= 0),
	CONSTRAINT "decisions_tokens_check" CHECK ("decisions"."tokens" >= 0)
);
--> statement-breakpoint
CREATE TABLE "device_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"public_key_ed25519" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_keys_public_key_check" CHECK (octet_length("device_keys"."public_key_ed25519") = 32)
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"paypal_dispute_id" text NOT NULL,
	"purchase_id" text,
	"reason" text,
	"status" text NOT NULL,
	"stage" text,
	"analysis" jsonb,
	"action" text,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disputes_paypal_dispute_id_unique" UNIQUE("paypal_dispute_id")
);
--> statement-breakpoint
CREATE TABLE "ledger_events" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"purchase_id" text,
	"writ_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"prev_hash" "bytea" NOT NULL,
	"hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_events_writ_prev_hash_unique" UNIQUE("writ_id","prev_hash"),
	CONSTRAINT "ledger_events_hash_unique" UNIQUE("hash"),
	CONSTRAINT "ledger_events_prev_hash_check" CHECK (octet_length("ledger_events"."prev_hash") = 32),
	CONSTRAINT "ledger_events_hash_check" CHECK (octet_length("ledger_events"."hash") = 32)
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passkeys" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"public_key_cose" "bytea" NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "passkeys_credential_id_unique" UNIQUE("credential_id"),
	CONSTRAINT "passkeys_counter_check" CHECK ("passkeys"."counter" >= 0)
);
--> statement-breakpoint
CREATE TABLE "paypal_vault_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"vault_id" text NOT NULL,
	"paypal_customer_id" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paypal_vault_tokens_vault_id_unique" UNIQUE("vault_id")
);
--> statement-breakpoint
CREATE TABLE "purchases" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"writ_id" text NOT NULL,
	"cart_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"state" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"paypal_order_id" text,
	"authorization_id" text,
	"capture_id" text,
	"refund_id" text,
	"c_pre" "bytea",
	"c_post" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchases_paypal_order_id_unique" UNIQUE("paypal_order_id"),
	CONSTRAINT "purchases_authorization_id_unique" UNIQUE("authorization_id"),
	CONSTRAINT "purchases_capture_id_unique" UNIQUE("capture_id"),
	CONSTRAINT "purchases_refund_id_unique" UNIQUE("refund_id"),
	CONSTRAINT "purchases_agent_idempotency_unique" UNIQUE("agent_id","idempotency_key"),
	CONSTRAINT "purchases_state_check" CHECK ("purchases"."state" in ('PROPOSED', 'BLOCKED', 'RESERVED', 'AUTHORIZING', 'AUTHORIZED', 'FAILED', 'VERIFYING', 'CAPTURING', 'AWAITING_HUMAN', 'VOIDING', 'CAPTURED', 'VOIDED', 'REFUNDED', 'DISPUTED', 'DISPUTE_WON', 'DISPUTE_LOST')),
	CONSTRAINT "purchases_amount_check" CHECK ("purchases"."amount_minor" > 0),
	CONSTRAINT "purchases_currency_check" CHECK ("purchases"."currency" in ('USD')),
	CONSTRAINT "purchases_idempotency_key_check" CHECK (char_length("purchases"."idempotency_key") between 1 and 255),
	CONSTRAINT "purchases_c_pre_check" CHECK (octet_length("purchases"."c_pre") = 32),
	CONSTRAINT "purchases_c_post_check" CHECK (octet_length("purchases"."c_post") = 32)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"paypal_event_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "writ_budgets" (
	"writ_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"limit_minor" bigint NOT NULL,
	"max_per_order_minor" bigint NOT NULL,
	"reserved_minor" bigint DEFAULT 0 NOT NULL,
	"spent_minor" bigint DEFAULT 0 NOT NULL,
	"orders_count" integer DEFAULT 0 NOT NULL,
	"max_orders" integer NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "writ_budgets_limit_check" CHECK ("writ_budgets"."limit_minor" > 0),
	CONSTRAINT "writ_budgets_max_per_order_check" CHECK ("writ_budgets"."max_per_order_minor" > 0),
	CONSTRAINT "writ_budgets_reserved_check" CHECK ("writ_budgets"."reserved_minor" >= 0),
	CONSTRAINT "writ_budgets_spent_check" CHECK ("writ_budgets"."spent_minor" >= 0),
	CONSTRAINT "writ_budgets_within_limit_check" CHECK ("writ_budgets"."spent_minor" + "writ_budgets"."reserved_minor" <= "writ_budgets"."limit_minor"),
	CONSTRAINT "writ_budgets_max_orders_check" CHECK ("writ_budgets"."max_orders" > 0),
	CONSTRAINT "writ_budgets_orders_count_check" CHECK ("writ_budgets"."orders_count" >= 0 and "writ_budgets"."orders_count" <= "writ_budgets"."max_orders")
);
--> statement-breakpoint
CREATE TABLE "writs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text,
	"body" jsonb NOT NULL,
	"body_hash" "bytea" NOT NULL,
	"signature" jsonb,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "writs_body_hash_check" CHECK (octet_length("writs"."body_hash") = 32)
);
--> statement-breakpoint
ALTER TABLE "address_book" ADD CONSTRAINT "address_book_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attacks" ADD CONSTRAINT "attacks_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attacks" ADD CONSTRAINT "attacks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_writ_id_writs_id_fk" FOREIGN KEY ("writ_id") REFERENCES "public"."writs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_keys" ADD CONSTRAINT "device_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_events" ADD CONSTRAINT "ledger_events_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_events" ADD CONSTRAINT "ledger_events_writ_id_writs_id_fk" FOREIGN KEY ("writ_id") REFERENCES "public"."writs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_vault_tokens" ADD CONSTRAINT "paypal_vault_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_writ_id_writs_id_fk" FOREIGN KEY ("writ_id") REFERENCES "public"."writs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "writ_budgets" ADD CONSTRAINT "writ_budgets_writ_id_writs_id_fk" FOREIGN KEY ("writ_id") REFERENCES "public"."writs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "writs" ADD CONSTRAINT "writs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "writs" ADD CONSTRAINT "writs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_user_idx" ON "agents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "approvals_purchase_idx" ON "approvals" USING btree ("purchase_id");--> statement-breakpoint
CREATE INDEX "approvals_status_expires_idx" ON "approvals" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "attacks_tenant_created_idx" ON "attacks" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "carts_writ_idx" ON "carts" USING btree ("writ_id");--> statement-breakpoint
CREATE INDEX "decisions_cart_idx" ON "decisions" USING btree ("cart_id");--> statement-breakpoint
CREATE INDEX "device_keys_user_idx" ON "device_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "disputes_purchase_idx" ON "disputes" USING btree ("purchase_id");--> statement-breakpoint
CREATE INDEX "disputes_tenant_created_idx" ON "disputes" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "ledger_events_purchase_idx" ON "ledger_events" USING btree ("purchase_id");--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "outbox" USING btree ("created_at") WHERE "outbox"."published_at" is null;--> statement-breakpoint
CREATE INDEX "passkeys_user_idx" ON "passkeys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "paypal_vault_tokens_user_idx" ON "paypal_vault_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "purchases_writ_idx" ON "purchases" USING btree ("writ_id");--> statement-breakpoint
CREATE INDEX "purchases_cart_idx" ON "purchases" USING btree ("cart_id");--> statement-breakpoint
CREATE INDEX "purchases_state_updated_idx" ON "purchases" USING btree ("state","updated_at");--> statement-breakpoint
CREATE INDEX "purchases_tenant_created_idx" ON "purchases" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "users_tenant_idx" ON "users" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "webhook_events_unprocessed_idx" ON "webhook_events" USING btree ("created_at") WHERE "webhook_events"."processed_at" is null;--> statement-breakpoint
CREATE INDEX "writs_user_idx" ON "writs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "writs_agent_idx" ON "writs" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "writs_tenant_created_idx" ON "writs" USING btree ("tenant_id","created_at");