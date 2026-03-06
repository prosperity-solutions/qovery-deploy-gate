-- Track individual pods: each pod registers separately with pod_name + namespace
-- Change unique constraint from (deployment_id, service_id) to (deployment_id, service_id, pod_name, namespace)

-- Add new columns
ALTER TABLE "deployment_services" ADD COLUMN "pod_name" TEXT NOT NULL DEFAULT '';
ALTER TABLE "deployment_services" ADD COLUMN "namespace" TEXT NOT NULL DEFAULT '';

-- Drop old unique index and create new one
DROP INDEX "deployment_services_deployment_id_service_id_key";
CREATE UNIQUE INDEX "deployment_services_deployment_id_service_id_pod_name_names_key" ON "deployment_services"("deployment_id", "service_id", "pod_name", "namespace");

-- Remove default on pod_name (it was only for backfill of existing rows)
ALTER TABLE "deployment_services" ALTER COLUMN "pod_name" DROP DEFAULT;
