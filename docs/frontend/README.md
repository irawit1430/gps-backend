# Voltava Fleet — Frontend Integration Guide (START HERE)

This folder tells every frontend team how to connect to the **new GCP backend**
and what changed during the migration from the Render staging server.

## Backend is LIVE at:
- **HTTPS:** `https://api.voltava.in`
- **WebSocket:** `wss://api.voltava.in`
- **Static IP (fallback):** `8.234.123.112`

## Test credentials (seeded super admin):
- Email: `admin@voltava.app`
- Password: *(rotate this before real use)*

---

## The four apps

| App | Repo | Platform | File |
|-----|------|----------|------|
| Super Admin Console | *(TBD)* | Web | [`super-admin-web.md`](./super-admin-web.md) |
| School Admin Console | `irawit1430/school-` | Next.js 15 + React 19 | [`school-admin-web.md`](./school-admin-web.md) |
| Parent App | *(TBD)* | Mobile | [`parent-app.md`](./parent-app.md) |
| Driver App | *(TBD)* | Mobile | [`driver-app.md`](./driver-app.md) |

Shared code templates:
- [`config.example.js`](./config.example.js) — framework-agnostic config
- [`api-client.example.js`](./api-client.example.js) — HTTP + Socket.IO with auth
- [`OVERVIEW.md`](./OVERVIEW.md) — one-page team overview

---

## 0. The ONE thing every app must change (cut-over)

The backend moved from Render to GCP. **Every app must update two URLs.**

| Old (Render staging) | New (GCP production) |
|----------------------|----------------------|
| `https://gps-backend-jzd7.onrender.com` | `https://api.voltava.in` |
| `wss://gps-backend-jzd7.onrender.com` | `wss://api.voltava.in` |

**Put them in ONE env-driven config module.** Do not scatter the URL across
files. See per-app docs for framework-specific examples:
- Next.js: `process.env.NEXT_PUBLIC_API_BASE_URL`
- Vite/React: `import.meta.env.VITE_API_BASE_URL`
- React Native / Expo: `expo-constants` or `EXPO_PUBLIC_*`
- Flutter: `--dart-define=API_BASE_URL=...`

---

## 1. Breaking changes from the old backend (READ CAREFULLY)

These are behaviour changes in the new backend. Frontends **will break** if ignored.

### 1.1 Socket.IO now REQUIRES authentication 🔴 (was optional)
```ts
// BEFORE — this WORKED against Render
const socket = io("https://gps-backend-jzd7.onrender.com");

// AFTER — must pass JWT or connection is rejected
const socket = io("wss://api.voltava.in", {
  auth: { token: localStorage.getItem('token') },
  transports: ['websocket'],
});
socket.on('connect_error', (err) => {
  if (err.message?.startsWith('Unauthorized')) {
    // token missing/expired → send user to login
  }
});
```
You also only receive events for **your own school** now (server-side rooms).
Super Admin receives all. You can delete any client-side `alert.schoolId ===
user.schoolId` filters — they're now redundant.

### 1.2 JWT expires in 24 hours (was 7 days) 🟠
Wire a **global 401 handler** that clears storage and redirects to login. See
`api-client.example.js` for the pattern.

### 1.3 Cross-tenant requests now return 403 🟠
A SCHOOL_ADMIN calling `GET /api/schools/OTHER_ID/...` gets
`403 { error: 'Forbidden: cross-tenant access denied' }`. Always use the
logged-in user's `schoolId`. Never hardcode.

### 1.4 Validation errors now return 400 with details 🟠
```json
{ "error": "Validation failed",
  "issues": [{ "path": "email", "message": "Invalid email" }] }
```
Surface `issues[].message` under the relevant form field.

### 1.5 Stats can be `null` (no more fake fallbacks) 🟠
Fields that used to have invented defaults now come back as `null`:
- `busesGrowthPercent`, `studentsGrowthPercent`, `schoolsGrowthPercent`
- `averageRouteDuration`
- `mostEfficientRoute`
- `stationaryDevices` (may be 0)

Render `—` / "No data" for null values instead of showing a garbage number.

### 1.6 Mock notifications are gone 🟠
Empty list = truly empty. Build a "No new notifications" empty state.
(Behavior still enabled *only* if backend sets `ENABLE_MOCK_DATA=1` — off in prod.)

### 1.7 New login response field: `mustResetPassword`
```json
{ "token": "...",
  "user": { "id", "name", "email", "role", "schoolId",
            "mustResetPassword": true, "preferences": {} } }
```
If `true` (auto-created parents/drivers) → force a password-reset screen.

### 1.8 Rate limit: 5 login attempts / min / IP
On `429`: show "Too many attempts, try again in a minute."

### 1.9 SOS payload change 🟠 (drivers)
Old backend accepted `schoolId` / `senderId` in the body. **Now ignored** — the
server derives them from the JWT. Just send `{ message?, tripId? }`.

### 1.10 Device HMAC (only if phone-based telemetry)
If a driver phone (not TM-100 hardware) POSTs `/api/telemetry`, it now needs
HMAC headers. See [`driver-app.md`](./driver-app.md) §7. Skip if only hardware
trackers send GPS.

---

## 2. Authentication flow (same for all apps)

```
POST /api/auth/login   { email, password }
  → 200 { token, user: { id, name, email, role, schoolId,
                          mustResetPassword, preferences } }
  → 401 { error: 'Invalid credentials' }
  → 429 { error: 'Too many login attempts; try again shortly.' }
```

1. Save `token` (secure storage; mobile: Keychain/Keystore).
2. Save `user` (need `id`, `role`, `schoolId` everywhere).
3. Header on every subsequent request: `Authorization: Bearer <token>`
4. If `mustResetPassword === true` → force reset screen.
5. On any `401` → clear token, go to login.

---

## 3. Roles & scope

| Role | Sees |
|------|------|
| `SUPER_ADMIN` | Everything, all schools |
| `SCHOOL_ADMIN` | Only their `schoolId` |
| `DRIVER` | Only their own trips / attendance |
| `PARENT` | Only their own children |

Hide UI a role can't use — but the **server enforces it too** (403), so a
missed button that gets called still fails safely.

---

## 4. Real-time events (Socket.IO)

After authenticating the socket (§1.1), listen for:

| Event | Payload | Who cares |
|-------|---------|-----------|
| `location_update` | `{ busId, licensePlate, lat, lng, speed, driverName, routeName, timestamp }` | Admin maps, Parent live-track |
| `emergency_alert` | full alert object | Admin dashboards |
| `device_status_change` | `{ deviceId, status, message }` | Admin dashboards |
| `trip_status_change` | `{ tripId, status, busId, driverId, routeId, routeName, startTime, endTime, reason }` | Driver app, Admin dashboards |
| `notification` | the Notification row | Parents |

Events are already filtered to your school server-side.

⚠️ **There is no `sos`, `sos_alert`, `alert`, or `notification_new` event.** An SOS —
driver-triggered or hardware — arrives as **`emergency_alert`**, with `type` set to
`DRIVER_SOS` / `HARDWARE_SOS` / `ADMIN_BROADCAST` / `DELAY`. Listening on any other
name yields silence.

`device_status_change` fires on both edges: `ONLINE` when a bus starts reporting
again, `OFFLINE` when the sweep sees no telemetry for 15 minutes. Do not infer
offline from "no `location_update` for N seconds" — a parked bus with no fresh GPS
fix legitimately goes quiet.

`trip_status_change` (`reason`: `created` | `status` | `assignment` | `unassigned`)
replaces polling `GET /api/drivers/:id/trips` on a timer. Re-fetch the trip when it
arrives; a driver who has just been unassigned gets `reason: 'unassigned'`.

---

---

## 4.1 Sending a message to drivers or parents

One endpoint covers both audiences. Usable from the **School Admin console** (own
school) and the **Super Admin console** (any school — pass that school's id).

```
POST /api/schools/:schoolId/broadcast
{
  message:    "Please update the driver app to v2.4 before tomorrow's shift.",
  audience:   "DRIVERS",        // PARENTS (default) | DRIVERS | ALL
  type:       "SYSTEM",         // SYSTEM = routine, SOS = emergency, DELAY
  title:      "App update required",   // optional
  driverIds:  ["<uuid>", ...],  // optional: only these drivers
  tripId:     "<uuid>"          // optional: scope to one trip's driver / parents
}
→ { ...alert, audience, recipientCount }
```

Rules that matter:

- **`audience` defaults to `PARENTS`**, so existing broadcast callers are unchanged.
- `type` defaults to `SYSTEM` for a DRIVERS send and `SOS` otherwise. Use `SYSTEM`
  for routine notices — `SOS` renders as an emergency in the apps.
- `driverIds` is filtered to drivers **of that school**, so a Super Admin cannot
  message another school's drivers through this route.
- With `tripId` and no `driverIds`, DRIVERS means that trip's driver, and PARENTS
  means the parents of students on that trip's route.
- `recipientCount` is how many people were actually written to — show it as
  confirmation instead of assuming the send landed.

**Receiving side (driver app and parent app):** each recipient gets a real
`Notification` row over socket `notification`, including `id`, so it can be marked
read with `POST /api/notifications/:id/read`. It also appears in
`GET /api/notifications`.

```js
socket.on('notification', (n) => showInbox(n));   // n.type: SYSTEM | SOS | DELAY | ...
```

Admin dashboards additionally receive the audit record as `emergency_alert`
(`type: 'ADMIN_BROADCAST'`), the same as before.

---

## 4.2 OS push notifications (FCM) — now live

Socket events only reach an app that is open. Push reaches a locked phone.

```
POST /api/users/me/fcm-token   { "fcmToken": "<device token>" }   → { success, registered: true }
POST /api/users/me/fcm-token   { "fcmToken": null }                → { success, registered: false }
```

- Register **after** the user grants notification permission, and again whenever the
  device rotates the token.
- `POST /api/auth/logout` clears it server-side, so a signed-out phone goes quiet
  without an extra call.
- The token is **never** returned by any endpoint — `GET /api/users/me` and the
  driver/parent update responses strip it.
- A token FCM rejects as unregistered is cleared automatically on the next send.

Push is sent alongside the socket event for: attendance (boarding/drop-off),
admin broadcasts, and emergency alerts. Payload `data` carries `type` plus the
relevant id (`notificationId`, `alertId`, `tripId`) so a tap can deep-link.

If `FIREBASE_SERVICE_ACCOUNT` is not configured on the server, push is silently
skipped — sockets and `GET /api/notifications` keep working.

## 4.3 Trip scheduling (`scheduledStart`)

`Trip.scheduledStart` is the planned departure. It is what makes an ETA visible
**before** a trip starts.

```
POST /api/schools/:schoolId/trips  { routeId, busId, driverId, scheduledStart?: ISO }
PUT  /api/trips/:tripId            { ..., scheduledStart?: ISO | null }
```

Consequences once a trip carries one:

- Stop ETAs resolve pre-departure (`etaBasis: "SCHEDULED_START"`), and switch to the
  real clock the moment the driver starts the trip (`etaBasis: "ACTUAL_START"`).
- `Trip.delayMinutes` and `Trip.currentEtaMessage` **stop being dead columns** — they
  are computed at departure (`startTime` vs `scheduledStart`) and stored. A trip with
  no `scheduledStart` keeps `delayMinutes: 0` / `currentEtaMessage: null`, exactly as
  before, so nothing breaks for schools that do not schedule.

**Admin consoles:** add an optional date-time field to the trip create/edit form.
Leaving it empty is valid and preserves today's behaviour.

---

## 4.4 Forgot password (admin-approval flow)

There is **no reset-by-email**. Nothing in this stack can send mail, and adding a
mail provider was declined, so a reset is approved by a human instead.

**User side (parent / driver app) — one call:**

```
POST /api/auth/forgot-password   { "email": "someone@example.com" }
→ 200 { success: true, message: "If that account exists, your school admin has been
        notified and will share a new password." }
```

- Always 200, always the **same body**, whether or not the address has an account —
  a different answer would tell an attacker which emails are registered. Do not try
  to infer anything from it; show the message and stop.
- Rate-limited like login (429 → "try again in a minute").
- Tapping twice does not queue a second request.
- There is no code-entry step and no reset-token step. If your app was built for a
  3-step flow, keep step 1 and replace steps 2–3 with the message above.

**Admin side (school + super admin consoles):**

```
GET  /api/password-reset-requests?status=PENDING
→ [{ id, status, createdAt, user: { id, name, email, role, phone } }]

POST /api/password-reset-requests/:id/approve
→ { success, user: { id, name, email }, tempPassword, note }

POST /api/password-reset-requests/:id/reject
→ the updated request
```

Approving sets a fresh temp password, forces `mustResetPassword`, and signs the user
out of every existing session. **`tempPassword` is returned exactly once** — it is
stored only as a hash, so a lost one means approving a new request. Its alphabet
excludes `O/0/I/1` so it can be read out over a phone.

School admins see and act on their own school only. Requests from accounts with no
school go to super admins.

**UI note:** a pending request also arrives as a `notification` socket event and a
push, so a badge on the admin console can light up without polling.

## 5. Standard error shape

| Status | Meaning | Frontend action |
|--------|---------|-----------------|
| 400 | Bad input | Show `error` / `issues[].message` |
| 401 | Not logged in / token expired | Global redirect to login |
| 403 | Not allowed (role/tenant) | "No access" state |
| 404 | Not found | Empty / not-found |
| 429 | Rate limited | "Try again shortly" |
| 500 | Server error | "Something went wrong" |

Every error body is JSON: `{ error, issues? }`.

---

## 6. Local dev against the LIVE backend

Backend CORS already allows these local origins:
- `http://localhost:3000`, `:5173`, `:5174`, `:8080`
- `http://127.0.0.1:3000`, `:5173`

**Need a different port?** Ask backend ops to add it — one-line change.

⚠️ **Local dev hits the LIVE database.** Any test data you create persists.
Use "Test School / Test Bus / Test Student" prefixes so it's easy to clean up.

---

Next: open your app's file for framework-specific migration steps.
