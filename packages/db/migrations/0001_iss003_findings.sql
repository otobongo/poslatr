--> Hand-ordered. drizzle-kit generated the ADD CONSTRAINT statements before the
--> CREATE UNIQUE INDEX statements they reference, which Postgres rejects with
--> "there is no unique constraint matching given keys for referenced table".
--> Indexes are created first below. Forward-only, per PRD 3.1.

ALTER TABLE "psl_post_targets" DROP CONSTRAINT "psl_post_targets_post_id_psl_posts_id_fk";
--> statement-breakpoint
ALTER TABLE "psl_post_targets" DROP CONSTRAINT "psl_post_targets_connection_id_psl_connections_id_fk";
--> statement-breakpoint
ALTER TABLE "psl_dead_letters" DROP CONSTRAINT "psl_dead_letters_post_target_id_psl_post_targets_id_fk";
--> statement-breakpoint
ALTER TABLE "psl_post_targets" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "psl_post_targets" ADD COLUMN "claim_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "psl_connections_id_workspace_id_key" ON "psl_connections" USING btree ("id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "psl_posts_id_workspace_id_key" ON "psl_posts" USING btree ("id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "psl_post_targets_id_workspace_id_key" ON "psl_post_targets" USING btree ("id","workspace_id");--> statement-breakpoint
CREATE INDEX "psl_post_targets_status_claim_expires_at_idx" ON "psl_post_targets" USING btree ("status","claim_expires_at");--> statement-breakpoint
ALTER TABLE "psl_post_targets" ADD CONSTRAINT "psl_post_targets_post_workspace_fk" FOREIGN KEY ("post_id","workspace_id") REFERENCES "public"."psl_posts"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "psl_post_targets" ADD CONSTRAINT "psl_post_targets_connection_workspace_fk" FOREIGN KEY ("connection_id","workspace_id") REFERENCES "public"."psl_connections"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "psl_dead_letters" ADD CONSTRAINT "psl_dead_letters_post_target_workspace_fk" FOREIGN KEY ("post_target_id","workspace_id") REFERENCES "public"."psl_post_targets"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE OR REPLACE FUNCTION psl_audit_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'psl_audit_events is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS psl_audit_events_no_update ON "psl_audit_events";--> statement-breakpoint
CREATE TRIGGER psl_audit_events_no_update
  BEFORE UPDATE ON "psl_audit_events"
  FOR EACH ROW EXECUTE FUNCTION psl_audit_events_append_only();--> statement-breakpoint
DROP TRIGGER IF EXISTS psl_audit_events_no_delete ON "psl_audit_events";--> statement-breakpoint
CREATE TRIGGER psl_audit_events_no_delete
  BEFORE DELETE ON "psl_audit_events"
  FOR EACH ROW EXECUTE FUNCTION psl_audit_events_append_only();
