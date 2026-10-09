ALTER TABLE "provider_config" ADD COLUMN IF NOT EXISTS "name" text;--> statement-breakpoint
-- Backfill: existing single-per-type rows get their type label as the
-- connection name, so legacy rows keep working and read sensibly.
UPDATE "provider_config" SET "name" = "provider"::text WHERE "name" IS NULL;--> statement-breakpoint
ALTER TABLE "provider_config" ALTER COLUMN "name" SET NOT NULL;