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
→ [{ id, status, route:{ name, stops:[{ name, lat, lng, orderIdx,
        studentMappings:[{ student:{ id,name,rfidTag,grade } }] }] }, bus:{...} }]
```
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
             msg = `${deviceId}.${timestamp}.${lat}.${lng}` )  → hex
```
The `deviceSecret` is issued **once** when a bus is created (Super Admin
Console). It must be provisioned into the phone (config screen for the driver,
QR code, etc.) — the app cannot fetch it later from the API.

Timestamp skew tolerance: **300 seconds**. Use the phone clock.

**JS example:**
```js
import crypto from 'crypto';
const timestamp = Math.floor(Date.now() / 1000);
const signature = crypto
  .createHmac('sha256', deviceSecret)
  .update(`${deviceId}.${timestamp}.${lat}.${lng}`)
  .digest('hex');

await fetch(`${API_BASE}/api/telemetry`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Device-Signature': signature,
    'X-Device-Timestamp': String(timestamp),
  },
  body: JSON.stringify({ deviceId, lat, lng, speed }),
});
```

**Flutter example:**
```dart
final ts = (DateTime.now().millisecondsSinceEpoch ~/ 1000).toString();
final body = '$deviceId.$ts.$lat.$lng';
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
  body: jsonEncode({'deviceId': deviceId, 'lat': lat, 'lng': lng, 'speed': speed}),
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
