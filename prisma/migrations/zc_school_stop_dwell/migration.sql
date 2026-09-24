-- Minutes a bus waits at each stop, per school. Parents' ETAs and the office's pickup
-- times add it for every stop before theirs. NULL means the server default
-- (STOP_DWELL_MINUTES, 1 minute), which is every existing school.
--
-- Additive and nullable: no backfill, no default, no lock beyond ADD COLUMN's.
ALTER TABLE "School" ADD COLUMN "stopDwellMinutes" DOUBLE PRECISION;
