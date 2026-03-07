-- Add last_registered_at to deployments (tracks when the last new pod was registered)
ALTER TABLE "deployments" ADD COLUMN "last_registered_at" TIMESTAMP(3);
UPDATE "deployments" SET "last_registered_at" = "first_registered_at";
ALTER TABLE "deployments" ALTER COLUMN "last_registered_at" SET NOT NULL;

-- Create expected_services table (webhook pre-registers expected service IDs)
CREATE TABLE "expected_services" (
    "id" SERIAL NOT NULL,
    "deployment_id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "group_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expected_services_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "expected_services_deployment_id_service_id_key" ON "expected_services"("deployment_id", "service_id");
CREATE INDEX "expected_services_deployment_id_idx" ON "expected_services"("deployment_id");

ALTER TABLE "expected_services" ADD CONSTRAINT "expected_services_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("deployment_id") ON DELETE RESTRICT ON UPDATE CASCADE;
