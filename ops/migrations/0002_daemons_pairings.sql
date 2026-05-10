-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE IF NOT EXISTS "daemons" (
    "id"            text PRIMARY KEY NOT NULL,
    "user_id"       text NOT NULL,
    "hostname"      text NOT NULL,
    "os"            text NOT NULL,
    "agent_version" text NOT NULL,
    "token_hash"    text NOT NULL,
    "paired_at"     timestamp with time zone DEFAULT now() NOT NULL,
    "last_seen_at"  timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "daemons" ADD CONSTRAINT "daemons_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "daemons" ADD CONSTRAINT "daemons_os_check" CHECK ("os" IN ('windows','macos','linux'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "daemons_user_id_idx" ON "daemons" USING btree ("user_id");
--> statement-breakpoint
ALTER TABLE "pairings" ADD COLUMN IF NOT EXISTS "consumed_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pairings_expires_idx" ON "pairings" USING btree ("expires_at");
