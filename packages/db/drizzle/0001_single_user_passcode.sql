DROP INDEX IF EXISTS "user_email_idx";--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN IF EXISTS "email";