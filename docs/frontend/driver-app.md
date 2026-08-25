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

## 2. My Trips
```
GET /api/drivers/:driverId/trips
→ [{ id, status, scheduledStart, startTime, delayMinutes,
     route:{ name, stops:[{ name, lat, lng, orderIdx,
        studentMappings:[{ student:{ id,name,rfidTag,grade,photoUrl,guardianPhone } }] }] },
     bus:{...} }]
```

`student.guardianPhone` is the child's emergency contact — dial it straight from the
roster row. `scheduledStart` is the planned departure (null when unscheduled), and
`delayMinutes` is filled in at departure by comparing it to the real start.
Only `PLANNED / ON_SCHEDULE / DELAYED` trips are returned.

## 3. Trip detail
Render `route.stops` (ordered by `orderIdx`); each stop has its
`studentMappings[].student` list for the pickup roster.

## 4. Trip control
```
PATCH /api/trips/:tripId/status  { status: 'ON_SCHEDULE' | 'DELAYED' | 'COMPLETED' }
```
- `ON_SCHEDULE` → server stamps `startTime`
- `COMPLETED` → server stamps `endTime`
- Driver may only update own trip (403 otherwise)

## 5. Attendance
```
POST /api/attendance  { studentId, tripId, type: 'BOARDED' | 'ALIGHTED' }
```
RFID scan or manual tap → one row per event. Server checks the trip is yours
AND the student belongs to that trip's route/school.

**Offline queue / replay safety.** Send an `Idempotency-Key` header when flushing a
queued scan:
```
POST /api/attendance
  headers: Idempotency-Key: <any stable id for this scan, e.g. a uuid>
  body:    { studentId, tripId, type }
```
With the header present, a scan that repeats an existing one for the same
`studentId` + `tripId` + `type` within **10 minutes** returns **200** with the
original row plus `duplicate: true` — no second row, no second parent
notification. Never a 409. Without the header the request is always a fresh insert,
so send it for anything that came off the queue.

Caveat worth knowing: the server matches on the scan's natural key, not on the key
value you send. Two genuinely separate scans of the same student on the same trip
with the same type inside 10 minutes collapse into one.

`attendanceLogs[].timestamp` is always present (server-stamped, never null) and is
the server's receipt time, not the phone's. In `GET /api/drivers/:id/trips` the list
is scoped to **today** — it answers "who is already aboard", not trip history.

## 5.1 Trip fields — what is real and what is not

| Field | Status |
|-------|--------|
| `status` | real: `PLANNED` / `ON_SCHEDULE` / `DELAYED` / `COMPLETED` / `CANCELLED` |
| `startTime` | real: stamped server-side the moment status becomes `ON_SCHEDULE`. `null` while `PLANNED` |
| `endTime` | real: stamped when status becomes `COMPLETED` |
| `progressPercent` | ⚠️ **dead column — always `0`.** Nothing writes it. Do not render it |
| `delayMinutes` | ⚠️ **dead column — always `0`** |
| `currentEtaMessage` | ⚠️ **dead column — always `null`** |

You were right to not guess: `progressPercent` is neither stop-based nor
distance-based, it is simply never computed. If you want progress today, derive it
client-side from `attendanceLogs` against `route.stops` (stops covered ÷ total), or
ask backend to compute it server-side.

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
`acknowledged` is `true` once an admin resolves the alert
(`POST /api/notifications/:id/resolve` sets `status: 'RESOLVED'`). Readable by the
driver who raised it, any admin of that school, and SUPER_ADMIN.

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
→ { deviceId, deviceSecret }              // for the driver's active-trip bus
404 → no active trip with an assigned device
```
Fetch it only when you actually begin phone-based tracking, store in secure
storage, and clear on logout.

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
