#!/usr/bin/env bash
#
# Voltava Fleet — restore drill.
#
# An untested backup is not a backup. This downloads the newest dump from the
# bucket, restores it into a throwaway database, counts the rows in the tables a
# school would miss, and drops the scratch database again.
#
# It answers three questions a green backup job cannot:
#   1. Does the object in the bucket actually restore?
#   2. Does it contain data, or did it faithfully back up an empty database?
#   3. How long does a restore take? That number is the RTO; guessing it is how
#      an outage becomes an afternoon.
#
# Run it monthly from the timer, and by hand after any schema migration.
#
# Usage:  restore-drill.sh                 (newest daily dump)
#         restore-drill.sh gs://bucket/daily/voltava_fleet_20260916T210000Z.dump

set -Eeuo pipefail

ENV_FILE="${BACKUP_ENV:-/etc/voltava/backup.env}"
# shellcheck disable=SC1090
[ -r "$ENV_FILE" ] && . "$ENV_FILE"

: "${PGHOST:=localhost}"
: "${PGPORT:=5432}"
: "${PGUSER:=voltava}"
: "${GCS_BUCKET:?GCS_BUCKET is required}"
: "${DRILL_DB:=voltava_restore_drill}"
: "${WORK_DIR:=/var/tmp/voltava-drill}"

log()  { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { log "RESTORE DRILL FAILED: $*" >&2; exit 1; }
trap 'fail "aborted at line $LINENO"' ERR

SOURCE="${1:-}"
if [ -z "$SOURCE" ]; then
  log "finding newest dump in ${GCS_BUCKET%/}/daily/"
  SOURCE="$(gcloud storage ls "${GCS_BUCKET%/}/daily/*.dump" | sort | tail -n1)"
  [ -n "$SOURCE" ] || fail "no dumps found in ${GCS_BUCKET%/}/daily/"
fi
log "drilling ${SOURCE}"

mkdir -p "$WORK_DIR"
LOCAL="${WORK_DIR}/$(basename "$SOURCE")"
gcloud storage cp "$SOURCE" "$LOCAL" --quiet

# Checksum, if the sidecar is there.
if gcloud storage cp "${SOURCE}.sha256" "${LOCAL}.sha256" --quiet 2>/dev/null; then
  EXPECT="$(cat "${LOCAL}.sha256")"
  ACTUAL="$(sha256sum "$LOCAL" | awk '{print $1}')"
  [ "$EXPECT" = "$ACTUAL" ] || fail "checksum mismatch: expected ${EXPECT}, got ${ACTUAL}"
  log "checksum ok"
fi

cleanup() {
  psql --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" --dbname=postgres \
    -v ON_ERROR_STOP=0 -qc "DROP DATABASE IF EXISTS \"${DRILL_DB}\";" >/dev/null 2>&1 || true
  rm -f "$LOCAL" "${LOCAL}.sha256"
}
trap 'cleanup; fail "aborted at line $LINENO"' ERR
trap cleanup EXIT

psql --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" --dbname=postgres \
  -v ON_ERROR_STOP=1 -qc "DROP DATABASE IF EXISTS \"${DRILL_DB}\";"
psql --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" --dbname=postgres \
  -v ON_ERROR_STOP=1 -qc "CREATE DATABASE \"${DRILL_DB}\";"

log "restoring into ${DRILL_DB}"
START="$(date +%s)"
# --exit-on-error so a half-restored database cannot report success. -j uses the
# spare cores; on a 2-vCPU e2-medium leave it at 2.
pg_restore --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" \
  --dbname="$DRILL_DB" --no-owner --no-privileges --exit-on-error \
  --jobs="${RESTORE_JOBS:-2}" "$LOCAL"
ELAPSED=$(( $(date +%s) - START ))
log "restore finished in ${ELAPSED}s  ← this is your RTO for a full logical restore"

# Sanity counts. A backup that restores cleanly but holds nothing is the quiet
# failure this is here to catch — it is exactly what a backup of the wrong
# database, or of a database before the migration ran, looks like.
log "row counts in the restored copy:"
psql --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" --dbname="$DRILL_DB" \
  -v ON_ERROR_STOP=1 --pset=footer=off -c '
    SELECT  (SELECT count(*) FROM "School")        AS schools,
            (SELECT count(*) FROM "User")          AS users,
            (SELECT count(*) FROM "Student")       AS students,
            (SELECT count(*) FROM "Bus")           AS buses,
            (SELECT count(*) FROM "Route")         AS routes,
            (SELECT count(*) FROM "Trip")          AS trips,
            (SELECT count(*) FROM "AttendanceLog") AS attendance,
            (SELECT count(*) FROM "GpsLog")        AS gps_logs;'

SCHOOLS="$(psql --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" --dbname="$DRILL_DB" \
  -tAc 'SELECT count(*) FROM "School";')"
[ "$SCHOOLS" -ge 1 ] || fail "restored database has no schools — this backup is not usable"

# The migration history has to come back too, or the next `migrate deploy`
# against a restored database re-runs migrations that are already applied.
MIGRATIONS="$(psql --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" --dbname="$DRILL_DB" \
  -tAc "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;" 2>/dev/null || echo 0)"
[ "$MIGRATIONS" -ge 1 ] || fail "_prisma_migrations is empty in the restored copy — a restore would desync Prisma's history"
log "migration history intact: ${MIGRATIONS} applied"

log "RESTORE DRILL PASSED — ${SOURCE} restored in ${ELAPSED}s with ${SCHOOLS} schools"
