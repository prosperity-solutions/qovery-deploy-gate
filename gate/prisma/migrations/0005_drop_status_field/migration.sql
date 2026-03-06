-- Status is now fully derived: COMPLETED from service readyAt, EXPIRED from stale lastPingedAt
DROP INDEX IF EXISTS "deployments_status_idx";
ALTER TABLE "deployments" DROP COLUMN "status";
DROP TYPE IF EXISTS "DeploymentStatus";
