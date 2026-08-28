const { z } = require('zod');

const ROLES = ['SUPER_ADMIN', 'SCHOOL_ADMIN', 'DRIVER', 'PARENT'];
const TRIP_STATUS = ['PLANNED', 'ON_SCHEDULE', 'DELAYED', 'COMPLETED', 'CANCELLED'];
const LEAVE_STATUS = ['PENDING', 'APPROVED', 'REJECTED'];
// Must track the AttendanceType enum in schema.prisma. These are two copies of one
// fact in two languages, which is the shape that produced six DELAYED bugs across
// four codebases — a value added to the database and not here is accepted by Postgres
// and rejected by validation, which reads as a client bug.
const ATTENDANCE_TYPE = ['BOARDED', 'ALIGHTED', 'NO_SHOW'];
const EMERGENCY_TYPE = ['DRIVER_SOS', 'HARDWARE_SOS', 'ADMIN_BROADCAST', 'DELAY'];

const uuid = z.string().uuid();
const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);

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

exports.createStudent = z.object({
  schoolId: uuid.optional(),
  rfidTag: z.string().max(64).optional().nullable(),
  name: z.string().min(1).max(200),
  grade: z.string().max(50).optional().nullable(),
  guardianPhone: z.string().min(6).max(20).optional().nullable(),
  parentEmail: z.string().email().optional().nullable(),
  parentName: z.string().max(200).optional().nullable(),
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
});

exports.updateTrip = z.object({
  routeId: uuid.optional(),
  busId: uuid.optional(),
  driverId: uuid.optional(),
  scheduledStart: z.string().datetime().optional().nullable(),
});

exports.tripStatus = z.object({
  status: z.enum(TRIP_STATUS),
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
});

exports.leaveApp = z.object({
  studentId: uuid,
  startDate: z.string().datetime().or(z.string().min(1)),
  endDate: z.string().datetime().or(z.string().min(1)),
  reason: z.string().min(1).max(500),
  notes: z.string().max(2000).optional().nullable(),
});

exports.leaveStatus = z.object({
  status: z.enum(LEAVE_STATUS),
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
  studentIds: z.array(uuid).min(1).max(600),
});

// Resolving a scanned card that is not on the driver's own roster.
exports.qrLookup = z.object({
  qrHash: z.string().regex(/^[0-9a-f]{64}$/, 'expected a sha256 hex digest'),
});

exports.mapping = z.object({
  studentId: uuid,
  routeStopId: uuid,
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

exports.bulkStudents = z.array(exports.createStudent).min(1).max(2000);

exports.updateMe = z.object({
  name: z.string().min(1).max(200).optional(),
  photoUrl: z.string().url().max(1000).optional().nullable(),
  password: z.string().min(8).max(200).optional(),
  phone: z.string().min(6).max(20).optional().nullable(),
});

// Device push token registration (POST /api/users/me/fcm-token).
exports.fcmToken = z.object({
  fcmToken: z.string().min(10).max(4096).nullable(),
});
