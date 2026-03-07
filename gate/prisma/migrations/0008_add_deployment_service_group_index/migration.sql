-- Add composite index on (deployment_id, group_name) for DeploymentService
-- This is the hot query path in /ready when filtering services by group
CREATE INDEX "deployment_services_deployment_id_group_name_idx" ON "deployment_services"("deployment_id", "group_name");
