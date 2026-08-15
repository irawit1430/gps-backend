# School Admin Console (Next.js) — Integration & Migration Spec

**Repo:** `irawit1430/school-` · **Stack:** Next.js 15 + React 19 + Tailwind + socket.io-client
**Role:** `SCHOOL_ADMIN` · **Scope:** ONE school (`user.schoolId`)

> This doc is a **migration guide** — it names exact files/lines in the current
> code and shows what to change to move from Render → the new GCP backend.
> Read [`README.md`](./README.md) first for shared auth/socket/error rules.

---

## 0. TL;DR — the 4 changes that unblock everything

1. **Centralize the API URL** in `lib/config.ts` (env-driven).
2. **Swap** `https://gps-backend-jzd7.onrender.com` → `https://api.voltava.in`
   in **every** hardcoded place (list below).
3. **Authenticate every Socket.IO connection** — the new backend **rejects**
   `io(url)` without a token. 🔴 App will break otherwise.
4. **Handle 401 globally** — token now expires in 24h; force re-login.

Everything else in this doc is the details for each of those.

---

## 1. Where the old URL is hardcoded (rip these out)

`grep -rn "gps-backend-jzd7.onrender.com"` today finds it in **6 non-test files**:

| File | Line | What it does |
|------|:----:|--------------|
| `lib/api.ts` | 1 | `export const API_BASE = 'https://gps-backend-jzd7.onrender.com/api'` |
| `components/login/LoginForm.tsx` | 18 | Login POST |
| `components/layout/Header.tsx` | 80, 124, 154, 170 | Notifications + search + mark-read |
| `components/views/LiveFleetMap.tsx` | 26 | `io("...")` — socket |
| `components/layout/EmergencyAlertBanner.tsx` | 20 | `io("...")` — socket |

**Do NOT just find-and-replace the string** — instead, move it into one
config module (step 2) and import it. That way tomorrow's URL change (staging /
prod / preview) is one line.

---

## 2. Create `lib/config.ts` (single source of truth)

```ts
// lib/config.ts
const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || 'https://api.voltava.in';

const SOCKET_URL =
  process.env.NEXT_PUBLIC_SOCKET_URL || 'wss://api.voltava.in';

export const CONFIG = {
  API_BASE_URL,
  API_BASE: `${API_BASE_URL}/api`,      // convenience: base + `/api`
  SOCKET_URL,
  TOKEN_STORAGE_KEY: 'token',
  USER_STORAGE_KEY: 'user',
} as const;
```

Then env files:

```bash
# .env.local  (local dev — Vite/Next hot-reload picks this up)
NEXT_PUBLIC_API_BASE_URL=https://api.voltava.in
NEXT_PUBLIC_SOCKET_URL=wss://api.voltava.in

# .env.production  (Vercel/Netlify build — same values, override per env if needed)
NEXT_PUBLIC_API_BASE_URL=https://api.voltava.in
NEXT_PUBLIC_SOCKET_URL=wss://api.voltava.in
```

⚠️ Next.js only exposes vars prefixed **`NEXT_PUBLIC_`** to the browser. Client
components can't read anything else.

---

## 3. Update `lib/api.ts` (auth helpers + 401 handling)

Replace the top of `lib/api.ts`:

```ts
// lib/api.ts (top)
import { CONFIG } from './config';

export const API_BASE = CONFIG.API_BASE;   // keep this export for existing imports

const getToken = () =>
  typeof window !== 'undefined' ? localStorage.getItem(CONFIG.TOKEN_STORAGE_KEY) : null;

const getHeaders = () => {
  const token = getToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
};

// Central fetch wrapper — every request goes through this
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...getHeaders(), ...(init.headers || {}) },
  });

  // 🔴 24h token expiry — kick to login on any 401
  if (res.status === 401) {
    if (typeof window !== 'undefined') {
      localStorage.removeItem(CONFIG.TOKEN_STORAGE_KEY);
      localStorage.removeItem(CONFIG.USER_STORAGE_KEY);
      window.location.href = '/login';
    }
    throw new Error('Session expired');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // New backend: { error: '...', issues?: [{path,message}] }
    const err: any = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.issues = data.issues;
    throw err;
  }
  return data as T;
}

export { request };
```

Then convert existing `fetch(...)` calls in the same file to `request(...)`:

```ts
// before
export const fetchBuses = async () => {
  const schoolId = await getSchoolId();
  const res = await fetch(`${API_BASE}/schools/${schoolId}/buses`, { headers: getHeaders() });
  if (!res.ok) throw new Error('Failed to fetch buses');
  return res.json();
};

// after
export const fetchBuses = async () => {
  const schoolId = await getSchoolId();
  if (!schoolId) throw new Error('No school ID found');
  return request(`/schools/${schoolId}/buses`);
};
```

Apply the same pattern to `fetchLeaves`, `fetchDrivers`, `fetchRoutes`,
`createStudent`, `assignStudentToStop`, etc. — every function in `lib/api.ts`.

Then update `Header.tsx` (lines 80, 124, 154, 170) to import & use these helpers
instead of raw `fetch(...)`. **Zero URL strings should remain outside `lib/config.ts`.**

---

## 4. Fix Socket.IO — REQUIRED to prevent app breakage

`LiveFleetMap.tsx:26` and `EmergencyAlertBanner.tsx:20` both do:

```ts
const socket = io("https://gps-backend-jzd7.onrender.com");   // ← WILL BE REJECTED
```

The new backend requires the JWT in the handshake. Create one shared helper:

```ts
// lib/socket.ts
import { io, Socket } from 'socket.io-client';
import { CONFIG } from './config';

export function connectSocket(): Socket {
  const token = localStorage.getItem(CONFIG.TOKEN_STORAGE_KEY);
  const socket = io(CONFIG.SOCKET_URL, {
    auth: { token },                 // ← REQUIRED
    transports: ['websocket'],
  });

  socket.on('connect_error', (err) => {
    // "Unauthorized: missing token" / "Unauthorized: invalid token"
    if (err.message?.startsWith('Unauthorized')) {
      localStorage.removeItem(CONFIG.TOKEN_STORAGE_KEY);
      localStorage.removeItem(CONFIG.USER_STORAGE_KEY);
      window.location.href = '/login';
    } else {
      console.error('[socket] connect_error:', err.message);
    }
  });

  return socket;
}
```

Replace both components' `io(...)` calls with `connectSocket()`.

**Bonus win:** you can now delete the `alert.schoolId === user.schoolId` filter
in `EmergencyAlertBanner.tsx` — the backend now sends each school only its own
events (per-school rooms), so the filter is redundant.

---

## 5. Update `LoginForm.tsx`

Two changes:

```ts
// components/login/LoginForm.tsx
import { CONFIG } from '@/lib/config';

// ...inside handleLogin:
const response = await fetch(`${CONFIG.API_BASE}/auth/login`, { ... });

// AFTER a successful login:
localStorage.setItem(CONFIG.TOKEN_STORAGE_KEY, data.token);
localStorage.setItem(CONFIG.USER_STORAGE_KEY, JSON.stringify(data.user));

// NEW: force password reset for auto-created accounts
if (data.user.mustResetPassword) {
  router.push('/reset-password');
  return;
}
router.push('/');
```

Also handle **rate-limit** (login is 5/min/IP):

```ts
if (response.status === 429) {
  alert('Too many login attempts — try again in a minute.');
  return;
}
```

And show the validation issue for the "wrong password" case using the JSON body:

```ts
const body = await response.json().catch(() => ({}));
if (!response.ok) {
  alert(body.error || 'Login failed');
  return;
}
```

---

## 6. Handle `null` stats in `Overview.tsx`

The old backend invented fake fallback numbers (`busesGrowthPercent: 12`,
`"Morning Route A (35 mins)"`). **They can now be `null`.**

Wherever the KPI cards render:
```tsx
<StatCard value={stats.busesGrowthPercent ?? '—'} suffix="%" />
<StatCard value={stats.mostEfficientRoute ?? 'No data yet'} />
<StatCard value={stats.averageRouteDuration ?? '—'} suffix=" min" />
```

`totalBuses`, `totalStudents`, `totalRoutes`, `pendingLeaves`, `activeDevices`,
`offlineDevices` are still always numbers.

---

## 7. Mock notifications are gone

If notifications list is empty, `GET /api/notifications` now returns `[]`
instead of injecting mock rows. Build a real empty state in `Header.tsx`
notification dropdown — icon + "No new notifications".

`lib/mock-data.ts` fallbacks that reference this are fine to keep for offline
demo, but do NOT rely on them being present in prod responses.

---

## 8. Screens & endpoints (unchanged)

| # | Screen (file) | Endpoints |
|---|---------------|-----------|
| 1 | Login (`app/login/page.tsx`) | `POST /api/auth/login` |
| 2 | Overview (`components/views/Overview.tsx`) | `GET /api/stats` |
| 3 | Live Map (`LiveFleetMap.tsx`) | `GET /api/schools/:id/buses` + socket `location_update` |
| 4 | Students & Attendance (`StudentsAttendance.tsx`) | `GET /api/schools/:id/students`, `GET /api/schools/:id/attendance/today`, `POST /api/schools/:id/students` |
| 5 | Manage Routes (`ManageRoutes.tsx`) | `GET/POST /api/schools/:id/routes`, `PUT/DELETE /api/routes/:id` |
| 6 | Drivers (`DriversList.tsx`) | `GET/POST /api/schools/:id/drivers` |
| 7 | Leave Requests (`LeaveRequests.tsx`) | `GET /api/schools/:id/leaves`, `PUT /api/leaves/:id/approve\|reject` |
| 8 | Header search/notifications (`Header.tsx`) | `GET /api/search`, `GET/POST /api/notifications*` |
| 9 | Emergency banner (`EmergencyAlertBanner.tsx`) | socket `emergency_alert` |

Endpoint contracts didn't change — see [`README.md`](./README.md) §5.

**New endpoints available if you want them:**
- `GET /api/schools/:schoolId/leaves/pending` — direct pending list
- `PUT /api/parent/leaves/:id { status: 'APPROVED'|'REJECTED' }` — single endpoint
- `POST /api/devices/:id/rotate-secret` — rotate a bus's telemetry HMAC secret

**Route Management — see [`route-management-osm.md`](./route-management-osm.md)**
The `POST /routes` endpoint now accepts stops[] in the same call (atomic).
There are also new `POST/PUT/DELETE /routes/:routeId/stops` + reorder endpoints.
Route model now has `geometry`, `distanceKm`, and stops have `address` +
`expectedArrivalMinutes`.

---

## 9. Local dev — connecting to the LIVE backend

Backend CORS already allows local Next.js origins (`localhost:3000`, `5173`,
`5174`, `8080`, `127.0.0.1:3000/5173`). To run:

```bash
# In the school- repo root
echo 'NEXT_PUBLIC_API_BASE_URL=https://api.voltava.in' > .env.local
echo 'NEXT_PUBLIC_SOCKET_URL=wss://api.voltava.in'    >> .env.local
npm install
npm run dev
```

Login with the seeded super-admin. **Any create/edit hits the LIVE database** —
use "Test School / Test Bus" style names so ops can clean them up later.

If you deploy this frontend (Vercel/Netlify), give backend ops the deployed
origin (e.g. `https://school.voltava.in`) to add to `CORS_ORIGINS`.

---

## 10. Migration checklist (paste into a PR)

- [ ] `lib/config.ts` created; `.env.local` set
- [ ] `lib/api.ts` uses `CONFIG.API_BASE`; central `request()` wrapper added
- [ ] `lib/socket.ts` created; `LiveFleetMap` + `EmergencyAlertBanner` use `connectSocket()`
- [ ] `LoginForm.tsx` uses `CONFIG`; handles `mustResetPassword` + 429
- [ ] `Header.tsx` uses `request()` for notifications/search/mark-read
- [ ] Overview handles `null` growth-percent / mostEfficientRoute / averageRouteDuration
- [ ] Global 401 → logout+redirect works (tested by deleting token)
- [ ] `grep -rn "gps-backend-jzd7.onrender.com"` returns **zero hits** in prod code
- [ ] `grep -rn "onrender.com"` returns **zero hits**
