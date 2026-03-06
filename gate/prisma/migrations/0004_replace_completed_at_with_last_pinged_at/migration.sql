-- Replace completed_at with last_pinged_at for lazy expiration
-- Backfill last_pinged_at with first_registered_at for existing rows
ALTER TABLE "deployments" ADD COLUMN "last_pinged_at" TIMESTAMP(3);
UPDATE "deployments" SET "last_pinged_at" = "first_registered_at";
ALTER TABLE "deployments" ALTER COLUMN "last_pinged_at" SET NOT NULL;

ALTER TABLE "deployments" DROP COLUMN "completed_at";
