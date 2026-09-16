# Voltava Fleet — Full System Documentation & Production-Readiness Report

**Written:** 16 September 2026
**Covers:** `irawit1430/gps-backend` (the server) and `irawit1430/school-` (the school admin website)
**Language:** plain English. No prior knowledge of the code assumed.

---

## Part 0 — The one-line answer

**This is good code that is not yet running on a production-grade setup.** The
applications are built; the operational half of production — backups, alerting,
redundancy, deploys — has not been started.

| Question | Answer |
|---|---|
| Is the code well written? | Yes, mostly. 105 API endpoints, 225 automated tests, all passing. |
| Can it go live tomorrow for 1–3 schools with someone watching it? | Yes, with the fixes in Part 8 §A. |
| Can it go live for the 10–50 schools / 500 buses the deploy plan targets? | **No.** See Part 7. |
| What is the single biggest problem? | **There is no database backup.** If the one server dies, every record is gone. |
| What is the second biggest? | **The hardware port authenticates nothing** — a known IMEI is the whole credential. |

**Overall readiness: roughly 65%.** Detailed scoring in Part 6.
**How to fix everything in this report:** `docs/OPERATIONS_FIXES.md`.

> **Correction, 16 Sep 2026.** An earlier version of this report listed "two of the
> four apps do not exist" as the second-biggest problem, because
> `docs/frontend/OVERVIEW.md` lists the Super Admin, Parent and Driver repos as
> **TBD**. The owner has confirmed those apps are built — they live outside the two
> repositories this audit could read. That finding is withdrawn, and the product
> completeness score is revised accordingly. `docs/frontend/OVERVIEW.md` should be
> updated with the real repo names so the table stops saying otherwise.

---

## Part 1 — What this product actually is

Voltava Fleet is a **school bus tracking system for India**. A school buys it so that:

- the school office can see every bus on a live map,
- parents can see where their child's bus is and get a message when the child gets on or off,
- drivers can run their trips, mark attendance, and press an SOS button,
- one central "super admin" can manage many schools from one place.

It is **multi-tenant**: one server holds many schools, and one school must never be
able to see another school's children, buses or drivers.

### The four apps

| App | Who uses it | Screens | Status |
|---|---|---|---|
| **School Admin** (web) | School transport office | 12 | ✅ Built — the `school-` repo, audited here |
| **Super Admin** (web) | Voltava staff | 11 | ✅ Built — repo outside this audit's scope |
| **Parent** (mobile) | Parents | 7 | ✅ Built — repo outside this audit's scope |
| **Driver** (mobile) | Bus drivers | 7 | ✅ Built — repo outside this audit's scope |

Only the two repositories in this audit's scope — `gps-backend` and `school-` — were
read and run. The other three apps are reported as built by the owner and were not
inspected, so nothing in this report speaks to their quality.

⚠️ `docs/frontend/OVERVIEW.md` still lists those three repos as **TBD**. That table is
stale, and it is how this audit reached the wrong conclusion on its first pass. Fix it.

---

## Part 2 — How the system works, step by step

### 2.1 The pieces

```
  GPS tracker in the bus (Blackbox TM-100)
        │  sends a text packet every ~8 seconds over the mobile network
        │  raw TCP → port 5000
        ▼
  ┌──────────────────────────────────────────────────┐
  │  ONE Node.js process on ONE Google Cloud VM      │
  │                                                  │
  │   • TCP listener  (port 5000) — hardware GPS     │
  │   • HTTP REST API (port 3000) — all the apps     │
  │   • Socket.IO     (port 3000) — live push        │
  └──────────────────────────────────────────────────┘
        │                    │                  │
        ▼                    ▼                  ▼
   PostgreSQL          Firebase              nginx
   (same VM)           (optional mirror      (HTTPS + certificate)
                        + phone push)             │
                                                  ▼
                                    School Admin website
                                    (static files on Firebase Hosting)
```

Everything — the web API, the live socket connection and the GPS hardware listener —
runs inside **a single process on a single machine**. There is no second copy.

### 2.2 A bus position, from tracker to screen

1. The tracker sends a line of text to port 5000.
2. `blackbox-parser.js` reads it and pulls out IMEI, latitude, longitude, speed, time.
3. The server looks up which bus has that IMEI. Unknown IMEI → the packet is dropped.
4. `gpsWriteGate.js` decides whether to save the point to the database.
   A parked bus with no trip running is saved at most once every 5 minutes instead of
   every 8 seconds. (This was measured: 99.97% of stored rows were useless parked
   points, about 1.26 GB a day at 500 buses — the disk is only 28.9 GB.)
5. `liveFixGuard.js` checks the point is not older than the last one sent. This stops
   the map marker from jumping backwards when a tracker replays old stored data.
6. `busPresence.js` flips the bus to ONLINE if it was OFFLINE, and tells the dashboards.
7. The position is pushed over Socket.IO **only to the people allowed to see it** —
   that school's admins, and the parents whose children are on that trip
   (`positionAudience.js`).
8. Optionally mirrored into Firebase Firestore.

### 2.3 A school day, as the system models it

- A **Route** is a named path with ordered **Stops**.
- A **Run** is a repeating schedule: "Morning A, to school, 07:15, Mon–Fri, from 1 June
  to 31 March, this bus, this driver".
- Every 4 hours the server turns the next 3 days of Runs into actual **Trips**
  (`materialiseRuns.js`). It also does this once at boot, so a server that was off
  overnight catches up.
- **Exceptions** and a **school calendar** handle holidays, exam days and closures, so
  a trip is not created for a day the school is shut.
- A **Trip** goes PLANNED → ON_SCHEDULE → COMPLETED (or DELAYED / CANCELLED).
- When a child boards, an **AttendanceLog** row is written (BOARDED / ALIGHTED /
  NO_SHOW), tagged as a real scan or a manual office correction.
- Parents get a notification; the child's parent is found through
  **StudentRouteMapping** (which stop the child uses, and whether that stop is for
  pick-up, drop-off, or both).

### 2.4 Identifying a child

Originally RFID cards. Now there is a **QR system** as well:

- Each student gets a secret `qrToken`.
- The token never leaves the server except at card-printing time.
- The driver's roster carries only a **SHA-256 hash** of the token, so a driver's phone
  can check a card offline without ever holding the secret that would let it forge one.
- A school that already prints its own ID cards can import its existing codes instead
  of reprinting 600 cards.

That is a genuinely well-designed piece of work.

### 2.5 Emergencies

- A driver presses SOS in the driver app → `POST /api/driver/emergency`.
- A hardware panic button sets a flag on the GPS packet → the TCP listener raises one.
- Hardware SOS has a **5-minute per-bus cooldown**, because a latched panic button
  sets the flag on *every* packet and would otherwise create hundreds of alerts.
- Alerts go instantly over Socket.IO to that school's admins and to super admins.

---

## Part 3 — The complete list of what has been built (server)

**105 HTTP endpoints.** Grouped in plain terms:

| Area | What you can do |
|---|---|
| Login & accounts | Log in, change password, log out, forgot-password (admin-approved), my profile, register phone for push |
| Schools | Create / list / edit / delete schools (super admin) |
| Buses & devices | Add buses, attach GPS devices, see live locations, rotate a device's secret key |
| Drivers | Add, edit, delete drivers; a driver sees their own trips |
| Students | Add, edit, delete; **bulk CSV import**; search |
| Parents | Add, edit; link parent to child; parent notification preferences |
| Routes & stops | Create routes, add/reorder/edit/delete stops |
| Runs & schedules | Recurring run schedules, exceptions, schedule preview |
| Calendar | School holidays and closures |
| Trips | Create, reassign, start, delay, complete, cancel |
| Attendance | Record boarding / alighting / no-show; today's attendance; per-child history |
| QR cards | Generate, print, import existing codes, look up a scanned code |
| Leaves | Parent applies, school approves or rejects |
| Alerts | Driver SOS, hardware SOS, admin broadcast, delay notices |
| Notifications | List, mark read, resolve |
| Telemetry | HTTP position upload (signed) and raw TCP from hardware |
| Admin | Stats dashboards, system logs, global search, settings, manage admins |
| Health | `/healthz`, `/readyz` |

### Data model — 18 tables

`User` · `School` · `Bus` · `Route` · `RouteStop` · `Run` · `RunException` ·
`CalendarDay` · `Student` · `StudentRouteMapping` · `Trip` · `GpsLog` ·
`AttendanceLog` · `LeaveApplication` · `PasswordResetRequest` · `EmergencyAlert` ·
`Notification` · `GlobalSettings`

There are **10 database migrations**, applied in order. The schema is well commented —
several comments explain *why* a column exists and what bug it prevents. That is
unusually good practice.

---

## Part 4 — What I checked, and what I found (hard evidence)

Everything below I ran myself in a clean checkout on 16 Sep 2026.

### 4.1 Backend — GOOD ✅

| Check | Result |
|---|---|
| `npm ci` | ✅ clean install |
| `npx prisma generate` | ✅ success |
| `npm test` (Jest) | ✅ **33 suites, 225 tests, all pass, ~12 seconds** |
| Syntax check of every file | ✅ enforced by CI |
| CI pipeline | ✅ exists — `.github/workflows/ci.yml`, runs install + syntax + tests |

**But:** every test replaces the database with a fake (`jest.mock('@prisma/client')`).
So the tests prove the *logic and the permission rules* are right. They prove **nothing**
about whether the real SQL queries work, whether the migrations apply cleanly, or whether
an index is missing. There is **no integration test against a real PostgreSQL**.

### 4.2 School Admin website — MIXED ⚠️

| Check | Result |
|---|---|
| `npm ci` | ✅ clean |
| `npx tsc --noEmit` (type check) | ✅ **zero type errors** |
| `npm run build` | ✅ builds, 12 pages, ~103 kB shared JS — a healthy size |
| `npx vitest run` | ❌ **all 18 test files fail to even start** |
| `npx playwright test --config playwright.unit.config.ts` | ⚠️ 35 logic tests pass; 2 browser tests could not run here (no browser installed in this container) |
| `npx eslint .` | ❌ **10 errors, 9 warnings** |
| CI pipeline | ❌ **none — there is no `.github` folder at all** |

**Why the tests fail:** `vitest.setup.ts` imports `@testing-library/jest-dom`, and that
package **is not listed in `package.json`**. On the developer's own machine it is
probably installed left over from something else. On a fresh checkout — which is what a
new developer, a new laptop, or any CI server gets — every single frontend test dies with:

```
Error: Failed to resolve import "@testing-library/jest-dom" from "vitest.setup.ts"
```

So ~41 component and API tests that somebody wrote have been **silently not running**.

**The ESLint errors** are real React correctness warnings (calling `setState` directly
inside an effect, reading a ref during render, an impure call during render) in
`app/(dashboard)/layout.tsx`, `Header.tsx`, `RealMap.tsx`, `RouteMapEditor.tsx`,
`BusesList.tsx` and `EditTripModal.tsx`. They cause extra re-renders and occasional
flicker rather than outright breakage. Two more are in dead backup files.
Note that `next.config.ts` sets `eslint.ignoreDuringBuilds: true`, so the build never
shows them.

### 4.3 Dependency security

**Backend — 9 known vulnerabilities (2 high, 7 moderate):**

| Severity | Package | Issue |
|---|---|---|
| High | `nodemailer` | 4 issues, including recipient-domain validation bypass (mail could be sent to an attacker's domain) |
| High | `brace-expansion` | denial of service via memory exhaustion |
| Moderate | `qs` (via express) | denial of service |
| Moderate | `firebase-admin` → `@google-cloud/storage` → `uuid` | chain of moderate issues |

**Frontend — 8 known vulnerabilities (1 critical, 3 high):**

| Severity | Package | Issue |
|---|---|---|
| **Critical** | `next` 15.5.23 | unauthenticated RCE on Windows-hosted servers; RCE in image optimisation |
| High | `sharp`, `postcss`, `fast-uri` | image library and CSS parser issues |

**Important nuance, so this is not overstated:** the school dashboard is built with
`output: 'export'` — it ships as plain HTML/JS files on Firebase Hosting with
`images.unoptimized: true`. There is **no Next.js server running in production**, so the
critical Next.js server-side RCEs do not apply to the live site. They still apply to any
developer running `next dev`, and to the build machine. It should still be upgraded.

### 4.4 Repository hygiene — POOR ⚠️ (frontend)

26 files that should never have been committed are tracked in `school-`:

```
fix.py  fix_api.py  fix_fetch.py  fix_fetch_notifs.py  fix_remaining.py
fix_route_editor.py  mass_refactor.py  patch_student.py  replace_logo.py
replace_logo_real.py  revert_notifs.py  patch-manage-routes.js  patch-map-editor.js
map_editor_backup.tsx  map_editor_backup_utf8.tsx  map_old.tsx  middleware.ts.bak
map_fragment.txt  map_fragment2.txt  replace_1034.txt  replace_1185.txt
replace_1248.txt  target_1214.txt  target_1248.txt
test-search.js  test-search2.js  playwright-report/index.html
```

`map_editor_backup.tsx` is not even valid text (ESLint reports "File appears to be
binary"). `test-search.js` and `test-search2.js` still point at the **old Render URL**
(`gps-backend-jzd7.onrender.com`), as does one test file. None of this breaks the
running app; all of it makes the repository confusing and makes lint permanently red.

---

## Part 5 — Security: what is strong, what is not

### 5.1 Strong ✅

- **Passwords** are hashed with bcrypt. Login compares against a dummy hash when the
  user does not exist, so an attacker cannot tell a real email from a fake one by timing.
- **JWT tokens**, HS256 only, 24-hour expiry, secret must be at least 32 characters or
  the server refuses to boot.
- **Token revocation exists** — logout, account deletion, role change and password
  change all invalidate existing tokens, and **also disconnect that user's live sockets**.
  Many products get this wrong; this one does not.
- **Tenant isolation is enforced and tested.** `requireTenant()` blocks cross-school
  access; there are dedicated test files for it
  (`tenant-resource-integrity.test.js`, `privileged-route-authorization.test.js`,
  `devices-scoping.test.js`, `socket-authorization.test.js`).
- **Socket.IO requires a token** in the handshake, deliberately *not* in the URL
  (URLs end up in proxy and browser logs).
- **Position privacy** — a parent only receives positions for a trip their child is on.
- **Every request body is validated with Zod** before it reaches the database.
- **Rate limiting**: 5 login attempts per minute, 300 requests per minute overall,
  5 bulk imports per minute.
- **Helmet** security headers, a CORS allow-list, a 256 KB body cap.
- **`deviceSecret` leaks were hunted down and fixed** — it used to be returned in login
  responses and in several list endpoints. It no longer is.
- **HTTPS with HSTS** in the nginx config, TLS 1.2/1.3 only.
- The Docker image runs as a **non-root user**.

### 5.2 Weak — these are the real risks 🔴

**1. The TCP port has no authentication at all.**
`tcp-server.js:62` calls `parseBlackboxPacket(rawPacket)` — and `blackbox-parser.js`
defaults `verifyCrc` to **false**. So the checksum is never checked either. Anyone who
can reach port 5000 and knows or guesses a bus IMEI can:
- inject a fake position, moving a bus on every parent's map,
- raise a fake hardware SOS,
- write junk into the GPS history.

The HTTP telemetry endpoint is properly signed with HMAC. The hardware path is not.
The only protection is the firewall rule in `DEPLOY.md`, which the document itself
admits may end up as `0.0.0.0/0`.

**2. Signed telemetry can be replayed.**
`middleware/telemetryHmac.js` has no nonce and no de-duplication. A captured signed
packet can be replayed for 300 seconds. This is already written down as open item 5 in
`REVIEW_LOG.md`.

**3. One shared password can open every parent account.**
`PARENT_DEFAULT_PASSWORD` gives every parent account the same opening password so a
school can onboard 300 families with one line on a notice. The config file is admirably
honest about the consequences:
- one leaked notice opens every account created since the last rotation;
- `mustResetPassword` is **advisory only** — no middleware enforces it, so a parent who
  never changes it stays open forever;
- every one of those accounts shows **a child's live location**.

This is a deliberate, documented business decision, not an accident. It is still the
most serious privacy exposure in the product, and in India it sits under the DPDP Act's
rules on children's data.

**4. Token revocation is in-memory only.**
`middleware/auth.js` keeps the revocation list in a JavaScript `Set`. Restart the
server and every "revoked" token works again for the rest of its 24 hours. Fine on one
machine that rarely restarts; broken the moment there are two machines.

**5. Nine known dependency vulnerabilities on the server**, including a high-severity
`nodemailer` issue in a product that sends mail.

**6. The school dashboard's login check is client-side only.**
`app/(dashboard)/layout.tsx` checks for a token in `localStorage` and redirects if it is
missing. The real `middleware.ts` was disabled (renamed `.bak`) because a static export
cannot run middleware. This is **acceptable** — the pages contain no secrets, and the
API rejects every unauthenticated request — but it means the URL protection is cosmetic.

**7. The token is stored in `localStorage`**, which any cross-site-scripting bug can
read. Standard for this kind of dashboard, worth knowing.

---

## Part 6 — Readiness scorecard

| Area | Score | Why |
|---|---|---|
| **Backend code quality** | 8 / 10 | Clean structure, 225 passing tests, excellent comments explaining real bugs |
| **API completeness** | 9 / 10 | 105 endpoints; everything the four apps need |
| **Security — access control** | 8 / 10 | Tenant isolation, RBAC and revocation are all properly done and tested |
| **Security — everything else** | 4 / 10 | Unauthenticated TCP, replayable HMAC, shared parent password, 9 CVEs |
| **Testing — backend** | 6 / 10 | 225 tests, but 100% mocked. No test ever touches a real database |
| **Testing — frontend** | 2 / 10 | Test suite cannot start at all from a clean checkout |
| **Frontend code quality** | 6 / 10 | Types clean, builds clean, but 10 lint errors and 26 junk files |
| **Deployment & infrastructure** | 3 / 10 | One VM, one process, database on the same box, **no backups** |
| **Monitoring & alerting** | 3 / 10 | Good structured logs and health endpoints; no alerts, no error tracking |
| **Documentation** | 8 / 10 | `DEPLOY.md`, `REVIEW_LOG.md` and 1,825 lines of frontend API docs — genuinely strong |
| **Product completeness** | 8 / 10 | All four apps built; only two audited here |
| **Operational maturity** | 3 / 10 | Manual deploys, no rollback plan, no restore drill |

### **Overall: ~65% production-ready.**

Read that as: *the hard part is done and done well, the surrounding engineering is not.*

---

## Part 7 — Why it cannot yet do 10–50 schools / 500 buses

`DEPLOY.md` names that as the target. Here is what stands in the way.

**1. Everything is one process on one machine.**
If it crashes, dies, or the VM reboots, the whole product is down — API, live map, and
GPS ingest. There is no second instance and no load balancer.

**2. It cannot be scaled by adding a second server.** Four pieces of state live in
process memory and would immediately disagree between two copies:

| File | What it holds in memory |
|---|---|
| `middleware/auth.js` | revoked tokens |
| `busPresence.js` | which buses are online + write throttle |
| `liveFixGuard.js` | newest position per bus |
| `gpsWriteGate.js` | last saved time per bus |
| `express-rate-limit` | rate-limit counters |

Plus Socket.IO has no Redis adapter, so a client connected to server A would never
receive an event emitted by server B. `ecosystem.config.js` states this openly.

**3. There is no database backup.** This is the one I would fix first.
`DEPLOY.md` §10 says *"Cloud SQL automated backups + PITR are on"* — but the same
document's header says **Cloud SQL is no longer used** and Postgres now runs on the VM
itself to save money. I searched the entire repository: there is **no `pg_dump`, no
backup script, no snapshot schedule, nothing**. The documented backup refers to a
service that was switched off.

Today, losing that VM's disk means losing every school, student, parent, route,
attendance record and trip history permanently.

**4. The database shares a 4 GB VM with the application.** A busy morning run makes the
API and Postgres fight for the same CPU and the same memory. There is history here:
PM2 was killing the process every 1–4 minutes at a 512 MB limit until the admin-stats
queries were fixed and the ceiling was raised.

**5. Nobody would know it broke.** There is an uptime check on `/healthz` in the deploy
guide, but no alerting on error rates, no crash reporting (Sentry or similar), and no
dashboard. The `REVIEW_LOG.md` records a deploy that crash-looped **about 190 times
before anyone noticed** — because `curl -s` prints nothing on connection-refused, so the
outage looked like silence.

**6. Deploys are manual and have no rollback.**
`git pull && npm ci && npm run build && npm run migrate:deploy && pm2 reload`, typed by
hand over SSH. There is no staging environment, no automated deploy, and no documented
way to go back to the previous version if a release is bad.

**7. Disk maths at 500 buses.** The GPS write gate and the 30-day pruner (now in-process,
which is the right call — the old crontab was installed under a user that did not exist,
so `GpsLog` was **never pruned once** in the life of the deployment) fixed the immediate
problem. But the sums have not been re-run for 500 buses on a 30 GB disk. This needs a
real measurement before that many buses are connected.

---

## Part 8 — What to do, in order

### A. Before a single real school goes live 🔴

1. **Set up database backups.** `pg_dump` on a cron, pushed to a Google Cloud Storage
   bucket with versioning, kept 30 days. **Then restore one into a scratch database and
   confirm it works.** An untested backup is not a backup.
2. **Lock port 5000 to the SIM operator's IP ranges.** Do not leave it open to the world.
3. **Turn on CRC verification** in `tcp-server.js` — pass `{ verifyCrc: true }`. The code
   is already written; it is one argument.
4. **Decide about `PARENT_DEFAULT_PASSWORD` in writing.** Either leave it unset (each
   parent gets their own generated password), or enforce `mustResetPassword` in
   middleware so an unchanged password cannot be used to read a child's location.
5. **`npm audit fix`** on both repos, then re-run the tests.
6. **Add crash alerting** — Sentry or a Google Cloud Monitoring alert on the error-log
   rate — so the next 190-restart loop is noticed in minutes, not days.
7. **Confirm `TZ=Asia/Kolkata` applied**: `curl -i https://api.voltava.in/healthz` must
   report `utcOffsetMinutes: 330`. Every "today" boundary in the system depends on it.

### B. Within the first month 🟡

8. **Fix the frontend test suite** — add `@testing-library/jest-dom` and
   `@testing-library/react` to `package.json` devDependencies, run the ~41 tests that
   have never executed, fix whatever they find.
9. **Add CI to the `school-` repo** — install, typecheck, lint, test, build. The backend
   has this; the frontend has nothing.
10. **Delete the 26 junk files** and make `eslint` pass, then stop ignoring it in builds.
11. **Add integration tests** that run against a real PostgreSQL (a Docker service in CI
    is enough) to cover the paths mocks cannot: migrations, constraints, indexes.
12. **Write a rollback procedure** and test it once.
13. **Fix the HMAC replay hole** (open item 5) with a nonce or a seen-signature cache.
14. **Finish or remove bulk telemetry** (open item 7) — it is currently half-wired and a
    bulk payload fails validation.

### C. Before scaling past ~10 schools 🟢

15. **Move Postgres off the app VM** (Cloud SQL, or its own VM) and turn on managed
    backups and point-in-time recovery.
16. **Move shared state to Redis** — token denylist, presence, rate limits — and add the
    Socket.IO Redis adapter. Only then can you run two instances.
17. **Split the TCP listener into its own process**, so a hardware flood cannot take the
    dashboard down with it.
18. **Run two instances behind a load balancer.**
19. **Audit the other three apps** to the same standard as this one. Whatever is true
    of the school dashboard's dead test suite and missing CI is worth checking in the
    Parent, Driver and Super Admin repos before they carry real families.
20. **Load-test** at target scale: 500 buses × one packet per 8 seconds is about
    **62 packets per second, continuous**, plus every parent's phone holding a socket
    open during the morning and evening runs. Nobody has measured this yet.

---

## Part 9 — Credit where it is due

It is worth being clear that this is not a weak codebase. Several things are done better
than in most commercial products I have reviewed:

- `REVIEW_LOG.md` is an honest, dated record of every bug found and fixed, with the
  open items listed rather than hidden. Very few teams keep this.
- The comments explain **why** — the GPS write gate cites the actual measured row count
  (463,018 of 463,170 rows were useless); the timezone comment explains exactly why
  `TZ` in `.env` silently does nothing; the retention pruner explains that it lives
  in-process because the crontab was installed under a user that did not exist.
- The retention job, the run materialiser and the stale-bus sweep were all deliberately
  moved **into the application** rather than left as manual server setup — because a
  manual step is a step someone forgets. That is mature thinking.
- The QR design (hash on the driver's phone, secret on the server, import your existing
  cards) solves a real cost problem elegantly.
- Tenant isolation is not just claimed, it has its own test files.

The gap is not skill. The gap is that **the operational half of production — backups,
monitoring, redundancy, deployment — has not been built yet**, and two of the four
applications have not been started.

---

## Appendix — Quick reference

### Where things are (backend)

| File | Job |
|---|---|
| `index.js` | Boot, background jobs, graceful shutdown |
| `server.js` | All 105 API endpoints (4,412 lines) |
| `config.js` | Environment variables, validated at boot — bad config refuses to start |
| `tcp-server.js` | Hardware GPS listener on port 5000 |
| `blackbox-parser.js` | Decodes TM-100 packets |
| `middleware/auth.js` | Login check, roles, tenant isolation, token revocation |
| `middleware/socketAuth.js` | Socket.IO auth + room-scoped broadcasting |
| `middleware/telemetryHmac.js` | Signature check for HTTP telemetry |
| `middleware/validate.js` | Zod request validation |
| `schemas.js` | All request shapes |
| `busPresence.js` · `liveFixGuard.js` · `gpsWriteGate.js` · `positionAudience.js` | The four small guards that make the live map correct |
| `materialiseRuns.js` · `runSchedule.js` | Turning schedules into trips |
| `firebase.js` | Firestore mirror + phone push |
| `prisma/schema.prisma` | The 18-table data model |
| `tests/` | 33 test files |

### Where things are (school dashboard)

| Path | Job |
|---|---|
| `app/(dashboard)/` | The 11 dashboard pages |
| `lib/api.ts` | Every API call, in one file |
| `lib/config.ts` | The only place URLs are set |
| `lib/apiCache.ts` | Short-lived GET cache so tab-switching does not refetch |
| `components/map/` | Leaflet live map + Google-based route editor |
| `components/views/` | One folder per screen |

### Commands that work today

```bash
# Backend
npm ci && npx prisma generate && npm test        # 225 tests, ~12s
npm start                                         # needs a valid .env

# Frontend
npm ci && npx tsc --noEmit && npm run build       # clean
npx playwright test --config playwright.unit.config.ts   # 35 logic tests
npx vitest run                                    # BROKEN — missing devDependency
```
