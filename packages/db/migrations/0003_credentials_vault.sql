CREATE TABLE "psl_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"ciphertext" text NOT NULL,
	"nonce" text NOT NULL,
	"key_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Hand-edited: Postgres refuses text -> uuid without an explicit cast, even on
-- an all-NULL column (drizzle-kit omits the USING clause).
ALTER TABLE "psl_connections" ALTER COLUMN "credentials_ref" SET DATA TYPE uuid USING "credentials_ref"::uuid;--> statement-breakpoint
ALTER TABLE "psl_credentials" ADD CONSTRAINT "psl_credentials_workspace_id_psl_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."psl_workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "psl_credentials_workspace_id_created_at_idx" ON "psl_credentials" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "psl_credentials_key_version_idx" ON "psl_credentials" USING btree ("key_version");--> statement-breakpoint
CREATE UNIQUE INDEX "psl_credentials_id_workspace_id_key" ON "psl_credentials" USING btree ("id","workspace_id");--> statement-breakpoint
ALTER TABLE "psl_connections" ADD CONSTRAINT "psl_connections_credentials_workspace_fk" FOREIGN KEY ("credentials_ref","workspace_id") REFERENCES "public"."psl_credentials"("id","workspace_id") ON DELETE restrict ON UPDATE no action;