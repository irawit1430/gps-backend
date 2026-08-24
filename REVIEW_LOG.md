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
| `71c266d` | CSV bulk import, broadcast, self-profile | 🔴 broadcast wrote `routeId` (not an EmergencyAlert column → 500); 🟡 `PUT /api/users/me` pw change didn't revoke tokens; 🔴 bulk import hardcodes parent pw `password123` | broadcast + users/me fixed (this commit); bulk pw = Open Item 8 |
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
| _(uncommitted)_ | **Live map snap-back:** TCP ingest broadcast history/no-fix packets as live `location_update`s. Added `liveFixGuard.js` (per-bus newest-fix watermark, future-clock clamp) + `isLive`/`gpsFix` gate in `tcp-server.js`; same guard on `POST /api/telemetry`. History points are still persisted, just not broadcast |
| _(uncommitted)_ | **Hardware SOS spam:** a latched panic button minted one ACTIVE alert per packet, and stored/replayed packets re-raised old ones. Added a 5-min per-bus cooldown + replay skip in `tcp-server.js` |
| _(uncommitted)_ | `emitToSchool` emitted twice into `school:<id>` and `super:all` — a SUPER_ADMIN with a schoolId received every event twice. Now one emit across both rooms |
| _(uncommitted)_ | Stale-bus sweep (`index.js`) now emits `device_status_change` OFFLINE per bus, so dashboards see a bus go dark without a reload |
| _(uncommitted)_ | P2002 → 500 on `POST /api/schools/:id/drivers`, `POST /api/devices`, `POST`/`PUT /api/admins`, and bulk student import. All now 400 with a usable message |
| _(uncommitted)_ | `GET /api/schools?sort=<col>` 500'd on any unknown column — now a 400 with the allowed list |
| _(uncommitted)_ | **Online/offline dot flapping:** nothing ever emitted a `device_status_change` ONLINE — the sweep announced only the OFFLINE edge, so a dimmed bus never lit back up over socket. Added `busPresence.js`: shared status-write throttle + OFFLINE→ONLINE edge, announced from both ingest paths; sweep calls `markOffline()` |
| _(uncommitted)_ | The status-write throttle never engaged on `POST /api/telemetry` with HMAC on (marker was kept on a per-request row object) — a `bus.update` ran on every packet. Now held in `busPresence` |
| _(uncommitted)_ | `liveFixGuard` rejected equal timestamps, so a TM-100 reusing its last fix time punched gaps into the live stream. Only strictly older fixes are dropped now |
| _(uncommitted)_ | `PUT /api/devices/:id` announced status ONLINE on any edit — now reports the device's actual status |
| _(uncommitted)_ | **OOM restart loop** (pm2 killed the process at 512M every 1–4 min in prod, dropping every socket → dashboards flapped online/offline). Both admin-stats "active devices" queries pulled every GpsLog row in the window into JS (Prisma applies `distinct` in memory) — replaced with `groupBy` (DB-side) and bounded the window with `lte: now` so a future-dated device clock cannot make the filter match the whole table |
| _(uncommitted)_ | **deviceSecret leak:** `GET /api/schools/:id/buses` spread the whole Bus row, and `bus: true` in `GET /api/drivers/:driverId/trips`, `GET /api/schools/:id/drivers` and `/api/search` carried the HMAC secret to every admin and driver client. All field-selected now |
| _(uncommitted)_ | `GET /api/drivers/:driverId/trips` (the driver app's poll endpoint — ~6× the traffic of anything else in prod logs) pulled unbounded `attendanceLogs` and whole student rows on every poll. Scoped to today's logs + the fields `docs/frontend/driver-app.md` §2 documents |
| _(uncommitted)_ | Open Item 6 closed: `PATCH /api/trips/:tripId/status` re-checks bus/driver conflict before ON_SCHEDULE/DELAYED |
| _(uncommitted)_ | Open Item 8 closed: bulk student import generates a random temp password per parent and returns `parentCredentials[]` (was the shared literal `password123`) |

## Open items (not yet done — coordinate before acting)

1. **deviceSecret migration — Stage 2.** `POST /api/auth/login` still returns
   `deviceId`/`deviceSecret` for drivers (marked DEPRECATED in `server.js`). Remove
   these fields **once the driver app switches to `GET /api/driver/telemetry-credentials`.**
   App team confirmed they will migrate; ping the review agent when done.
2. ~~**P2002 on email updates.**~~ ✅ RESOLVED in `c55f6e5` — parents/drivers/users
   PUT now return 400 "Email already in use" on a duplicate-email collision.
3. **JWT revocation is in-memory** (`middleware/auth.js`) — per-instance, resets on
   restart. Fine for single-VM; needs Redis or a `tokenVersion` column for
   multi-instance / restart-safe revocation.
4. **OS push (FCM) not implemented.** In-app notifications + the `notification`
   socket event work; native push needs a `fcmToken` column (schema change — do not
   add without the user's explicit go-ahead) + a device-token registration endpoint.
5. **HMAC telemetry replay.** `middleware/telemetryHmac.js` signs
   `deviceId.ts.lat.lng.speed` but has no nonce/dedup — a captured signed packet can
   be replayed within the 300s skew window.
6. ~~**Double-booking only enforced against ACTIVE trips.**~~ ✅ RESOLVED (uncommitted) —
   `PATCH /api/trips/:tripId/status` now re-checks for a conflicting ON_SCHEDULE/DELAYED
   trip on the same bus or driver before starting. Multiple PLANNED trips are still
   allowed by design; only one of them can go live.

7. **Bulk telemetry is only half-wired.** `middleware/telemetryHmac.js` now reads a
   `logs[]` array (signs `logs[0]`), but `S.telemetry` (`schemas.js`) still *requires*
   top-level `lat`/`lng` and has no `logs`, and the `POST /api/telemetry` handler
   (`server.js`) only saves a single point. A bulk `{ deviceId, logs:[...] }` payload
   will 400 at validation. To finish: allow `logs` in the schema (single OR bulk) and
   iterate `logs` in the handler (createMany + emit). Also note: signing only `logs[0]`
   leaves the rest of the batch unsigned — sign the whole batch when completing this.
8. ~~**Bulk student import gives every parent the password `password123`.**~~
   ✅ RESOLVED (uncommitted) — bulk now mirrors the single-student flow: a random
   temp password per newly created parent, `mustResetPassword: true`, and the
   plaintext returned once in `parentCredentials[]` on the import response.
   **Frontend impact:** the CSV-import screen should surface that list to the admin;
   parents imported before this change still hold `password123` and should be reset.

## Key file addresses
- API + routes: `server.js`
- Auth / RBAC / token revocation: `middleware/auth.js`
- HMAC telemetry: `middleware/telemetryHmac.js`
- Zod request schemas: `schemas.js`
- TCP hardware ingest: `tcp-server.js`
- Presence throttle + online-edge helper: `busPresence.js`
- Live-fix watermark (anti snap-back): `liveFixGuard.js`
- Boot + stale-sweep + graceful shutdown: `index.js`
- Tests: `tests/*.test.js`
- Frontend integration docs: `docs/frontend/` (`parent-app.md`, `driver-app.md`)
