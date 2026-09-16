#!/usr/bin/env bash
#
# Voltava Fleet — nightly logical backup.
#
# Tier 1 of the two-tier strategy in docs/OPERATIONS_FIXES.md §1:
#   Tier 1 (this script) — pg_dump every night. Portable, restores into any
#                          Postgres, survives the VM disappearing entirely.
#   Tier 2 (pgbackrest)  — continuous WAL archiving for point-in-time recovery.
#
# This tier exists on its own because it can be running tonight. Tier 2 needs a
# Postgres restart and a maintenance window; this needs a service account and a
# bucket. A school that loses a day is recoverable. A school that loses its whole
# history is not, and today that is where this deployment sits.
#
# Installed by systemd (voltava-backup.timer). Writes to stdout/stderr, which
# journald collects and the GCP Ops Agent ships to Cloud Logging — so the alert
# policy in §4 sees a failure without this script knowing anything about alerting.
#
# Usage:  voltava-backup.sh            (reads /etc/voltava/backup.env)
#         BACKUP_ENV=/path/to.env voltava-backup.sh

set -Eeuo pipefail

ENV_FILE="${BACKUP_ENV:-/etc/voltava/backup.env}"
# shellcheck disable=SC1090
[ -r "$ENV_FILE" ] && . "$ENV_FILE"

: "${PGHOST:=localhost}"
: "${PGPORT:=5432}"
: "${PGUSER:=voltava}"
: "${PGDATABASE:=voltava_fleet}"
: "${BACKUP_DIR:=/var/backups/voltava}"
: "${GCS_BUCKET:?GCS_BUCKET is required, e.g. gs://voltava-backups}"
# Days of dumps to keep on the VM's own disk. The bucket keeps the long tail —
# local copies exist only so a restore drill does not have to download first.
: "${LOCAL_RETENTION_DAYS:=3}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASENAME="voltava_fleet_${STAMP}"
DUMP="${BACKUP_DIR}/${BASENAME}.dump"
LOCK="/var/lock/voltava-backup.lock"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { log "BACKUP FAILED: $*" >&2; exit 1; }

trap 'fail "aborted at line $LINENO"' ERR

# One at a time. A slow night must not overlap the next night's run and have two
# pg_dumps competing with the morning school run for the same disk and CPU.
exec 9>"$LOCK"
flock -n 9 || fail "another backup is already running"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

log "starting backup of ${PGDATABASE} on ${PGHOST}:${PGPORT}"

# -Fc  custom format: compressed, and restorable table-by-table with pg_restore,
#      which is what you want at 03:00 when only one table is wrong.
# --no-owner / --no-privileges: the restore target is a scratch database owned by
#      whoever is running the drill, not necessarily the `voltava` role.
pg_dump \
  --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" --dbname="$PGDATABASE" \
  --format=custom --compress=9 --no-owner --no-privileges \
  --file="$DUMP"

SIZE_BYTES="$(stat -c %s "$DUMP")"
[ "$SIZE_BYTES" -gt 10240 ] || fail "dump is only ${SIZE_BYTES} bytes — refusing to upload a truncated backup"

# Verify before uploading. pg_restore --list parses the archive's table of
# contents; a dump that was cut off mid-write fails here rather than six months
# from now when somebody actually needs it.
pg_restore --list "$DUMP" > "${DUMP}.toc"
TABLE_COUNT="$(grep -c 'TABLE DATA' "${DUMP}.toc" || true)"
[ "$TABLE_COUNT" -ge 10 ] || fail "dump lists only ${TABLE_COUNT} data tables — the schema has 18; refusing to upload"

sha256sum "$DUMP" | awk '{print $1}' > "${DUMP}.sha256"
log "dump ok: $(numfmt --to=iec "$SIZE_BYTES"), ${TABLE_COUNT} tables, sha256 $(cat "${DUMP}.sha256")"

# Upload. The bucket's own lifecycle rule handles long-term retention (§1.2), so
# nothing here deletes anything remote — a bug in this script must not be able to
# remove backups.
DEST="${GCS_BUCKET%/}/daily/${BASENAME}.dump"
gcloud storage cp "$DUMP"            "$DEST"            --quiet
gcloud storage cp "${DUMP}.sha256"   "${DEST}.sha256"   --quiet
log "uploaded ${DEST}"

# Read it back and compare. An upload that reported success and stored something
# else is the failure mode that makes people trust a backup they do not have.
REMOTE_SHA="$(gcloud storage hash "$DEST" --hex 2>/dev/null | awk '/md5/ {print $2}')"
LOCAL_MD5="$(md5sum "$DUMP" | awk '{print $1}')"
if [ -n "$REMOTE_SHA" ] && [ "$REMOTE_SHA" != "$LOCAL_MD5" ]; then
  fail "uploaded object md5 ${REMOTE_SHA} does not match local ${LOCAL_MD5}"
fi
log "upload verified"

# Local pruning only. Remote pruning is the bucket lifecycle policy's job.
find "$BACKUP_DIR" -name 'voltava_fleet_*.dump*' -mtime "+${LOCAL_RETENTION_DAYS}" -print -delete

log "backup complete: ${BASENAME}"
