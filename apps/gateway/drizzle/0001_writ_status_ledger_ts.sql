ALTER TABLE "ledger_events" ADD COLUMN "ts" text NOT NULL;--> statement-breakpoint
CREATE INDEX "ledger_events_writ_seq_idx" ON "ledger_events" USING btree ("writ_id","seq");--> statement-breakpoint
ALTER TABLE "ledger_events" ADD CONSTRAINT "ledger_events_ts_check" CHECK ("ledger_events"."ts" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$');--> statement-breakpoint
ALTER TABLE "writs" ADD CONSTRAINT "writs_status_check" CHECK ("writs"."status" in ('DRAFT', 'ACTIVE', 'REVOKED', 'EXPIRED'));