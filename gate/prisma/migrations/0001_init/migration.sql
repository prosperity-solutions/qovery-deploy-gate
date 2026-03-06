-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "deployments" (
    "id" SERIAL NOT NULL,
    "deployment_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "first_registered_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deployments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployment_services" (
    "id" SERIAL NOT NULL,
    "deployment_id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "group_name" TEXT NOT NULL,
    "registered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ready_at" TIMESTAMP(3),

    CONSTRAINT "deployment_services_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "deployments_deployment_id_key" ON "deployments"("deployment_id");

-- CreateIndex
CREATE INDEX "deployments_status_idx" ON "deployments"("status");

-- CreateIndex
CREATE INDEX "deployments_created_at_idx" ON "deployments"("created_at");

-- CreateIndex
CREATE INDEX "deployment_services_deployment_id_idx" ON "deployment_services"("deployment_id");

-- CreateIndex
CREATE UNIQUE INDEX "deployment_services_deployment_id_service_id_key" ON "deployment_services"("deployment_id", "service_id");

-- AddForeignKey
ALTER TABLE "deployment_services" ADD CONSTRAINT "deployment_services_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("deployment_id") ON DELETE RESTRICT ON UPDATE CASCADE;
