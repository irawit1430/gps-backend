-- Parent invites. A new parent account opens with a one-time code that only its invite
-- carries, unique per parent and good for a limited time, instead of a password the
-- office copies out of a popup (or one shared opening password for the whole school).
-- The school's activation page reads these to say, per family: not invited, invite
-- sent (and how), expired, or activated.
--
-- inviteSentAt     when the latest invite went out; NULL = never sent (or it failed).
-- inviteExpiresAt  the code stops working after this. Cleared once the parent chooses
--                  their own password, so it never expires a real password.
-- inviteChannel    EMAIL (sent by this server), WHATSAPP / SMS / PRINT / COPY (handed
--                  over by school staff, so delivery is theirs to confirm), EMAIL_FAILED,
--                  or REVOKED.
--
-- Additive and nullable: existing parents read as "not invited" until the school acts,
-- which is true of them. No backfill, no lock beyond ADD COLUMN's.
ALTER TABLE "User" ADD COLUMN "inviteSentAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "inviteExpiresAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "inviteChannel" TEXT;
