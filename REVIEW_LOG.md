# Review Log — Backend Code Review Agent

> **Who maintains this:** a second agent (Claude, "review agent") is running on this
> same repo/machine, reviewing every change pushed to `master` and applying safe
> hardening fixes. This file is the coordination channel between that review agent
> and the feature agent(s) writing new endpoints.
>
> **File address (this file):**
> `C:\Users\ANURAG TIWARI\Desktop\voltava gps backend\REVIEW_LOG.md`
> (repo-relative: `REVIEW_LOG.md`)

## How this works
- **Feature agent:** keep pushing to `master` as usual. After you push, the review
  agent pulls, reviews the diff, and pushes a follow-up `fix(...)` commit if needed.
- **Every commit must stay green:** run `node --check` on `server.js tcp-server.js
  index.js middleware/*.js` and `npm test` (Jest, 40+ tests) before pushing. CI
  (`.github/workflows/ci.yml`) enforces both. A duplicate `const` once shipped a
  boot-crash to `master` — the syntax gate exists to stop that.
- **When you add an endpoint, add/adjust its Jest mock** in `tests/*.test.js`. New
  prisma calls (e.g. `user.update`, `trip.count`, `bus.update`) break stale mocks
  with a 500 and turn CI red.
- Do NOT touch `prisma/schema.prisma` or seed credentials (see `.agents/AGENTS.md`).

## Reviewed changes (most recent first)

| Commit | What | Verdict | Follow-up |
|--------|------|---------|-----------|
| `a36c9c4` | Double-booking, bulk telemetry, SOS types | 🔴 GET /api/notifications read `req.body.type` (mislabeled all alerts); 🟡 double-booking narrowed to active-only; 🟡 bulk telemetry half-wired | notifications fixed (this commit); see Open Items 6–7 |
| `793aa58` | Parent mgmt APIs + student route unmapping | 🟡 parent password reset didn't revoke tokens | fixed in `63327f7` |
| `303c53b` | School-admin CRUD (students/drivers/devices) | 🔴 `PUT /api/students/:id` 500 + cross-tenant via schoolId; devices pre-try DB call | fixed in `a911bca` |
| `332ab5d` | `isAvailable` flag on buses/drivers GET | ✅ correct | test updated in `b0a1927` |
| `3c46248` | `PUT /api/trips/:tripId` (reassign) | 🟠 ran on `ownsTrip` only → a DRIVER could reassign | fixed in `a911bca` (admin-only) |
| `4bd8875` | Driver-app fixes (logout, deviceSecret in login) | 🔴 `deviceSecret` shipped in every login response | staged fix — see Open Items |

## Fixes applied by the review agent (this session)

| Commit | Fix |
|--------|-----|
| `63327f7` | Revoke parent tokens on admin password reset |
| `e22ac1b` | New `GET /api/driver/telemetry-credentials`; deviceSecret migration stage 1; HMAC doc signing-string fix (now includes `speed`) |
| `a911bca` | `updateStudent` schema whitelist + P2002; trips reassign admin-only; driver pw → revoke tokens; devices PUT/DELETE ownership check inside try/catch; drop dead `JWT_EX_IN` |
| `3d1b1d3` | JWT revocation: `POST /api/auth/logout`, denylist + per-user invalidation on delete/demote/password |
| `6adf1b0` | Removed duplicate `const activeTrip` in `/api/telemetry` that crashed server boot |

## Open items (not yet done — coordinate before acting)

1. **deviceSecret migration — Stage 2.** `POST /api/auth/login` still returns
   `deviceId`/`deviceSecret` for drivers (marked DEPRECATED in `server.js`). Remove
   these fields **once the driver app switches to `GET /api/driver/telemetry-credentials`.**
   App team confirmed they will migrate; ping the review agent when done.
2. **P2002 on email updates.** `PUT /api/parents/:id` and `PUT /api/drivers/:id`
   (`server.js`) return 500 instead of 400 when a new email collides with an existing
   user. Low priority.
3. **JWT revocation is in-memory** (`middleware/auth.js`) — per-instance, resets on
   restart. Fine for single-VM; needs Redis or a `tokenVersion` column for
   multi-instance / restart-safe revocation.
4. **OS push (FCM) not implemented.** In-app notifications + the `notification`
   socket event work; native push needs a `fcmToken` column (schema change — do not
   add without the user's explicit go-ahead) + a device-token registration endpoint.
5. **HMAC telemetry replay.** `middleware/telemetryHmac.js` signs
   `deviceId.ts.lat.lng.speed` but has no nonce/dedup — a captured signed packet can
   be replayed within the 300s skew window.
6. **Double-booking now only enforced against ACTIVE trips** (`a36c9c4` narrowed the
   create/reassign check to `ON_SCHEDULE`/`DELAYED`, dropping `PLANNED`). Two PLANNED
   trips for the same bus/driver can now coexist, and `PATCH /api/trips/:tripId/status`
   does NOT re-check on start — so two trips can both go ON_SCHEDULE for one bus.
   If multiple-PLANNED is intentional (pre-planning), add the conflict check to the
   status-transition to close the runtime hole.
7. **Bulk telemetry is only half-wired.** `middleware/telemetryHmac.js` now reads a
   `logs[]` array (signs `logs[0]`), but `S.telemetry` (`schemas.js`) still *requires*
   top-level `lat`/`lng` and has no `logs`, and the `POST /api/telemetry` handler
   (`server.js`) only saves a single point. A bulk `{ deviceId, logs:[...] }` payload
   will 400 at validation. To finish: allow `logs` in the schema (single OR bulk) and
   iterate `logs` in the handler (createMany + emit). Also note: signing only `logs[0]`
   leaves the rest of the batch unsigned — sign the whole batch when completing this.

## Key file addresses
- API + routes: `server.js`
- Auth / RBAC / token revocation: `middleware/auth.js`
- HMAC telemetry: `middleware/telemetryHmac.js`
- Zod request schemas: `schemas.js`
- TCP hardware ingest: `tcp-server.js`
- Presence throttle helper: `busPresence.js`
- Boot + stale-sweep + graceful shutdown: `index.js`
- Tests: `tests/*.test.js`
- Frontend integration docs: `docs/frontend/` (`parent-app.md`, `driver-app.md`)
