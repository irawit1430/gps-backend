# Parent App (Mobile) — Integration Spec

**Platform:** iOS + Android (Flutter / React Native / Expo)
**Role:** `PARENT` · **Scope:** own children only.

Read [`README.md`](./README.md) first (auth, socket, breaking changes).

---

## Screens (7 total)

| # | Screen | Purpose |
|---|--------|---------|
| 1 | **Login** | Authenticate (+ forced reset if `mustResetPassword`) |
| 2 | **My Children (Home)** | List of children + assigned bus/driver |
| 3 | **Live Track** | Child's bus on a live map + ETA |
| 4 | **Leaves** | List + submit leave requests |
| 5 | **Notifications** | Boarding / arrival / delay alerts |
| 6 | **Preferences** | Notification toggles |
| 7 | **Profile** | Basic account info |

---

## 1. Login
`POST /api/auth/login`. If `user.mustResetPassword === true` → force change-password screen before proceeding.

Handle `429` (too many attempts): show "Try again in a minute."

## 2. My Children (Home)
```
GET /api/parents/:parentId/students
→ [{ id, name, grade, photoUrl, routeStopName, driverName, licensePlate }]
```
Use `parentId = user.id` from login response. `driverName` / `licensePlate`
= `"Unassigned"` when no active trip.

## 3. Live Track — Socket.IO (REQUIRED auth 🔴)
The old app connected `io(url)` with no auth. **New backend rejects that.** Pattern:

**Flutter (`socket_io_client`):**
```dart
final socket = IO.io(
  SOCKET_URL,                          // wss://api.voltava.in
  IO.OptionBuilder()
      .setTransports(['websocket'])
      .setAuth({'token': jwtToken})    // REQUIRED
      .build(),
);
socket.on('connect_error', (data) {
  // 'Unauthorized: invalid token' → go to login
});
socket.on('location_update', (data) {
  // { busId, licensePlate, lat, lng, speed, driverName, routeName, timestamp }
});
```

**React Native (`socket.io-client`):**
```js
import { io } from 'socket.io-client';
const socket = io(SOCKET_URL, {
  auth: { token: jwt },
  transports: ['websocket'],
});
```

Backend now scopes events per school automatically — you'll only receive
`location_update` for buses in the child's school. Match on `licensePlate` /
`busId` from step 2 and move the marker.

**ETA:** use `trip.currentEtaMessage` / `delayMinutes` if returned; else
compute client-side from geodesic distance to next stop.

> Since backend runs Postgres + Socket.IO (no Firestore), get live location
> over the **WebSocket** — do NOT add `firebase_core` / `cloud_firestore` for
> tracking.

## 4. Leaves
```
GET  /api/parents/:parentId/leaves
     → [{ id, startDate, endDate, reason, notes, status, student:{name} }]
POST /api/leaves  { studentId, startDate, endDate, reason, notes? }
```
Parent may only submit for own child (server enforces; 403 otherwise).
Dates as ISO strings (`new Date().toISOString()`).

## 5. Notifications
```
GET  /api/parents/:parentId/notifications
     → [{ id, title, message, type, isRead, createdAt }]
POST /api/notifications/:id/read
POST /api/notifications/mark-read
```
Empty list = real empty state (no more mock rows).

## 6. Preferences
```
PATCH /api/parents/:id/preferences   { any toggle JSON, e.g. {arrival:true, delay:false} }
→ { preferences: {...} }
```
Saved object also returned in `user.preferences` on next login.

## 7. Profile
Read from the cached `user` object; no dedicated GET endpoint (extend backend if needed).

---

## Config (mobile — no CORS)

**Flutter:**
```bash
flutter run --dart-define=API_BASE_URL=https://api.voltava.in \
            --dart-define=SOCKET_URL=wss://api.voltava.in
```
Read via:
```dart
const API_BASE = String.fromEnvironment('API_BASE_URL');
const SOCKET_URL = String.fromEnvironment('SOCKET_URL');
```

**React Native / Expo:**
```env
# .env
EXPO_PUBLIC_API_BASE_URL=https://api.voltava.in
EXPO_PUBLIC_SOCKET_URL=wss://api.voltava.in
```
Read via `process.env.EXPO_PUBLIC_API_BASE_URL`.

Mobile apps do NOT hit CORS — you can connect from any device/emulator directly.

---

## Storage
Use **secure storage**, not plain preferences:
- iOS: Keychain (`flutter_secure_storage` / `expo-secure-store`)
- Android: EncryptedSharedPreferences / same libs

Keys: `token`, `user` (JSON).

## Global 401 handling
Wrap your HTTP client (Dio / axios / fetch) so any `401` clears storage and
navigates to Login. See `api-client.example.js` for the JS pattern.

## Push notifications (optional, later)
Backend has FCM support wired but **disabled** in current setup (no
`FIREBASE_SERVICE_ACCOUNT`). Skip FCM for now — in-app list + Socket.IO events
cover the parent flow. Ask backend ops to re-enable when you want OS push.
