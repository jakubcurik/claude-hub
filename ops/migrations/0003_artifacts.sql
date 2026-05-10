CREATE TYPE "public"."artifact_type" AS ENUM('skill', 'plugin', 'command', 'agent');--> statement-breakpoint
CREATE TYPE "public"."install_status" AS ENUM('success', 'failed', 'rolled_back');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "artifact_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"artifact_id" text NOT NULL,
	"version" text NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"published_by_user_id" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deprecated" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"type" "artifact_type" NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"owner_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "artifacts_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "install_events" (
	"id" text PRIMARY KEY NOT NULL,
	"daemon_id" text NOT NULL,
	"artifact_version_id" text NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "install_status" NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "install_events" ADD CONSTRAINT "install_events_daemon_id_daemons_id_fk" FOREIGN KEY ("daemon_id") REFERENCES "public"."daemons"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "install_events" ADD CONSTRAINT "install_events_artifact_version_id_artifact_versions_id_fk" FOREIGN KEY ("artifact_version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "artifact_versions_artifact_version_uq" ON "artifact_versions" USING btree ("artifact_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifact_versions_published_at_idx" ON "artifact_versions" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifact_versions_manifest_gin" ON "artifact_versions" USING gin ("manifest");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifacts_type_idx" ON "artifacts" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifacts_owner_idx" ON "artifacts" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "install_events_daemon_idx" ON "install_events" USING btree ("daemon_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "install_events_version_idx" ON "install_events" USING btree ("artifact_version_id");