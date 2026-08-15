# Voltava Fleet — Frontend Team Overview

One page: who builds what, and the migration checklist for the Render → GCP cut-over.

## Backend LIVE at:
- **`https://api.voltava.in`** · WebSocket: `wss://api.voltava.in`
- Static IP fallback: `8.234.123.112`

---

## The 4 apps

| App | Repo | Platform | Screens | Doc |
|-----|------|----------|:-------:|-----|
| Super Admin | *TBD* | Web (Next.js/Vite/React) | **11** | [`super-admin-web.md`](./super-admin-web.md) |
| School Admin | `irawit1430/school-` | Next.js 15 + React 19 + Tailwind | **12** | [`school-admin-web.md`](./school-admin-web.md) |
| Parent | *TBD* | Mobile (Flutter/RN) | **7** | [`parent-app.md`](./parent-app.md) |
| Driver | *TBD* | Mobile (Flutter/RN) | **7** | [`driver-app.md`](./driver-app.md) |

Total: **37 screens** across 4 apps.

---

## Screen map

- **Super Admin (11):** Login · Global Dashboard · Schools · School detail ·
  Devices/Hardware · Live Map · Admins · Notifications · Global Search ·
  System Logs · Settings
- **School Admin (12):** Login · Dashboard · Buses · Live Map · Routes(+stops) ·
  Drivers · Students · Student→Route mapping · Trips · Attendance · Leaves ·
  Notifications/Search
- **Parent (7):** Login · My Children · Live Track · Leaves · Notifications ·
  Preferences · Profile
- **Driver (7):** Login · My Trips · Trip detail · Trip control · Attendance ·
  SOS · Profile

---

## What EVERY app must change (cut-over)

| # | Change | Detail |
|---|--------|--------|
| 1 | **URL swap** | `gps-backend-jzd7.onrender.com` → `api.voltava.in`. Move into ONE env-driven config module — no scattered hardcodes. |
| 2 | **Socket.IO auth** 🔴 | `io(url, { auth: { token } })` — was optional, now REQUIRED |
| 3 | **Global 401 handler** | Tokens now 24h (was 7d). Clear + redirect to login. |
| 4 | **`mustResetPassword`** | New login response field — force reset screen if `true` |
| 5 | **Null stats** | `busesGrowthPercent` etc. can be `null` — render `—` |
| 6 | **Empty notifications** | No more mock rows; build real empty state |
| 7 | **`429` on login** | Rate-limited 5/min — show "try again shortly" |
| 8 | **403 on cross-tenant** | Always use `user.schoolId` from token, never hardcode |
| 9 | **SOS payload (Driver only)** | Don't send `schoolId`/`senderId` — server derives them |
| 10 | **Validation `issues[]`** | 400 responses now include `issues[]` for form fields |

Details + code snippets: [`README.md`](./README.md).

---

## Per-app owner briefs

### Web dev — School Admin (`irawit1430/school-`) 🔥 has real code to migrate
Follow [`school-admin-web.md`](./school-admin-web.md) — it names exact files
& lines. The 4 blocking changes:
1. `lib/config.ts` (new) — one place for URLs
2. `lib/api.ts` — central `request()` wrapper + 401 redirect
3. `lib/socket.ts` (new) + update `LiveFleetMap.tsx` + `EmergencyAlertBanner.tsx`
4. `LoginForm.tsx` — handle `mustResetPassword` + `429`

### Web dev — Super Admin
Same architecture as School Admin. Extra care on **Devices screen** — the
`deviceSecret` returned once at create/rotate must be shown in a copy-once modal.

### Mobile dev — Parent
Live tracking uses **Socket.IO** (not Firebase). See parent doc §3 for Flutter
+ RN handshake code. Push notifications skipped for now (Firebase disabled
backend-side).

### Mobile dev — Driver
SOS body shape changed (don't send `schoolId`/`senderId`). Phone-based
telemetry (screen 7) needs HMAC signing — see driver doc §7. Skip screen 7 if
using hardware TM-100 trackers only.

---

## Backend info to hand every frontend

| Thing | Value |
|-------|-------|
| API base (prod) | `https://api.voltava.in` |
| Socket URL | `wss://api.voltava.in` |
| Static IP fallback | `http://8.234.123.112:3000` |
| Auth header | `Authorization: Bearer <jwt>` |
| Token lifetime | 24h |
| Login | `POST /api/auth/login { email, password }` |
| Hardware TCP | `gps.voltava.in:5000` (TM-100 devices only) |

⚠️ **Web apps only:** give backend ops your deployed origin (e.g.
`https://school.voltava.in`) so it's added to `CORS_ORIGINS`. Mobile apps
are unaffected by CORS.

**Local dev origins already whitelisted:** `localhost:3000`, `:5173`, `:5174`,
`:8080`, `127.0.0.1:3000`, `127.0.0.1:5173`.

---

## Files in this folder
- `OVERVIEW.md` — this file
- `README.md` — shared auth/socket/error rules + all breaking changes
- `super-admin-web.md`, `school-admin-web.md`, `parent-app.md`, `driver-app.md`
- `config.example.js` — framework-agnostic config template
- `api-client.example.js` — HTTP + authenticated socket client
