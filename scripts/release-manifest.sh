#!/usr/bin/env bash
# One release is five repositories. This records exactly which commit of each was
# tested together, runs each one's own checks, and writes the result to
# docs/releases/<date>-<backend sha>.md. A test file in a repo is not a passing run;
# this file is.
#
#   scripts/release-manifest.sh                     # repos next to this one
#   SCHOOL=../school- DRIVER=../voltava-drive ... scripts/release-manifest.sh
#
# Optional: E2E_DATABASE_URL and E2E_TARGET run e2e/onboarding-desk-test.js against a
# server started from this backend on a scratch database (see that file).
set -uo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="${BACKEND:-$here}"
SCHOOL="${SCHOOL:-$here/../school-}"
SUPERADMIN="${SUPERADMIN:-$here/../voltava-superadmin-dashboard}"
PARENT="${PARENT:-$here/../voltava-parent-app}"
DRIVER="${DRIVER:-$here/../voltava-drive}"

results=()
failed=0
run() { # name dir command...
  local name="$1" dir="$2"; shift 2
  local log; log="$(mktemp)"
  if (cd "$dir" && "$@") >"$log" 2>&1; then
    results+=("| $name | pass | $(grep -Eo 'Tests:? +[0-9]+ passed[^|]*|[0-9]+ steps passed|[0-9]+ passed' "$log" | tail -1) |")
  else
    results+=("| $name | **FAIL** | see output below |")
    failed=1
    echo "---- $name failed ----"; tail -40 "$log"
  fi
  rm -f "$log"
}

sha() { git -C "$1" rev-parse HEAD; }
dirty() { [ -n "$(git -C "$1" status --porcelain)" ] && echo " (uncommitted changes!)" || true; }

run "backend: unit tests" "$BACKEND" npx jest --ci --silent
run "school dashboard: types" "$SCHOOL" npx tsc --noEmit
run "school dashboard: lint" "$SCHOOL" npx eslint . --max-warnings 0
run "school dashboard: unit tests" "$SCHOOL" npx vitest run
run "school dashboard: build" "$SCHOOL" npx next build
run "super admin: types" "$SUPERADMIN" npx tsc --noEmit
run "super admin: unit tests" "$SUPERADMIN" npx vitest run
run "super admin: build" "$SUPERADMIN" npx vite build
run "parent app: types" "$PARENT" npx tsc --noEmit
run "parent app: unit tests" "$PARENT" npx jest --ci --silent
run "driver app: types" "$DRIVER" npx tsc --noEmit
run "driver app: unit tests" "$DRIVER" npx jest --ci --silent
if [ -n "${E2E_DATABASE_URL:-}" ] && [ -n "${E2E_TARGET:-}" ]; then
  run "end to end: onboarding desk test" "$BACKEND" env DATABASE_URL="$E2E_DATABASE_URL" TARGET="$E2E_TARGET" node e2e/onboarding-desk-test.js
fi

# Read before this run writes its own file into the backend tree.
flags=(); for repo in "$BACKEND" "$SCHOOL" "$SUPERADMIN" "$PARENT" "$DRIVER"; do flags+=("$(dirty "$repo")"); done

mkdir -p "$BACKEND/docs/releases"
out="$BACKEND/docs/releases/$(date -u +%Y-%m-%d)-$(git -C "$BACKEND" rev-parse --short HEAD).md"
{
  echo "# Release manifest $(date -u +'%Y-%m-%d %H:%M UTC')"
  echo
  echo "Tested together. Deploy these exact commits, or run this again."
  echo
  echo "| Product | Repository | Commit |"
  echo "|---|---|---|"
  echo "| Backend | irawit1430/gps-backend | \`$(sha "$BACKEND")\`${flags[0]} |"
  echo "| School dashboard | irawit1430/school- | \`$(sha "$SCHOOL")\`${flags[1]} |"
  echo "| Super admin | irawit1430/voltava-superadmin-dashboard | \`$(sha "$SUPERADMIN")\`${flags[2]} |"
  echo "| Parent app | irawit1430/voltava-parent-app | \`$(sha "$PARENT")\`${flags[3]} |"
  echo "| Driver app | irawit1430/voltava-drive | \`$(sha "$DRIVER")\`${flags[4]} |"
  echo
  echo "| Check | Result | Detail |"
  echo "|---|---|---|"
  printf '%s\n' "${results[@]}"
  echo
  if [ "$failed" = 0 ]; then echo "**All checks passed.**"; else echo "**Some checks failed. Do not release.**"; fi
} >"$out"
echo "Wrote $out"
exit "$failed"
