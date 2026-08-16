-- AlterTable
ALTER TABLE "School" ADD COLUMN "contactEmail" TEXT;
ALTER TABLE "School" ADD COLUMN "contactPhone" TEXT;
ALTER TABLE "School" ADD COLUMN "website" TEXT;
ALTER TABLE "School" ADD COLUMN "pincode" TEXT;
ALTER TABLE "School" ADD COLUMN "latitude" DOUBLE PRECISION;
ALTER TABLE "School" ADD COLUMN "longitude" DOUBLE PRECISION;
ALTER TABLE "School" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "Bus" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ONLINE';

-- AlterTable
ALTER TABLE "User" ADD COLUMN "lastLoginAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "GlobalSettings" ADD COLUMN "mapDefaultZoom" INTEGER;
ALTER TABLE "GlobalSettings" ADD COLUMN "overspeedLimitKph" INTEGER;
ALTER TABLE "GlobalSettings" ADD COLUMN "offlineAlertMinutes" INTEGER;
ALTER TABLE "GlobalSettings" ADD COLUMN "alertEmail" TEXT;
