# Super Admin Console (Web) — Integration Spec

**Platform:** Web (Next.js/Vite/React) · **Role:** `SUPER_ADMIN` · **Scope:** all schools, global.

Read [`README.md`](./README.md) first for auth/socket/breaking changes.

Structurally identical to the School Admin app — same auth, same central
`lib/config.ts` + `lib/api.ts` + `lib/socket.ts` pattern. Follow the migration
steps in [`school-admin-web.md`](./school-admin-web.md) §2–4 (config module,
central `request()`, authenticated socket) — they apply verbatim. The only
differences are the screens and endpoints below.

---

## Screens (11 total)

| # | Screen | Purpose |
|---|--------|---------|
| 1 | **Login** | Authenticate |
| 2 | **Global Dashboard** | Platform-wide KPIs |
| 3 | **Schools** | CRUD schools |
| 4 | **School detail** | One school's profile |
| 5 | **Devices / Hardware** | Provision & manage GPS trackers |
| 6 | **Live Map** | All devices on a map, real-time |
| 7 | **Admins** | Manage SUPER/SCHOOL admins |
| 8 | **Notifications** | SOS + system alerts |
| 9 | **Global Search** | Search schools/devices/admins |
| 10 | **System Logs** | Raw GPS logs |
| 11 | **Settings** | Maintenance mode, map center |

---

## 1. Login
`POST /api/auth/login`. Verify `user.role === 'SUPER_ADMIN'`. Handle `429`
(rate-limit) + `mustResetPassword` per README §1.7–1.8.

## 2. Global Dashboard
```
GET /api/stats           (or /api/admin/stats)
→ { totalSchools, totalBuses, activeDevices, offlineDevices,
    stationaryDevices, totalStudents,
    schoolsGrowthPercent, busesGrowthPercent }
```
⚠️ Growth percents may be `null` → render `—` (README §1.5).

## 3. Schools (CRUD)
```
GET    /api/schools?page=1&limit=50&search=abc   → { data:[], total, page, limit }
GET    /api/schools/:id                          → school
POST   /api/schools     { name, address?, contactPerson?, city?, state?, phone?, email? }
PUT    /api/schools/:id { ...same, all optional }
DELETE /api/schools/:id
```
Delete fails (400) if the school still has devices/routes — surface the error message.

## 5. Devices / Hardware 🔑

```
GET    /api/devices?page=1&limit=50&search=&schoolId=null|<id>
GET    /api/devices/:id
POST   /api/devices    { deviceId, licensePlate, capacity?, schoolId? }
        → returns the device + **deviceSecret (shown ONCE)**  🔑
PUT    /api/devices/:id { licensePlate?, capacity?, schoolId? }
DELETE /api/devices/:id
POST   /api/devices/:id/rotate-secret  → { deviceId, deviceSecret }  🔑
```

**🔑 `deviceSecret` is returned ONLY at create + rotate.** It's the HMAC key
the TM-100 uses to sign telemetry. UX must:

1. On successful create → open a modal:
   > "This is the device secret for **BB100-TEST-01**. Save it now — it will not be shown again."
   > `[copy to clipboard]  [I've saved it]`
2. Display in a **copy-once box** (monospace, "Reveal" then hide again).
3. On `rotate-secret` → same modal + a warning that the physical device must be
   re-flashed with the new secret or telemetry will stop.

`deviceSecret` is **never** included in `GET /api/devices` responses (backend
scrubs it) — do not rely on being able to fetch it later.

## 6. Live Map
- Initial markers: `GET /api/devices/locations?schoolId=<optional>`
  → `[{ busId, licensePlate, schoolName, lastKnownLat, lastKnownLng, speed, lastUpdate }]`
- Real-time: socket `location_update` — move the matching marker (README §4).
- Also handle `device_status_change` for online/offline dots.

SUPER_ADMIN is auto-joined to a `super:all` room server-side, so you receive
events for every school with no filter needed.

## 7. Admins
```
GET    /api/admins?page=&limit=&role=&schoolId=  → { data:[], total,... }
GET    /api/admins/:id
POST   /api/admins   { name, email, password(min 12), role:'SUPER_ADMIN'|'SCHOOL_ADMIN', schoolId? }
PUT    /api/admins/:id { name?, email?, password?, role?, schoolId? }
DELETE /api/admins/:id
```
Only SUPER_ADMIN may set/change `role` or `schoolId` (server enforces). You
**cannot delete yourself** (403).

## 8. Notifications
```
GET  /api/notifications?limit=20     → [{ id, type, title, message, status, isRead, createdAt }]
POST /api/notifications/mark-read
POST /api/notifications/:id/read
POST /api/notifications/:id/resolve  → resolve an SOS
```
Empty list = real empty state (README §1.6).

## 9. Global Search
```
GET /api/search?q=term → { schools:[], devices:[], admins:[], results:[] }
```

## 10. System Logs
```
GET /api/admin/logs?page=1&limit=100&busId=&schoolId=&startDate=ISO
→ { data:[{ id, busId, lat, lng, speed, timestamp, bus:{licensePlate} }], total,... }
```

## 11. Settings
```
GET /api/settings              → { maintenanceMode, mapCenterLat, mapCenterLng }
PUT /api/settings  { maintenanceMode?, mapCenterLat?, mapCenterLng? }
```

---

## Config
- Env: `NEXT_PUBLIC_API_BASE_URL=https://api.voltava.in` (Next.js) or
  `VITE_API_BASE_URL=...` (Vite).
- When deployed (e.g. `https://admin.voltava.in`), give backend ops the origin
  to add to `CORS_ORIGINS`.

Local dev is already CORS-allowed — see README §6.
