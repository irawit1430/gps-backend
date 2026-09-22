-- When a user's password changes or is reset, or their role or school changes, every
-- token they hold is revoked. That cutoff lived only in memory, so a restart or deploy
-- revived those tokens until they expired. It is now saved here and read back at boot.
--
-- Additive and nullable: NULL means nothing revoked, which is true of every existing
-- row. No backfill, no default, no lock beyond the brief one ADD COLUMN takes.
--
-- Named to sort after z_parent_trust_contracts: Prisma applies migrations in directory
-- name order, and that one is already applied in production.
ALTER TABLE "User" ADD COLUMN "tokensValidAfter" TIMESTAMP(3);
