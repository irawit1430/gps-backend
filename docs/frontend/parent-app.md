# Parent App ↔ Backend — Developer Integration Guide

**Platform:** iOS + Android (Flutter / React Native / Expo)
**Role:** `PARENT` · **Scope:** own children only (server-enforced).

This is the single source of truth for wiring the Parent app to the Voltava Fleet
backend. Every endpoint / payload below matches the live server. Read
[`README.md`](./README.md) once for the shared auth / socket / error rules.

---

## 0. Connection basics

| Thing | Value |
|-------|-------|
| API base (prod) | `https://api.voltava.in` |
| Socket URL | `wss://api.voltava.in` |
| Static IP fallback | `http://8.234.123.112:3000` |
| Auth header | `Authorization: Bearer <jwt>` |
| Token lifetime | 24h (re-login on expiry) |
| Content type | `application/json` |
| CORS | Mobile apps are **not** affected — connect directly. |

Put the two URLs in ONE env-driven config module — never hardcode:

**Flutter**
```bash
flutter run --dart-define=API_BASE_URL=https://api.voltava.in \
            --dart-define=SOCKET_URL=wss://api.voltava.in
```
```dart
const API_BASE  = String.fromEnvironment('API_BASE_URL');
const SOCKET_URL = String.fromEnvironment('SOCKET_URL');
```

**React Native / Expo** — `.env`
```env
EXPO_PUBLIC_API_BASE_URL=https://api.voltava.in
EXPO_PUBLIC_SOCKET_URL=wss://api.voltava.in
```
Read via `process.env.EXPO_PUBLIC_API_BASE_URL`.

---

## 1. Auth flow

### 1.1 Login
```
POST /api/auth/login
Body: { "email": "parent@example.com", "password": "..." }

200 → {
  "token": "<jwt>",
  "user": {
    "id": "uuid", "name": "...", "email": "...",
    "role": "PARENT", "schoolId": "uuid",
    "mustResetPassword": false,
    "preferences": { ... }   // saved notification toggles
  }
}
401 → { "error": "Invalid credentials" }
429 → { "error": "Too many login attempts; try again shortly." }
```
- Store `token` + `user` in **secure storage** (Keychain / EncryptedSharedPreferences).
- `parentId = user.id` — you'll need it for most calls below.
- Login is rate-limited **5 / min**. Handle `429` with a "try again in a minute" message.

### 1.2 Forced password reset (first login)
If `user.mustResetPassword === true`, route to a change-password screen **before**
anything else. New parents are provisioned with a temporary password.

```
POST /api/auth/change-password        (requires Authorization header)
Body: { "oldPassword": "<temp>", "newPassword": "<min 8 chars>" }

200 → { "message": "Password updated successfully" }
401 → { "error": "Incorrect current password" }
```
On success the server clears `mustResetPassword` **and revokes all existing
sessions for this user — including the current token.** After a `200`, send the
user back to Login to sign in with the new password (your global 401 handler will
also catch the now-revoked token on the next request).

### 1.4 Logout
```
POST /api/auth/logout        (requires Authorization header)
200 → { "message": "Logged out" }
```
Call this on sign-out; the presented token is revoked immediately (a reused token
returns `401 "Unauthorized: token has been revoked"`). Then clear local storage.

### 1.3 Global 401 handling
Wrap your HTTP client so ANY `401` clears storage and returns to Login (token
expired or revoked). Same for a socket `connect_error` of `Unauthorized: invalid token`.

---

## 2. My Children (Home)
```
GET /api/parents/{parentId}/students
→ [
    {
      "id": "uuid", "name": "...", "grade": "...", "photoUrl": null,
      "routeStopName": "Green Park Estate",   // "Unassigned" if none
      "driverName": "Ashok Kumar",            // "Unassigned" if no active trip
      "licensePlate": "DL1P-1234"             // "Unassigned" if no active trip
    }
  ]
```
- Use `parentId = user.id`. A parent may only read their **own** id (server returns
  `403` otherwise).
- `licensePlate` here is your key to match live location events (see §4).

---

## 3. Initial bus location (before the socket warms up)
```
GET /api/devices/locations
→ [
    {
      "busId": "uuid", "licensePlate": "DL1P-1234",
      "schoolName": "Delhi Public School",
      "lastKnownLat": 28.5584, "lastKnownLng": 77.2029,
      "speed": 22, "lastUpdate": "2026-08-19T09:12:03.000Z"
    }
  ]
```
- **Automatically scoped to the caller.** For a `PARENT` this returns only the
  buses on their children's active trips — no other school buses.
- Buses with no GPS fix yet are omitted.
- Use this to place the initial map marker, then switch to live `location_update`
  socket events for movement.

---

## 4. Live Track — Socket.IO (auth REQUIRED 🔴)

The socket **rejects unauthenticated connections**. Pass the JWT in the handshake.

**Flutter (`socket_io_client`)**
```dart
final socket = IO.io(
  SOCKET_URL,                              // wss://api.voltava.in
  IO.OptionBuilder()
      .setTransports(['websocket'])
      .setAuth({'token': jwtToken})        // REQUIRED
      .build(),
);

socket.on('connect_error', (data) {
  // 'Unauthorized: invalid token' → clear storage, go to Login
});
```

**React Native (`socket.io-client`)**
```js
import { io } from 'socket.io-client';
const socket = io(SOCKET_URL, {
  auth: { token: jwt },
  transports: ['websocket'],
});
```

### Rooms the server auto-joins you to
On connect the backend puts a parent into:
- `school:{schoolId}` — receives fleet events for the child's school
- `user:{userId}` — receives events addressed to this parent only

You do **not** emit any join yourself — just listen.

### Events to listen for

**`location_update`** — a bus moved. Emitted for every bus in the school, so
**filter by `busId` / `licensePlate`** from §2/§3 and move only your child's marker.
```jsonc
{
  "busId": "uuid",
  "licensePlate": "DL1P-1234",
  "lat": 28.55, "lng": 77.20,
  "speed": 24,
  "driverName": "Ashok Kumar",   // present on app/HTTP telemetry
  "routeName": "Morning Route A", // present on app/HTTP telemetry
  "heading": 180,                 // present on hardware (TCP) telemetry
  "timestamp": "2026-08-19T09:12:03.000Z"
}
```
> Some fields vary by source (phone vs TM-100 hardware). Always null-check
> `driverName` / `routeName` / `heading`.

**`notification`** — a real-time alert addressed to this parent (fires when their
child is marked boarded/alighted). Payload is a full Notification row:
```jsonc
{
  "id": "uuid", "userId": "<parentId>",
  "title": "Student BOARDED",
  "message": "Rohan Sharma has been marked BOARDED.",
  "type": "BOARDING",            // BOARDING | ARRIVAL | ...
  "isRead": false,
  "createdAt": "2026-08-19T09:12:03.000Z"
}
```
Show a toast/local notification and prepend it to the in-app list (§6).

**`emergency_alert`** — an SOS / hardware emergency for the school. Payload is the
EmergencyAlert row (`{ id, schoolId, type, message, status, createdAt }`). Surface
prominently.

### ETA
Use `driverName` / `routeName` for context. There is no server-computed ETA field
in these events yet — compute client-side from geodesic distance to the next stop,
or show "on route". (Trip objects carry `currentEtaMessage` / `delayMinutes` when
you fetch them, but the parent app has no trip-detail endpoint today.)

> Live location comes over the **WebSocket** (Postgres + Socket.IO backend).
> Do NOT add `firebase_core` / `cloud_firestore` for tracking.

---

## 4.1 Child detail, trip timeline, history, alerts (added 25 Aug 2026)

### `GET /api/parents/:parentId/students` — extra fields

```jsonc
{
  "id": "...", "name": "...", "grade": "...", "photoUrl": "...",
  "routeStopName": "Sector 14 Market",
  "driverName": "Rajesh Kumar",
  "licensePlate": "DL-01-AB-1234",
  "tripStatus": "IN_TRANSIT",
  "busId": "bus-101",          // match socket packets on this, not licensePlate
  "tripId": "trip-88",
  "stopId": "stop-1",
  "stopLat": 28.5600,          // the child's own stop — map pin + ETA anchor
  "stopLng": 77.2050,
  "stopOffsetMinutes": 22,     // RouteStop.expectedArrivalMinutes, null if unset
  "stopEtaAt": "2026-08-25T07:52:00.000Z",   // startTime + offset; null before start
  "stopEtaMinutes": 7,                        // relative to now; negative = overdue
  "trip": {
    "id": "trip-88",
    "status": "ON_SCHEDULE",
    "scheduledStart": "2026-08-25T07:25:00.000Z",  // null if the school did not schedule
    "startTime": "2026-08-25T07:30:00.000Z",
    "endTime": null,
    "currentEtaMessage": "Running 5 min late",     // computed at departure
    "delayMinutes": 5                              // 0 when there is no scheduledStart
  },
  "guardianPhone": "+9198XXXXXXXX",  // the child's own emergency contact
  "driverPhone": "+9198XXXXXXXX",    // null until the school fills the driver's number
  "schoolPhone": "+9111XXXXXXX"      // School.phone, falls back to contactPhone
}
```

**ETA:** prefer `stopEtaAt` / `stopEtaMinutes` over a client-side distance ÷ speed
estimate. Both are `null` until the trip actually starts (`startTime` is stamped when
the driver moves the trip to `ON_SCHEDULE`) or when the school has not filled in
`expectedArrivalMinutes` for that stop. Keep the fallback for those two cases.

`trip.delayMinutes` and `trip.currentEtaMessage` are real now, but only for trips the
school gave a `scheduledStart`. Without one they stay `0` / `null` — treat those as
"unknown", not "on time". `stopEtaAt` also carries `etaBasis`:
`SCHEDULED_START` before departure, `ACTUAL_START` once the trip is moving.

### `GET /api/parents/:parentId/students/:studentId/trip`

Trip timeline. 404 when the child has no route mapping or no active trip on it.

```jsonc
{
  "id": "trip-88", "status": "ON_SCHEDULE",
  "startTime": "...", "endTime": null,
  "busId": "bus-101", "licensePlate": "DL-01-AB-1234", "driverName": "Rajesh Kumar",
  "route": {
    "id": "route-4b", "name": "Morning Route 4B",
    "stops": [{
      "id": "stop-1", "name": "Green Park Gate 2",
      "lat": 28.5584, "lng": 77.2029, "orderIdx": 1,
      "expectedArrivalMinutes": 12,
      "stopEtaAt": "2026-08-25T07:42:00.000Z", "stopEtaMinutes": -3,
      "isMyStop": false,
      "boardedCount": 4,
      "passedAt": "2026-08-25T07:29:00Z"
    }]
  }
}
```

No `studentMappings`, no other child's name or RFID tag — only `boardedCount`.

⚠️ `passedAt` is **derived**, not recorded: nothing tracks when a bus physically passes
a stop, so this is the first boarding scan at that stop on this trip. A stop where
nobody boarded stays `null` even after the bus has been and gone.

### `GET /api/parents/:parentId/students/:studentId/attendance?limit=20`

```jsonc
[{ "id": "att-1", "type": "BOARDED", "tripId": "trip-88",
   "timestamp": "2026-08-25T07:42:00.000Z",
   "createdAt": "2026-08-25T07:42:00.000Z",   // alias of timestamp
   "stopName": "Sector 14 Market" }]
```

Newest first, `limit` default 20, max 100. `stopName` is the child's **assigned** stop
(AttendanceLog has no stop column), so it is the same on every row.

### `GET /api/parents/:parentId/alerts?limit=20`

Cold-start companion to the socket event — an SOS raised while the app was closed.

```jsonc
[{ "id": "alert-1", "type": "DRIVER_SOS", "message": "...",
   "status": "ACTIVE", "resolved": false, "tripId": "trip-88",
   "createdAt": "2026-08-25T07:36:00Z" }]
```

Scoped to trips on the routes this parent's children ride — never other buses.
`resolved` is `true` once an admin marks the alert handled; poll or re-fetch on
foreground to clear a banner.

### `emergency_alert` now reaches parents

Both driver SOS and hardware SOS emit `emergency_alert` to the affected trip's parents
(via their `user:<id>` room), in addition to the school's admins. Nothing to subscribe
to — the handshake already joins the room.

Scoping caveat: an SOS raised **without** a `tripId`, and a hardware SOS from a bus
with no running trip, cannot be attributed to any family, so those reach admins only.

## 5. Leaves
```
GET  /api/parents/{parentId}/leaves
→ [ { "id","startDate","endDate","reason","notes","status","student":{"name"} } ]
   // status: PENDING | APPROVED | REJECTED

POST /api/leaves
Body: {
  "studentId": "uuid",
  "startDate": "2026-08-20T00:00:00.000Z",   // ISO
  "endDate":   "2026-08-21T00:00:00.000Z",
  "reason":    "Fever",
  "notes":     "optional"
}
200 → the created leave (status starts PENDING)
403 → parent tried to file for a child that isn't theirs
```
Send dates as ISO strings (`DateTime.now().toIso8601String()` / `new Date().toISOString()`).
A parent may only submit for their own child (server-enforced). Approval/rejection
is done by school admins — the parent just sees `status` change.

---

## 6. Notifications
```
GET  /api/parents/{parentId}/notifications      // up to 50, newest first
→ [ { "id","title","message","type","isRead","createdAt" } ]

// (equivalent generic feed for the logged-in user)
GET  /api/notifications?limit=20

POST /api/notifications/{id}/read      // mark one read
POST /api/notifications/mark-read      // mark all of this user's read
```
- Combine the initial `GET` list with live `notification` socket events (§4) —
  prepend socket events to the top of the list.
- An empty list is a **real** empty state (no mock rows).

---

## 7. Preferences (notification toggles)
```
PATCH /api/parents/{id}/preferences
Body (all optional booleans):
{
  "emailAlerts": true,
  "smsAlerts": false,
  "pushNotifications": true,
  "geofenceAlerts": true,
  "delayAlerts": false
}
→ { "preferences": { ...saved object... } }
```
- `id` must be the parent's own `user.id` (else `403`).
- Unknown extra keys are accepted and stored (passthrough), but prefer the keys above.
- The saved object is also returned as `user.preferences` on the next login.

---

## 8. Profile
No dedicated profile GET endpoint — render from the cached `user` object from login.
Extend the backend if a live profile fetch is needed later.

---

## 9. Error & status contract

| Code | Meaning | App action |
|------|---------|-----------|
| `400` | Validation failed | Body has `issues: [{ path, message }]` — map to form fields |
| `401` | Missing/expired/invalid token | Clear storage → Login |
| `403` | Cross-tenant / not-your-child | Show "not allowed"; never retry with another id |
| `404` | Not found | Empty state |
| `429` | Login rate limit (5/min) | "Try again shortly" |
| `500` | Server error | Generic retry toast |

Validation error shape:
```json
{ "error": "Validation failed",
  "issues": [ { "path": "newPassword", "message": "String must contain at least 8 character(s)" } ] }
```

---

## 10. Endpoint quick-reference (Parent)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/auth/login` | Log in |
| POST | `/api/auth/change-password` | Change password (forced reset) — revokes sessions |
| POST | `/api/auth/logout` | Revoke current token on sign-out |
| GET  | `/api/parents/{parentId}/students` | Children + assigned bus/driver |
| GET  | `/api/devices/locations` | Last-known locations of child's buses |
| GET  | `/api/parents/{parentId}/leaves` | Leave history |
| POST | `/api/leaves` | Submit a leave |
| GET  | `/api/parents/{parentId}/notifications` | Notification list |
| GET  | `/api/notifications` | Generic user feed |
| POST | `/api/notifications/{id}/read` | Mark one read |
| POST | `/api/notifications/mark-read` | Mark all read |
| PATCH| `/api/parents/{id}/preferences` | Save toggles |
| — (socket) | `location_update`, `notification`, `emergency_alert` | Realtime |

---

## 11. OS push notifications (FCM) — status

OS-level push is **not available yet**. The backend creates in-app Notification
rows and emits the realtime `notification` socket event (§4), which covers the
parent flow while the app is open. Native FCM push requires a `fcmToken` field on
the user + a device-token registration endpoint — **not implemented yet**. Do not
add `firebase_messaging` expecting server pushes until backend ops confirm it's
live. Coordinate before building that screen.

---

## 12. Local storage & security checklist
- Store `token` + `user` in secure storage only (Keychain / EncryptedSharedPreferences).
- Never log the JWT.
- Global `401`/`connect_error` → clear storage → Login.
- Always derive `parentId`/`schoolId` from the login `user` object — never hardcode
  or accept them from another screen (server rejects cross-tenant anyway).
