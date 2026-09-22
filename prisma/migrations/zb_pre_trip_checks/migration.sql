-- The driver app has always filed a timed pre-trip walk-around before a trip starts
-- (POST /api/trips/:tripId/pre-trip-check). There was nowhere to keep it, so every
-- one was a 404 the app swallowed. This is that place.
--
-- A new table only: no existing table or row is touched. One row per trip.
CREATE TABLE "PreTripCheck" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "note" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PreTripCheck_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PreTripCheck_tripId_key" ON "PreTripCheck"("tripId");

ALTER TABLE "PreTripCheck" ADD CONSTRAINT "PreTripCheck_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;
