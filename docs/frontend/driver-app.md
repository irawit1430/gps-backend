# Driver App (Mobile) — Integration Spec

**Platform:** iOS + Android (Flutter / React Native / Expo)
**Role:** `DRIVER` · **Scope:** own trips only.

Read [`README.md`](./README.md) first. Use `driverId = user.id`.

---

## Screens (7 total)

| # | Screen | Purpose |
|---|--------|---------|
| 1 | **Login** | Authenticate (+ forced reset on first login) |
| 2 | **My Trips** | Today's assigned trips |
| 3 | **Trip detail** | Route stops + students per stop |
| 4 | **Trip control** | Start / delay / complete a trip |
| 5 | **Attendance** | Mark boarding / alighting (RFID or manual) |
| 6 | **SOS** | Emergency button |
| 7 | **Profile** | Account info |

---

## 1. Login
`POST /api/auth/login`. Drivers are created by the school admin with a **temp
password** and `mustResetPassword: true` → force reset screen on first login.
Handle `429`.

On that reset screen `POST /api/auth/change-password` returns a fresh `token` in its
200 body — store it and go straight into the app. The token you called with is
revoked, and logging in again in the same second is rejected (whole-second
revocation cutoff vs second-resolution JWT `iat`), so use the one you were handed.

## 2. My Trips
```
GET /api/drivers/:driverId/trips
→ [{ id, status, direction, scheduledStart, startTime, delayMinutes,
     route:{ name, stops:[{ name, lat, lng, orderIdx,
        studentMappings:[{ student:{ id,name,rfidTag,grade,photoUrl,guardianPhone } }] }] },
     bus:{...},
     leaveApplications:[{ id, studentId, status, startDate, endDate }] }]
```

`student.guardianPhone` is the child's emergency contact — dial it straight from the
roster row. `scheduledStart` is the planned departure (null when unscheduled), and
`delayMinutes` is filled in at departure by comparing it to the real start.
Only `PLANNED / ON_SCHEDULE / DELAYED` trips are returned.

The stop sequence and student mappings already match `direction`. `TO_SCHOOL` uses
pickup order; `FROM_SCHOOL` reverses the stop sequence. Do not reverse it again in
the client. The server also evaluates "today" in the school's IANA timezone, not in
the phone or API-host timezone.

`leaveApplications` is every **APPROVED** leave covering **today** for the students on
that trip — mark those kids "On Leave" so the driver does not hold a stop for them.
Presence in the array *is* the signal: the server has already filtered to today, so you
do not need to re-check the dates client-side. Note it is a date **range**
(`startDate`/`endDate`), not a single `date` field, and PENDING/REJECTED leaves never
appear. Empty array when nobody on the trip is away.

## 3. Trip detail
Render `route.stops` (ordered by `orderIdx`); each stop has its
`studentMappings[].student` list for the pickup roster.

When the bus reaches, leaves or skips a stop, record the fact explicitly:
```
POST /api/trips/:tripId/stops/:stopId/events
Idempotency-Key: <stable UUID for this queued event>
{ "type": "ARRIVED" | "DEPARTED" | "SKIPPED",
  "occurredAt"?: "ISO-8601", "lat"?: 28.61, "lng"?: 77.20 }
```
The key is required. Coordinates must be supplied together. Queue these events
offline exactly like attendance. Parent progress is based on this evidence; never
advance a stop merely because its scheduled time passed.

## 4. Trip control
Before starting, file the walk-around:
```
POST /api/trips/:tripId/pre-trip-check
{ "items": [{ "id": "tyres", "ok": true, "checkedAt": "ISO-8601" }, ...],
  "note"?: "free text, up to 1000 characters" }
```
- All six checks, each once: `tyres`, `brakes`, `lights`, `mirrors`, `firstaid`, `doors`
- Driver of the trip only (403 otherwise); `409` once the trip has ended
- While the trip is `PLANNED` a new submission replaces the last. Once it is running,
  the one filed before departure stays (`409`); if none was filed, a late one is kept
  and its `submittedAt` shows it came after the start
- Not a gate: `ON_SCHEDULE` is accepted without one
- The school reads it with `GET /api/trips/:tripId/pre-trip-check` (`404` if none)

```
PATCH /api/trips/:tripId/status  { status: 'ON_SCHEDULE' | 'DELAYED' | 'COMPLETED' }
```
- `ON_SCHEDULE` or `DELAYED` starts a planned trip and stamps `startTime`
- `COMPLETED` stamps `endTime`, but only for a running trip
- Driver may only update own trip (403 otherwise)
- A completed/cancelled trip cannot be restarted by a driver
- Completion returns `409` with `studentIds` if the latest attendance state still
  shows any child aboard. Record their `ALIGHTED` events first. School admins retain
  override capability for genuine reconciliation and abandoned-trip recovery.

## 5. Attendance
```
POST /api/attendance
{
  "studentId": "uuid",
  "tripId": "uuid",
  "type": "BOARDED" | "ALIGHTED" | "NO_SHOW",
  "occurredAt"?: "ISO-8601",
  "stopId"?: "uuid",
  "lat"?: 28.61,
  "lng"?: 77.20,
  "handoverConfirmed"?: true
}
```
RFID scan or manual tap → one row per event. Server checks the trip is yours
AND the student belongs to that trip's route/school.

Send `stopId` whenever the active stop is known. The server verifies that it is the
child's assigned stop for the trip direction and records distance evidence when
coordinates are present. `lat` and `lng` must be supplied together.
`handoverConfirmed` is accepted only for `ALIGHTED`. `NO_SHOW` is rejected for a
child whose approved leave covers that trip direction.

**Offline queue / replay safety.** Send an `Idempotency-Key` header when flushing a
queued scan:
```
POST /api/attendance
  headers: Idempotency-Key: <any stable id for this scan, e.g. a uuid>
  body:    { studentId, tripId, type }
```
An exact key replay returns **200** with the original row plus `duplicate: true` —
no second row and no second parent notification. Reusing that key for a different
student, trip or event type returns **409**. During migration, a new key whose same
`studentId` + `tripId` + `type` already exists inside **10 minutes** is also treated
as a duplicate. Without a key the request is a fresh insert, so every locally queued
operation must receive its key when it is created, not when it is flushed.

Migration caveat: after checking the exact key, the server still applies the
10-minute natural-key fallback. Two genuinely separate scans of the same student on
the same trip with the same type inside that window can therefore collapse into one.

`attendanceLogs[].timestamp` is always present (server-stamped, never null) and is
the server's receipt time, not the phone's. In `GET /api/drivers/:id/trips` the list
is scoped to **today** — it answers "who is already aboard", not trip history.

## 5.1 Trip fields — what is real and what is not

| Field | Status |
|-------|--------|
| `status` | real: `PLANNED` / `ON_SCHEDULE` / `DELAYED` / `COMPLETED` / `CANCELLED` |
| `startTime` | real: stamped when a planned trip becomes `ON_SCHEDULE` or `DELAYED` |
| `endTime` | real: stamped when status becomes `COMPLETED` |
| `progressPercent` | legacy column; do not render it as proof of route progress |
| `delayMinutes` | real: computed from `scheduledStart` when the trip starts |
| `currentEtaMessage` | real when `scheduledStart` exists; otherwise unavailable |

Do not derive progress from elapsed time or student attendance. Track acknowledged
stop events locally and refetch the authoritative trip when `journey_changed` or
`trip_status_change` arrives.

**ETA today** comes from `RouteStop.expectedArrivalMinutes` (an offset in minutes
from trip start), not from an absolute timestamp:
```
stopETA = trip.startTime + expectedArrivalMinutes    // once the trip is running
```
Before `startTime` exists there is no absolute schedule to anchor to — see the note
on `scheduledArrival` in REVIEW_LOG open items.

## 5.2 SOS acknowledgement
```
POST /api/driver/emergency   { message?, tripId? }
→ { alertId, id, status: 'ACTIVE', schoolId, type, message, createdAt, ... }

GET /api/alerts/:alertId
→ { alertId, status, acknowledged, ... }
```
The driver may explicitly acknowledge an incident without resolving it:
```
POST /api/alerts/:alertId/acknowledge
```
`acknowledged` and `resolved` are separate. An administrator resolves the incident;
the app must keep an active incident visible after acknowledgement. Alert detail is
readable by the driver who raised it, an admin of that school, and SUPER_ADMIN.

## 6. SOS (emergency) 🔴 payload changed
```
POST /api/driver/emergency   { message?, tripId? }
      (alias of POST /api/alerts/sos — either works)
```
🔴 **Do NOT send `schoolId` or `senderId` in the body** anymore — the server
derives them from your token now. Old backend trusted the body; new one
ignores it. If your app currently sends them, the request still succeeds but
those body fields are dropped.

Admins receive the alert instantly via socket `emergency_alert`.

## 6.1 Push registration and readiness

Register each installation after notification permission is granted:
```
POST /api/users/me/push-devices
{ "deviceId": "stable-installation-id", "platform": "ANDROID" | "IOS",
  "provider": "FCM", "token": "fcm-token" }

GET /api/users/me/notification-readiness
DELETE /api/users/me/push-devices/:deviceId
```
FCM is the supported provider for both Android and iOS. A successful registration
does not prove delivery; render the readiness response and treat
`deliveryConfirmed` separately. Delete the device registration on logout.

## 6.2 Realtime invalidation

Listen for `trip_status_change`, `journey_changed`, `emergency_alert`, and
`notification`. Treat socket payloads as invalidation/deep-link hints and refetch
the authoritative trip or alert. On foreground and socket reconnect, refetch the
active trip, unresolved alert and notification readiness instead of trusting cached
state.

## 7. Location broadcasting (only if driver phone is the GPS source)

Most fleets use the **hardware TM-100 tracker** (talks directly over TCP to
`gps.voltava.in:5000`, doesn't touch this API). Only implement this screen if
a bus has no tracker and the phone must send GPS.

```
POST /api/telemetry
  headers:
    X-Device-Signature: <HMAC-SHA256 hex>
    X-Device-Timestamp: <unix seconds>
  body: { deviceId, lat, lng, speed?, timestamp? }
```

🔑 Sign as:
```
HMAC_SHA256( key = deviceSecret,
             msg = `${deviceId}.${timestamp}.${lat}.${lng}.${speed || 0}` )  → hex
```
**Getting the `deviceSecret`:** call the dedicated endpoint when phone-GPS starts:
```
GET /api/driver/telemetry-credentials     (Authorization: Bearer <jwt>)
→ { deviceId, deviceSecret, tripId }      // for the driver's active-trip bus
404 → no active trip with an assigned device
```
`deviceSecret` is a key for that one trip and driver, not the bus's permanent
secret. The server accepts it only while that trip is running with this driver
on it: it stops working when the trip ends or is reassigned (401). So fetch it
again at the start of every trip, store it in secure storage, and clear it on
logout.

> ⚠️ The login response also returns `deviceId`/`deviceSecret` today, but that is
> **deprecated** and will be removed — migrate to the endpoint above.

Timestamp skew tolerance: **300 seconds**. Use the phone clock.

**JS example:**
```js
import crypto from 'crypto';
const timestamp = Math.floor(Date.now() / 1000);
const signature = crypto
  .createHmac('sha256', deviceSecret)
  .update(`${deviceId}.${timestamp}.${lat}.${lng}.${speed || 0}`)
  .digest('hex');

await fetch(`${API_BASE}/api/telemetry`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Device-Signature': signature,
    'X-Device-Timestamp': String(timestamp),
  },
  body: JSON.stringify({ deviceId, lat, lng, speed: speed || 0 }),
});
```

**Flutter example:**
```dart
final ts = (DateTime.now().millisecondsSinceEpoch ~/ 1000).toString();
final spd = speed ?? 0;
final body = '$deviceId.$ts.$lat.$lng.$spd';
final sig = Hmac(sha256, utf8.encode(deviceSecret))
    .convert(utf8.encode(body))
    .toString();
await http.post(
  Uri.parse('$API_BASE/api/telemetry'),
  headers: {
    'Content-Type': 'application/json',
    'X-Device-Signature': sig,
    'X-Device-Timestamp': ts,
  },
  body: jsonEncode({'deviceId': deviceId, 'lat': lat, 'lng': lng, 'speed': spd}),
);
```

> HMAC too heavy for the pilot? Ask backend ops to set
> `TELEMETRY_HMAC_ENFORCE=0` temporarily. Production must keep it on.

---

## Config (mobile — no CORS)

**Flutter:**
```bash
flutter run --dart-define=API_BASE_URL=https://api.voltava.in \
            --dart-define=SOCKET_URL=wss://api.voltava.in
```
**React Native / Expo:**
```env
# .env
EXPO_PUBLIC_API_BASE_URL=https://api.voltava.in
EXPO_PUBLIC_SOCKET_URL=wss://api.voltava.in
```

## Storage
Use secure storage (Keychain / Keystore) for `token` and `user`. Device
telemetry `deviceSecret` (if used) must live in secure storage too.

## Global 401 handler
Same as parent app — clear storage + go to login on any 401 (24h token life).
