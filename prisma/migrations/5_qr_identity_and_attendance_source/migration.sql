-- A child who was not at their stop. Until now this was indistinguishable from a
-- driver who forgot to scan.
ALTER TYPE "AttendanceType" ADD VALUE 'NO_SHOW';

-- How a row came to exist. Existing rows are all scans, hence the default.
CREATE TYPE "AttendanceSource" AS ENUM ('SCAN', 'MANUAL');

ALTER TABLE "AttendanceLog"
  ADD COLUMN "source" "AttendanceSource" NOT NULL DEFAULT 'SCAN';

-- Scannable identity. Nullable so the backfill below can run before the unique index.
ALTER TABLE "Student"
  ADD COLUMN "qrToken" TEXT,
  ADD COLUMN "qrCodeImported" BOOLEAN NOT NULL DEFAULT false;

-- Give every existing child a token in the same migration, so the whole school is
-- printable the moment this lands rather than needing a separate pass. 32 hex chars
-- from gen_random_uuid() is 122 bits of entropy — ample for a credential that also
-- has to survive being read off a laminated card by a phone camera.
UPDATE "Student"
  SET "qrToken" = replace(gen_random_uuid()::text, '-', '')
  WHERE "qrToken" IS NULL;

-- Unique per SCHOOL, not globally: imported codes are roll and admission numbers, and
-- two schools will both have an "R042". Matching is already school-scoped so this
-- costs nothing. Created AFTER the backfill so existing rows cannot collide on NULL.
--
-- Note Postgres treats NULLs as DISTINCT, so this does not prevent several students in
-- one school having no token at all. That is intentional — a token is optional at the
-- column level and the application decides when one is required.
CREATE UNIQUE INDEX "Student_schoolId_qrToken_key" ON "Student"("schoolId", "qrToken");
