-- Additive only. Every column is nullable, so existing rows stay valid and no
-- backfill is required.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "phone" TEXT;
ALTER TABLE "User" ADD COLUMN "fcmToken" TEXT;

-- AlterTable
ALTER TABLE "Student" ADD COLUMN "guardianPhone" TEXT;

-- AlterTable
ALTER TABLE "Trip" ADD COLUMN "scheduledStart" TIMESTAMP(3);
