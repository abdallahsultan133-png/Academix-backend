-- Catch-up migration: reconciles the schema changes that were applied to the
-- database via `drizzle-kit push` after 0006 (calendar recurrence, subjects
-- ownership, submission AI fields, two indexes) back into version-controlled
-- migration history.
--
-- Written idempotently (IF NOT EXISTS / EXCEPTION guards) so it applies cleanly
-- on BOTH a database that already received these changes via push AND a fresh
-- database. From 0008 onward, migrations are generated normally and need no
-- such guards.

DO $$ BEGIN
	CREATE TYPE "public"."calendar_recurrence_freq" AS ENUM('none', 'daily', 'weekly', 'monthly');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN IF NOT EXISTS "recurrence_freq" "calendar_recurrence_freq" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN IF NOT EXISTS "recurrence_interval" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN IF NOT EXISTS "recurrence_end_at" timestamp;--> statement-breakpoint
ALTER TABLE "subjects" ADD COLUMN IF NOT EXISTS "created_by" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "ai_score" integer;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "ai_summary" text;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "subjects" ADD CONSTRAINT "subjects_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subjects_department_id_idx" ON "subjects" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_role_idx" ON "user" USING btree ("role");
