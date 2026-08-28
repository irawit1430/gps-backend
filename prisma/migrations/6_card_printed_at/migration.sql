-- Stamped by POST /api/schools/:schoolId/qr-cards as a side effect of printing.
--
-- Null for every existing row, which is correct: no cards have been printed yet. The
-- previous migration backfilled a token for every student, which made "the roster
-- carries a hash" stop meaning "a card exists" — the driver app's scanner gate was
-- reading exactly that proxy and opened for schools that had printed nothing.
ALTER TABLE "Student" ADD COLUMN "qrCardPrintedAt" TIMESTAMP(3);
