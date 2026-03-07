-- Drop last_registered_at from deployments
-- Settle time is now computed per-group from DeploymentService.registeredAt
ALTER TABLE "deployments" DROP COLUMN "last_registered_at";
