CREATE TYPE "public"."psl_connection_health" AS ENUM('ok', 'expiring', 'broken');--> statement-breakpoint
CREATE TYPE "public"."psl_post_status" AS ENUM('draft', 'scheduled', 'publishing', 'published', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."psl_post_target_status" AS ENUM('draft', 'scheduled', 'publishing', 'published', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "psl_workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "psl_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "psl_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"display_name" text NOT NULL,
	"credentials_ref" text,
	"token_expires_at" timestamp with time zone,
	"health" "psl_connection_health" DEFAULT 'ok' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "psl_media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" bigint NOT NULL,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"checksum" text NOT NULL,
	"original_filename" text,
	"renditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "psl_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"status" "psl_post_status" DEFAULT 'draft' NOT NULL,
	"body" jsonb NOT NULL,
	"scheduled_at" timestamp with time zone,
	"timezone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "psl_post_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"status" "psl_post_target_status" DEFAULT 'draft' NOT NULL,
	"body_override" jsonb,
	"remote_post_id" text,
	"remote_url" text,
	"scheduled_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "psl_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"outcome" text NOT NULL,
	"correlation_id" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "psl_dead_letters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"post_target_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"error_class" text NOT NULL,
	"error_detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempt_count" integer NOT NULL,
	"correlation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "psl_users" ADD CONSTRAINT "psl_users_workspace_id_psl_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."psl_workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "psl_connections" ADD CONSTRAINT "psl_connections_workspace_id_psl_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."psl_workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "psl_media_assets" ADD CONSTRAINT "psl_media_assets_workspace_id_psl_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."psl_workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "psl_posts" ADD CONSTRAINT "psl_posts_workspace_id_psl_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."psl_workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "psl_post_targets" ADD CONSTRAINT "psl_post_targets_workspace_id_psl_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."psl_workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "psl_post_targets" ADD CONSTRAINT "psl_post_targets_post_id_psl_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."psl_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "psl_post_targets" ADD CONSTRAINT "psl_post_targets_connection_id_psl_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."psl_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "psl_audit_events" ADD CONSTRAINT "psl_audit_events_workspace_id_psl_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."psl_workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "psl_dead_letters" ADD CONSTRAINT "psl_dead_letters_workspace_id_psl_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."psl_workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "psl_dead_letters" ADD CONSTRAINT "psl_dead_letters_post_target_id_psl_post_targets_id_fk" FOREIGN KEY ("post_target_id") REFERENCES "public"."psl_post_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "psl_workspaces_created_at_idx" ON "psl_workspaces" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "psl_users_email_key" ON "psl_users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "psl_users_workspace_id_created_at_idx" ON "psl_users" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "psl_connections_workspace_id_created_at_idx" ON "psl_connections" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "psl_connections_health_idx" ON "psl_connections" USING btree ("health");--> statement-breakpoint
CREATE UNIQUE INDEX "psl_media_assets_workspace_id_checksum_key" ON "psl_media_assets" USING btree ("workspace_id","checksum");--> statement-breakpoint
CREATE UNIQUE INDEX "psl_media_assets_storage_key_key" ON "psl_media_assets" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "psl_media_assets_workspace_id_created_at_idx" ON "psl_media_assets" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "psl_posts_status_scheduled_at_idx" ON "psl_posts" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "psl_posts_workspace_id_created_at_idx" ON "psl_posts" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "psl_post_targets_status_scheduled_at_idx" ON "psl_post_targets" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "psl_post_targets_workspace_id_created_at_idx" ON "psl_post_targets" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "psl_post_targets_post_id_idx" ON "psl_post_targets" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "psl_audit_events_workspace_id_created_at_idx" ON "psl_audit_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "psl_audit_events_entity_type_entity_id_idx" ON "psl_audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "psl_audit_events_correlation_id_idx" ON "psl_audit_events" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "psl_dead_letters_workspace_id_created_at_idx" ON "psl_dead_letters" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "psl_dead_letters_post_target_id_idx" ON "psl_dead_letters" USING btree ("post_target_id");