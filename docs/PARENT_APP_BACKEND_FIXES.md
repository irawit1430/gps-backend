# Voltava parent app backend remediation

Date: 19 September 2026
Scope: backend changes required by the 34-finding parent-app audit

## Delivery status

The eight backend work blocks identified from the audit are implemented. The change is additive: existing IDs and primary API response fields remain valid, legacy leave timestamps are migrated, the old single `fcmToken` flow remains available during mobile migration, and new response fields can be adopted incrementally.

This repository does not contain the Expo parent app. The backend now supplies the facts and operations the app was missing; the client work listed under **Mobile integration required** must be completed in the mobile repository before the original 34 findings can all be closed.

## What changed

### 1. Authoritative child journey state

`GET /api/parents/:parentId/students` now:

- selects only trips that match the child's route mapping and direction;
- scopes attendance to the selected trip and school-local date;
- never applies an old morning scan to an afternoon journey;
- returns `journeyState`, `schoolDate`, `timezone`, `syncedAt`, `readiness`, `nextJourney`, and `leavePolicy`;
- labels clock-derived arrival information with `etaKind`, `etaConfidence`, `etaStatus`, `overdue`, and `arrivalConfirmed: false`;
- uses `DROP_OFF_RECORDED` rather than asserting safe arrival.

The existing fields such as `tripStatus`, `attendance`, `stopEtaAt`, `stopEtaMinutes`, and `etaBasis` remain present for compatible clients.

### 2. Drop-off and stop-arrival evidence

`POST /api/attendance` accepts optional evidence:

```json
{
  "studentId": "uuid",
  "tripId": "uuid",
  "type": "ALIGHTED",
  "stopId": "uuid",
  "lat": 12.9716,
  "lng": 77.5946,
  "handoverConfirmed": true
}
```

The server verifies that the stop belongs to the child, route and journey direction. It stores the stop snapshot, recorder, measurement time, distance from the expected stop and an evidence status. Latitude and longitude must be supplied together. Handover may only be confirmed for an `ALIGHTED` record.

Drivers and school admins can record route progress independently:

```http
POST /api/trips/:tripId/stops/:stopId/events
Idempotency-Key: <installation-generated key>

{
  "type": "ARRIVED",
  "occurredAt": "2026-09-19T07:42:00.000Z",
  "lat": 12.9716,
  "lng": 77.5946
}
```

The parent trip timeline advances only from an exact attendance stop or an explicit `ARRIVED` event. Elapsed schedule time no longer proves that a stop was passed.

### 3. Emergency incident lifecycle

Incidents retain `ACTIVE` and `RESOLVED` lifecycle state. Resolution now records who resolved it, when, and an optional reason. A parent's acknowledgement is stored separately and never resolves the incident.

New or expanded endpoints:

```http
GET  /api/parents/:parentId/alerts?status=ACTIVE
GET  /api/alerts/:id
POST /api/alerts/:id/acknowledge
PATCH /api/alerts/:id
POST /api/notifications/:id/resolve
```

The parent alert list returns all relevant incidents, affected `studentIds`, acknowledgement state and resolution state. Updating an incident invalidates earlier acknowledgement because the incident `updatedAt` changes. Incident, trip and student context is retained in notification payloads.

### 4. Push registration and readiness

The new push-device contract supports several installations per user and requires an explicit platform and provider:

```http
POST /api/users/me/push-devices

{
  "deviceId": "stable-installation-id",
  "platform": "ANDROID",
  "provider": "FCM",
  "token": "fcm-registration-token"
}
```

For iOS, the token must also be an FCM registration token. An APNs device token is rejected by contract because this backend sends through Firebase Admin.

Other endpoints:

```http
DELETE /api/users/me/push-devices/:deviceId
GET    /api/users/me/notification-readiness
```

Readiness reports server configuration, registered installations, accepted-delivery history, email availability, SMS unavailability and saved preferences. Push fan-out now uses every active installation, respects `pushNotifications: false`, disables invalid tokens, and records accepted handoff to FCM. The legacy `/api/users/me/fcm-token` endpoint remains during migration.

### 5. Leave workflow

Leave requests now support:

- `scope: SCHOOL | TRANSPORT`;
- `direction: TO_SCHOOL | FROM_SCHOOL | null`;
- school-calendar `YYYY-MM-DD` values;
- `Idempotency-Key` retry protection;
- atomic overlap checking;
- pending edits and cancellation;
- approved-leave cancellation requests that remain effective until school confirmation;
- decision reasons, decision actor/time, audit history, and status-change notifications;
- optional school `leaveCutoffMinutes` and `leaveResponseHours` policies;
- direction-aware driver rosters, so an afternoon-only transport absence does not hide a child from the morning roster.

Endpoints:

```http
POST   /api/leaves
PATCH  /api/leaves/:id
DELETE /api/leaves/:id
PUT    /api/leaves/:id/cancel
PUT    /api/leaves/:id/approve
PUT    /api/leaves/:id/reject
```

`DELETE` preserves compatibility: a successfully cancelled request returns `204`. A parent's cancellation request for an approved leave returns `202` with the still-effective leave.

### 6. School timezone contract

Every school now has an IANA `timezone`, defaulting to `Asia/Kolkata`. Date-only leave values, daily parent status and recurring-run departures use that timezone. The migration derives `startDay` and `endDay` for existing leave rows while preserving the original timestamps.

School create/update also accepts:

```json
{
  "timezone": "Asia/Kolkata",
  "supportHours": "Mon-Sat 07:00-18:00",
  "leaveCutoffMinutes": 60,
  "leaveResponseHours": 4
}
```

### 7. Actionable notifications and inbox

Notification rows can carry structured `context` such as `studentId`, `tripId`, `incidentId`, `attendanceId`, or `leaveId`.

New operations:

```http
GET  /api/users/me/notifications/unread-count
POST /api/notifications/mark-read
```

`mark-read` accepts an `ids` array or a `before` timestamp. With no body it marks records created before request handling, so a notification arriving during the operation is not accidentally consumed. Existing per-item read remains supported.

### 8. History, support, account requests and reconciliation

Attendance history supports cursor pagination while preserving the legacy array response. Use `?page=1` for the new envelope:

```http
GET /api/parents/:parentId/students/:studentId/attendance?page=1&limit=20&cursor=<last-id>
```

The response includes trip direction, service date, school date and captured stop evidence. The next cursor is returned in `nextCursor` and `X-Next-Cursor`.

Public support details are available before login:

```http
GET /api/public/schools/:schoolId/support
```

Authenticated users can submit and follow correction/data/linking/discrepancy requests:

```http
POST /api/users/me/requests
GET  /api/users/me/requests
GET  /api/schools/:schoolId/account-requests
PATCH /api/account-requests/:id
```

Parents now receive `journey_changed`, `leave_changed`, `emergency_alert`, and `account_request_changed` socket events for relevant server-side state changes. The app should treat these as invalidation signals and refetch authoritative data.

## Database migration

Migration: `prisma/migrations/10_parent_trust_contracts/migration.sql`

It adds:

- school timezone, support and leave-policy fields;
- attendance evidence and exact request keys;
- leave scope, direction, date-only values, idempotency, decisions and history;
- emergency resolution and audience fields;
- notification context;
- `PushDevice`, `IncidentAcknowledgement`, `StopEvent`, and `AccountRequest` tables.

Deploy in this order:

1. Back up PostgreSQL.
2. Run `npm run migrate:deploy` once for the release.
3. Deploy the backend.
4. Set each school's timezone, verified support contacts and leave policy.
5. Confirm `FIREBASE_SERVICE_ACCOUNT` is configured.
6. Upgrade the mobile app to the contracts below.

The migration is additive and backfills legacy leave calendar values. It does not delete existing rows.

## Mobile integration required

The parent app must still make its UI and lifecycle changes in its own repository:

1. Render the backend `journeyState` and evidence fields; never convert `DROP_OFF_RECORDED` into “safe arrival.”
2. Refetch parent students, alerts, leaves and notifications on foreground, reconnect and matching socket events.
3. Mount the emergency surface above the authenticated navigation tree; keep unresolved incidents visible after acknowledgement.
4. Register a stable installation through `/push-devices`; on iOS obtain an FCM registration token rather than posting an APNs token.
5. Show `/notification-readiness` states with Open Settings and retry actions.
6. Send leave dates as `YYYY-MM-DD`, add scope/direction, use an `Idempotency-Key`, and expose edit/cancel/decision reason flows.
7. Route notification taps once using structured context; consume/deduplicate the native response.
8. Use exact child IDs in navigation; do not silently fall back to another child.
9. Use paginated attendance history and distinguish error, empty and unavailable states.
10. Add route/timeline navigation and use only `passedAt` as confirmed progress.
11. Keep cached child/contact data on refresh failures and label it with `syncedAt`.
12. Complete accessibility, large-text, map-follow and all-children-summary work from the original audit.
13. Protect every private route and restore a safe destination/draft after reauthentication.

## Verification completed

- Prisma schema validation: passed.
- Prisma Client generation: passed.
- JavaScript syntax checks: passed.
- Jest: **274 tests passed across 36 suites**.
- Dependency audit: **0 vulnerabilities** after lockfile updates.
- Regression coverage includes trip-scoped attendance, journey direction, ETA confidence, timezone/DST behavior, leave idempotency and transitions, cutoff policy, stop/drop evidence, roster direction, tenant authorization and legacy compatibility.

Native Android/iOS push delivery and UI journeys cannot be verified from this backend repository. They remain release gates for the mobile build.
