-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('ACTIVE', 'COMPLETED');

-- AlterTable: convert status column from TEXT to enum
ALTER TABLE "deployments" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "deployments" ALTER COLUMN "status" TYPE "DeploymentStatus" USING "status"::"DeploymentStatus";
ALTER TABLE "deployments" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';
