-- Change foreign keys from RESTRICT to CASCADE so deleting a deployment
-- automatically cleans up its services and expected services

-- deployment_services
ALTER TABLE "deployment_services" DROP CONSTRAINT "deployment_services_deployment_id_fkey";
ALTER TABLE "deployment_services" ADD CONSTRAINT "deployment_services_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("deployment_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- expected_services
ALTER TABLE "expected_services" DROP CONSTRAINT "expected_services_deployment_id_fkey";
ALTER TABLE "expected_services" ADD CONSTRAINT "expected_services_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("deployment_id") ON DELETE CASCADE ON UPDATE CASCADE;
