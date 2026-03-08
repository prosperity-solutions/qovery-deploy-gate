-- Track which deployment+group combos have completed so that
-- autoscaling pods get an immediate "open" without being tracked
CREATE TABLE "completed_groups" (
    "id" SERIAL NOT NULL,
    "deployment_id" TEXT NOT NULL,
    "group_name" TEXT NOT NULL,
    "completed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "completed_groups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "completed_groups_deployment_id_group_name_key" ON "completed_groups"("deployment_id", "group_name");

ALTER TABLE "completed_groups" ADD CONSTRAINT "completed_groups_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("deployment_id") ON DELETE CASCADE ON UPDATE CASCADE;
