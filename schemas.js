const { z } = require('zod');

const ROLES = ['SUPER_ADMIN', 'SCHOOL_ADMIN', 'DRIVER', 'PARENT'];
const TRIP_STATUS = ['PLANNED', 'ON_SCHEDULE', 'DELAYED', 'COMPLETED', 'CANCELLED'];
const LEAVE_STATUS = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'];
// Must track the AttendanceType enum in schema.prisma. These are two copies of one
// fact in two languages, which is the shape that produced six DELAYED bugs across
// four codebases — a value added to the database and not here is accepted by Postgres
// and rejected by validation, which reads as a client bug.
const ATTENDANCE_TYPE = ['BOARDED', 'ALIGHTED', 'NO_SHOW'];
const EMERGENCY_TYPE = ['DRIVER_SOS', 'HARDWARE_SOS', 'ADMIN_BROADCAST', 'DELAY'];
// Mirrors RunDirection in schema.prisma. A run carries it; a trip copies it.
const RUN_DIRECTION = ['TO_SCHOOL', 'FROM_SCHOOL'];

const uuid = z.string().uuid();
const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);
const { validZone, dateValue } = require('./schoolTime');
const schoolDate = z.string().refine(v => Boolean(dateValue(v)), 'Expected a valid calendar date or timezone-qualified timestamp');

exports.login = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});

exports.telemetry = z.object({
  deviceId: z.string().min(1).max(64),
  lat,
  lng,
  speed: z.number().min(0).max(300).optional(),
  timestamp: z.union([z.string().datetime(), z.number().int().positive()]).optional(),
});

exports.createSchool = z.object({
  name: z.string().min(1).max(200),
  timezone: z.string().refine(validZone, 'Invalid IANA timezone').optional(),
  supportHours: z.string().max(300).optional().nullable(),
  leaveCutoffMinutes: z.number().int().min(0).max(10080).optional().nullable(),
  leaveResponseHours: z.number().int().min(1).max(720).optional().nullable(),
  stopDwellMinutes: z.number().min(0).max(10).optional().nullable(),
  address: z.string().max(500).optional().nullable(),
  contactPerson: z.string().max(200).optional().nullable(),
  city: z.string().max(100).optional().nullable(),
  state: z.string().max(100).optional().nullable(),
  phone: z.string().max(30).optional().nullable(),
  email: z.string().email().optional().nullable(),
  contactEmail: z.string().email().optional().nullable(),
  contactPhone: z.string().max(30).optional().nullable(),
  website: z.string().max(200).optional().nullable(),
  pincode: z.string().max(20).optional().nullable(),
  latitude: lat.optional().nullable(),
  longitude: lng.optional().nullable(),
  status: z.enum(["ACTIVE", "PENDING", "SUSPENDED"]).optional(),
});

exports.updateSchool = exports.createSchool.partial();

// What a school's own admin may change about how its buses are timed. null goes back
// to the server default.
exports.schoolTransport = z.object({
  stopDwellMinutes: z.number().min(0).max(10).nullable(),
}).strict();

// qrToken is accepted on the way IN and never sent back out — a school arriving with
// cards already printed has to be able to tell us what is on them, but knowing a token
// is enough to print a working duplicate. Only POST /api/schools/:id/qr-cards emits it.
const importedQrToken = z.string().trim().min(4).max(128);

exports.createStudent = z.object({
  schoolId: uuid.optional(),
  rfidTag: z.string().max(64).optional().nullable(),
  name: z.string().min(1).max(200),
  grade: z.string().max(50).optional().nullable(),
  guardianPhone: z.string().min(6).max(20).optional().nullable(),
  parentEmail: z.string().email().optional().nullable(),
  parentName: z.string().max(200).optional().nullable(),
  qrToken: importedQrToken.optional(),
  // The child's stop, saved in the same transaction as the child. Two requests left a
  // child created with no stop whenever the second one failed.
  routeStopId: uuid.optional().nullable(),
  direction: z.enum(RUN_DIRECTION).optional().nullable(),
});

// Only real Student columns are updatable. createStudent also carries
// parentEmail/parentName/schoolId (used for provisioning / tenant), which are NOT
// direct Student columns — passing them to student.update would 500, and letting a
// SCHOOL_ADMIN change schoolId would move the student cross-tenant. So whitelist here.
exports.updateStudent = z.object({
  name: z.string().min(1).max(200).optional(),
  grade: z.string().max(50).optional().nullable(),
  rfidTag: z.string().min(1).max(64).optional(),
  photoUrl: z.string().max(500).optional().nullable(),
  guardianPhone: z.string().min(6).max(20).optional().nullable(),
  // Attaching a card to a student who already exists — the common case when a school
  // onboards students first and their existing cards afterwards.
  qrToken: importedQrToken.optional(),
});

exports.updateDriver = z.object({
  name: z.string().min(1).max(200).optional(),
  email: z.string().email().optional(),
  password: z.string().min(8).max(200).optional(),
  phone: z.string().min(6).max(20).optional().nullable(),
});


exports.createDevice = z.object({
  deviceId: z.string().min(1).max(64),
  licensePlate: z.string().min(1).max(32),
  capacity: z.number().int().positive().max(200).optional(),
  schoolId: uuid.optional().nullable(),
  status: z.enum(["ONLINE", "OFFLINE"]).optional(),
});

exports.updateDevice = exports.createDevice.partial();

exports.createDriver = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email(),
  phone: z.string().min(6).max(20).optional().nullable(),
});

exports.createAdmin = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email(),
  password: z.string().min(12).max(200),
  role: z.enum(['SUPER_ADMIN', 'SCHOOL_ADMIN']),
  schoolId: uuid.optional().nullable(),
});

exports.updateAdmin = z.object({
  name: z.string().min(1).max(200).optional(),
  email: z.string().email().optional(),
  password: z.string().min(12).max(200).optional(),
  role: z.enum(['SUPER_ADMIN', 'SCHOOL_ADMIN']).optional(),
  schoolId: uuid.optional().nullable(),
});

exports.createTrip = z.object({
  routeId: uuid,
  busId: uuid,
  driverId: uuid,
  // Planned departure. Stop ETAs are anchored to it until the trip actually starts.
  scheduledStart: z.string().datetime().optional().nullable(),
  // Which way the bus is going. Optional only because every trip created before this
  // existed has none, and rejecting those would break the one-off replacement service
  // that manual creation exists for. Omitting it costs the driver app its stop order
  // and the parent app its wording, so the UI should always send it.
  direction: z.enum(RUN_DIRECTION).optional().nullable(),
});

exports.updateTrip = z.object({
  routeId: uuid.optional(),
  busId: uuid.optional(),
  driverId: uuid.optional(),
  scheduledStart: z.string().datetime().optional().nullable(),
  direction: z.enum(RUN_DIRECTION).optional().nullable(),
});

exports.tripStatus = z.object({
  status: z.enum(TRIP_STATUS),
  // Starting a trip with no GPS from the bus is allowed only as a stated decision: the
  // driver's reason goes to the school's admins at once (see the status route).
  gpsOverrideReason: z.string().trim().min(3).max(200).optional(),
});

// The driver app's walk-around before a trip: all six checks, each once, each stamped
// with when the driver ticked it.
const PRE_TRIP_ITEMS = ['tyres', 'brakes', 'lights', 'mirrors', 'firstaid', 'doors'];
exports.preTripCheck = z.object({
  items: z
    .array(z.object({ id: z.enum(PRE_TRIP_ITEMS), ok: z.boolean(), checkedAt: z.string().datetime() }))
    .length(PRE_TRIP_ITEMS.length)
    .refine((items) => new Set(items.map((i) => i.id)).size === items.length, {
      message: 'Each check must appear exactly once',
    }),
  note: z.string().trim().max(1000).optional(),
});

exports.attendance = z.object({
  studentId: uuid,
  tripId: uuid,
  type: z.enum(ATTENDANCE_TYPE),
  // When the scan actually happened, for anything replayed off the offline queue.
  // Without it a scan taken at 07:30 and flushed at 08:30 is recorded as 08:30, and
  // once the trip has ended it is refused outright — losing a boarding that really
  // happened, at the end of a route, which is exactly where signal dies. Omit it and
  // the server stamps receipt time, as before.
  occurredAt: z.string().datetime().optional(),
  // Only honoured for an admin — a driver's scan is always a SCAN. MANUAL suppresses
  // the parent notification, so a driver must not be able to record silently.
  source: z.enum(['SCAN', 'MANUAL']).optional(),
  stopId: uuid.optional(),
  lat: lat.optional(),
  lng: lng.optional(),
  handoverConfirmed: z.boolean().optional(),
});

exports.leaveApp = z.object({
  studentId: uuid,
  startDate: schoolDate,
  endDate: schoolDate,
  scope: z.enum(['SCHOOL', 'TRANSPORT']).optional(),
  direction: z.enum(RUN_DIRECTION).optional().nullable(),
  reason: z.string().min(1).max(500),
  notes: z.string().max(2000).optional().nullable(),
});

exports.leaveStatus = z.object({
  status: z.enum(['APPROVED', 'REJECTED']),
  reason: z.string().max(1000).optional(),
});

const stopInput = z.object({
  name: z.string().min(1).max(200),
  address: z.string().max(500).optional().nullable(),
  lat,
  lng,
  orderIdx: z.number().int().min(0).max(1000),
  expectedArrivalMinutes: z.number().int().min(0).max(1440).optional().nullable(),
});

exports.createRoute = z.object({
  name: z.string().min(1).max(200),
  estimatedDuration: z.number().int().positive().max(1440).optional().nullable(),
  distanceKm: z.number().nonnegative().max(1000).optional().nullable(),
  geometry: z.string().max(65535).optional().nullable(),
  stops: z
    .array(stopInput)
    .min(2, 'A route needs at least 2 stops')
    .max(100)
    .refine(
      (arr) => new Set(arr.map((s) => s.orderIdx)).size === arr.length,
      { message: 'stops.orderIdx values must be unique' }
    ),
});

exports.updateRoute = z.object({
  name: z.string().min(1).max(200).optional(),
  estimatedDuration: z.number().int().positive().max(1440).optional().nullable(),
  distanceKm: z.number().nonnegative().max(1000).optional().nullable(),
  geometry: z.string().max(65535).optional().nullable(),
});

exports.createStop = stopInput;
exports.updateStop = stopInput.partial();
exports.reorderStops = z
  .array(z.object({ id: uuid, orderIdx: z.number().int().min(0).max(1000) }))
  .min(1)
  .max(100)
  .refine(
    (arr) => new Set(arr.map((s) => s.id)).size === arr.length,
    { message: 'reorder items must have unique ids' }
  )
  .refine(
    (arr) => new Set(arr.map((s) => s.orderIdx)).size === arr.length,
    { message: 'reorder orderIdx values must be unique' }
  );

exports.sos = z.object({
  schoolId: uuid.optional(),
  message: z.string().max(500).optional().nullable(),
  tripId: uuid.optional().nullable(),
  type: z.enum(EMERGENCY_TYPE).optional(),
});

// Card printing takes explicit ids rather than a whole school: this is the only
// response in the system that emits qrToken, and a GET returning everything would sit
// in browser history and any school proxy log. 600 is a full school in one request.
exports.qrCards = z.object({
  studentIds: z.array(uuid).min(1).max(600).refine(
    (ids) => new Set(ids).size === ids.length,
    { message: 'studentIds must be unique' }
  ),
});

// Resolving a scanned card that is not on the driver's own roster.
exports.qrLookup = z.object({
  qrHash: z.string().regex(/^[0-9a-f]{64}$/, 'expected a sha256 hex digest'),
});

// Moving an existing assignment (PUT /api/student-route-mappings/:id). studentId is
// not accepted: a mapping belongs to the student it was created for, and letting the
// body name a different one would move one child's stop onto another child.
//
// Omitting `direction` KEEPS the leg the mapping already serves — it does not widen it
// back to both. Send `direction: null` explicitly to do that. Same convention as
// PUT /api/trips/:tripId.
exports.moveMapping = z.object({
  routeStopId: uuid,
  direction: z.enum(RUN_DIRECTION).optional().nullable(),
});

exports.mapping = z.object({
  studentId: uuid,
  routeStopId: uuid,
  // Which leg this stop serves. Omitted means both, which is what every mapping made
  // before this column meant — send it only when the morning and afternoon stops
  // genuinely differ.
  direction: z.enum(RUN_DIRECTION).optional().nullable(),
});

exports.globalSettings = z.object({
  maintenanceMode: z.boolean().optional(),
  mapCenterLat: lat.optional(),
  mapCenterLng: lng.optional(),
  mapDefaultZoom: z.number().int().optional(),
  overspeedLimitKph: z.number().int().optional(),
  offlineAlertMinutes: z.number().int().optional(),
  alertEmail: z.string().email().optional(),
});

exports.forgotPassword = z.object({
  email: z.string().email(),
});

exports.changePassword = z.object({
  oldPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8).max(200),
});

exports.preferences = z.object({
  emailAlerts: z.boolean().optional(),
  smsAlerts: z.boolean().optional(),
  pushNotifications: z.boolean().optional(),
  geofenceAlerts: z.boolean().optional(),
  delayAlerts: z.boolean().optional(),
}).passthrough();

exports.ROLES = ROLES;
exports.TRIP_STATUS = TRIP_STATUS;
exports.LEAVE_STATUS = LEAVE_STATUS;
exports.ATTENDANCE_TYPE = ATTENDANCE_TYPE;
exports.EMERGENCY_TYPE = EMERGENCY_TYPE;


// One message from the school office to one family (POST /api/parents/:parentId/messages).
// Parent invites (parentInvites.js). EMAIL is sent by the server; the rest hand the
// code back for school staff to pass on.
const INVITE_CHANNEL = ['EMAIL', 'WHATSAPP', 'SMS', 'PRINT', 'COPY'];
exports.parentInvite = z.object({ channel: z.enum(INVITE_CHANNEL) }).strict();
// Batches are small on purpose: each invite is a bcrypt hash and, by email, an SMTP
// round trip. The dashboard sends a school's worth as a run of these.
exports.parentInviteBatch = z.object({
  parentIds: z.array(uuid).min(1).max(50),
  channel: z.enum(['EMAIL', 'PRINT']),
}).strict();

// Scans the server refused, sent by the driver to the school office to decide. Kept on
// the phone until the office closes the case.
const reviewScan = z.object({
  studentId: uuid,
  tripId: uuid,
  type: z.enum(ATTENDANCE_TYPE),
  occurredAt: z.string().datetime(),
  source: z.enum(['SCAN', 'MANUAL']).default('SCAN'),
  reason: z.string().trim().max(300).default(''),
  idempotencyKey: z.string().min(1).max(200),
});
exports.attendanceReviewCase = z.object({
  scans: z.array(reviewScan).min(1).max(200),
  note: z.string().trim().max(500).optional(),
  // The phone's own id for this submission: a retry after a lost reply finds the same case.
  clientKey: z.string().min(8).max(100),
}).strict();
exports.attendanceReviewDecision = z.object({
  status: z.enum(['RESOLVED', 'REJECTED']),
  reason: z.string().trim().min(1).max(500),
  // RESOLVED only: write the scans into the record as office corrections (MANUAL).
  record: z.boolean().optional(),
}).strict();

// The driver app could not start tracking for a trip it has just started.
exports.trackingProblem = z.object({
  reason: z.enum(['permission', 'provisioning', 'transient']),
  message: z.string().trim().max(300).optional(),
}).strict();

exports.parentMessage = z.object({
  subject: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(2000),
});

exports.broadcast = z.object({
  message: z.string().min(1).max(1000),
  // routeId intentionally omitted: EmergencyAlert has no routeId column.
  tripId: uuid.optional(),
  // Who receives it. Defaults to PARENTS so existing callers are unaffected.
  audience: z.enum(['PARENTS', 'DRIVERS', 'ALL']).optional(),
  // Narrows a DRIVERS/ALL send to specific drivers; ignored for PARENTS.
  driverIds: z.array(uuid).max(200).optional(),
  title: z.string().min(1).max(200).optional(),
  // SOS renders as an emergency in the apps; SYSTEM is the routine channel
  // (app-update notices, schedule changes).
  type: z.enum(['SOS', 'SYSTEM', 'DELAY']).optional(),
});

// One row of a roster import (rosterImport.js). Spreadsheet cells arrive as '' when
// empty; that is "not given", never a value to store, so it becomes null before any
// rule runs. Emails are lowercased: they are the parent's sign-in, and one family typed
// two ways must not become two accounts.
const cell = (schema) => z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), schema);
exports.rosterRow = z.object({
  // The line in the office's file, echoed back so every message points at it.
  line: z.number().int().positive().optional(),
  // Required here, unlike single create: it is what makes a second upload of the same
  // file find the same children instead of adding them again.
  rfidTag: z.string().trim().min(1, 'Student ID is required').max(64),
  name: z.string().trim().min(1, 'Student name is required').max(200),
  grade: cell(z.string().trim().max(50).nullable().optional()),
  guardianPhone: cell(z.string().trim().min(6).max(20).nullable().optional()),
  parentEmail: cell(z.string().trim().toLowerCase().email('Parent email is not a valid email address').nullable().optional()),
  parentName: cell(z.string().trim().max(200).nullable().optional()),
  route: cell(z.string().trim().max(200).nullable().optional()),
  stop: cell(z.string().trim().max(200).nullable().optional()),
  qrToken: cell(importedQrToken.nullable().optional()),
});

// A whole school in one file: 1,200 children is the size this has to handle. The route
// takes a larger body than the global JSON cap for exactly this reason (server.js).
exports.bulkStudents = z.array(exports.rosterRow).min(1).max(2000);

exports.updateMe = z.object({
  name: z.string().min(1).max(200).optional(),
  photoUrl: z.string().url().max(1000).optional().nullable(),
  password: z.string().min(8).max(200).optional(),
  // Required with `password`: see PUT /api/users/me.
  currentPassword: z.string().min(1).max(200).optional(),
  phone: z.string().min(6).max(20).optional().nullable(),
});

// Device push token registration (POST /api/users/me/fcm-token).
exports.fcmToken = z.object({
  fcmToken: z.string().min(10).max(4096).nullable(),
});

// ─── Run scheduler ────────────────────────────────────────
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');
const DATE_ONLY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

exports.createRun = z.object({
  name: z.string().min(1).max(120),
  direction: z.enum(RUN_DIRECTION),
  // Wall clock, not a timestamp. A recurring departure is a time of day.
  departure: HHMM,
  busId: uuid.optional().nullable(),
  driverId: uuid.optional().nullable(),
  mon: z.boolean().optional(), tue: z.boolean().optional(), wed: z.boolean().optional(),
  thu: z.boolean().optional(), fri: z.boolean().optional(), sat: z.boolean().optional(),
  sun: z.boolean().optional(),
  startDate: DATE_ONLY,
  endDate: DATE_ONLY,
});

exports.updateRun = exports.createRun.partial().extend({
  active: z.boolean().optional(),
});

// Dates, plural, applied atomically. Exam periods are weeks, not days: one POST per
// date means a five-day exam week is five calls and twenty runs is a hundred, and a
// partially applied week leaves some days shifted and some not with nothing to show
// which. Same one-at-a-time trap as stop assignment and card rotation.
exports.runException = z.object({
  dates: z.array(DATE_ONLY).min(1).max(90),
  type: z.enum(['ADDED', 'REMOVED']),
  departure: HHMM.optional().nullable(),
  reason: z.string().max(200).optional().nullable(),
});

exports.calendarDay = z.object({
  // Explicit rather than "omit schoolId for platform-wide". Omission meaning maximum
  // blast radius is backwards: a dropped key would silently escalate one school's
  // closure into every school's. This way the accident is a 400.
  scope: z.enum(['PLATFORM', 'SCHOOL']),
  schoolId: uuid.optional().nullable(),
  date: DATE_ONLY,
  reason: z.string().min(1).max(200),
}).refine((v) => v.scope === 'PLATFORM' || Boolean(v.schoolId), {
  message: 'schoolId is required when scope is SCHOOL',
  path: ['schoolId'],
});
