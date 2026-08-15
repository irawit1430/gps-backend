const { z } = require('zod');

const ROLES = ['SUPER_ADMIN', 'SCHOOL_ADMIN', 'DRIVER', 'PARENT'];
const TRIP_STATUS = ['PLANNED', 'ON_SCHEDULE', 'DELAYED', 'COMPLETED', 'CANCELLED'];
const LEAVE_STATUS = ['PENDING', 'APPROVED', 'REJECTED'];
const ATTENDANCE_TYPE = ['BOARDED', 'ALIGHTED'];
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
});

exports.updateSchool = exports.createSchool.partial();

exports.createStudent = z.object({
  schoolId: uuid.optional(),
  rfidTag: z.string().max(64).optional().nullable(),
  name: z.string().min(1).max(200),
  grade: z.string().max(50).optional().nullable(),
  parentEmail: z.string().email().optional().nullable(),
  parentName: z.string().max(200).optional().nullable(),
});

exports.createDevice = z.object({
  deviceId: z.string().min(1).max(64),
  licensePlate: z.string().min(1).max(32),
  capacity: z.number().int().positive().max(200).optional(),
  schoolId: uuid.optional().nullable(),
});

exports.updateDevice = exports.createDevice.partial();

exports.createDriver = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email(),
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
});

exports.tripStatus = z.object({
  status: z.enum(TRIP_STATUS),
});

exports.attendance = z.object({
  studentId: uuid,
  tripId: uuid,
  type: z.enum(ATTENDANCE_TYPE),
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
});

exports.mapping = z.object({
  studentId: uuid,
  routeStopId: uuid,
});

exports.globalSettings = z.object({
  maintenanceMode: z.boolean().optional(),
  mapCenterLat: lat.optional(),
  mapCenterLng: lng.optional(),
});

exports.ROLES = ROLES;
exports.TRIP_STATUS = TRIP_STATUS;
exports.LEAVE_STATUS = LEAVE_STATUS;
exports.ATTENDANCE_TYPE = ATTENDANCE_TYPE;
exports.EMERGENCY_TYPE = EMERGENCY_TYPE;
