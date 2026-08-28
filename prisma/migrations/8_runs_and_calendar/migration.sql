-- The recurring-service layer this system has never had. Entirely additive: every
-- existing trip stays valid, and manual trip creation keeps working forever.

CREATE TYPE "RunDirection" AS ENUM ('TO_SCHOOL', 'FROM_SCHOOL');
CREATE TYPE "ExceptionType" AS ENUM ('ADDED', 'REMOVED');

CREATE TABLE "Run" (
    "id" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "busId" TEXT,
    "driverId" TEXT,
    "name" TEXT NOT NULL,
    "direction" "RunDirection" NOT NULL,
    -- Wall clock, "07:15". A recurring departure is a time of day, not an instant.
    "departure" TEXT NOT NULL,
    "mon" BOOLEAN NOT NULL DEFAULT false,
    "tue" BOOLEAN NOT NULL DEFAULT false,
    "wed" BOOLEAN NOT NULL DEFAULT false,
    "thu" BOOLEAN NOT NULL DEFAULT false,
    "fri" BOOLEAN NOT NULL DEFAULT false,
    "sat" BOOLEAN NOT NULL DEFAULT false,
    "sun" BOOLEAN NOT NULL DEFAULT false,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Run_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RunException" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "type" "ExceptionType" NOT NULL,
    "departure" TEXT,
    "reason" TEXT,
    CONSTRAINT "RunException_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CalendarDay" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT,
    "date" DATE NOT NULL,
    "closed" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT NOT NULL,
    CONSTRAINT "CalendarDay_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Trip"
    ADD COLUMN "runId" TEXT,
    ADD COLUMN "serviceDate" DATE,
    ADD COLUMN "direction" "RunDirection",
    ADD COLUMN "isOverridden" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "cancelledByCalendarDayId" TEXT;

CREATE INDEX "Run_routeId_active_idx" ON "Run"("routeId", "active");
CREATE UNIQUE INDEX "RunException_runId_date_key" ON "RunException"("runId", "date");
CREATE UNIQUE INDEX "CalendarDay_schoolId_date_key" ON "CalendarDay"("schoolId", "date");
CREATE INDEX "CalendarDay_date_idx" ON "CalendarDay"("date");

-- Postgres treats NULLs as DISTINCT, so the unique index above does nothing for
-- platform-wide rows: two schoolId IS NULL closures on one date both satisfy it.
-- Prisma 5 cannot express NULLS NOT DISTINCT, so this is hand-written.
--
-- Without it, closing 14 November twice leaves two rows; reopening deletes one, the
-- day stays closed by the survivor, and nothing runs. The failure is a morning where
-- nothing happens and nobody is told.
CREATE UNIQUE INDEX "CalendarDay_platform_date_key"
    ON "CalendarDay"("date") WHERE "schoolId" IS NULL;

-- The materialiser's idempotency guarantee: it can run twice, be retried after a
-- crash, or overlap itself and still produce exactly one trip per run per day.
-- Hand-created trips have both columns NULL and are unaffected, again because
-- Postgres treats NULLs as distinct — the same property that is a hole above is the
-- feature here.
CREATE UNIQUE INDEX "Trip_runId_serviceDate_key" ON "Trip"("runId", "serviceDate");
CREATE INDEX "Trip_serviceDate_idx" ON "Trip"("serviceDate");

ALTER TABLE "Run" ADD CONSTRAINT "Run_routeId_fkey"
    FOREIGN KEY ("routeId") REFERENCES "Route"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RunException" ADD CONSTRAINT "RunException_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CalendarDay" ADD CONSTRAINT "CalendarDay_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_cancelledByCalendarDayId_fkey"
    FOREIGN KEY ("cancelledByCalendarDayId") REFERENCES "CalendarDay"("id") ON DELETE SET NULL ON UPDATE CASCADE;
