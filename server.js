const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const pinoHttp = require('pino-http');
const { Server } = require('socket.io');
const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// The driver roster must match a scanned card offline — signal dies at the end of
// every route — so it needs the codes. Shipping the tokens themselves would put every
// child's credential on every driver's phone, which is the exposure a separate
// qrToken existed to avoid. So the roster carries a hash: a phone can verify a card
// without ever holding the thing that makes one, and a leaked payload is useless for
// forging a card.
function qrHash(token) {
  return token ? crypto.createHash('sha256').update(token).digest('hex') : null;
}

// Migration 5 backfilled a token for every student that existed then, and nothing
// generated one for anybody created afterwards — so every new admission was invisible
// to the entire QR system: no card could be printed for them, and the driver roster
// carried qrHash: null so a scan could never match. Worse, one such child in a print
// selection fails the whole batch, because the card screen generates QR images from
// the token client-side.
//
// Random rather than derived: an imported code may be a guessable roll number, but one
// we generate should never be.
function newQrToken() {
  return crypto.randomBytes(16).toString('hex');
}

// The QR columns for a student, given whatever the school supplied.
//
// A school that already prints cards has to be able to say what is on them, otherwise
// onboarding means reprinting 600 cards to replace 600 that work. When they do, the
// card physically exists in a child's hand — so it is printed, by definition, and
// qrCardPrintedAt is stamped. That field is what the driver app reads as `hasCard`;
// leaving it null would tell a driver to expect no card from a child holding one.
function qrFieldsFor(suppliedToken) {
  if (!suppliedToken) {
    return { qrToken: newQrToken(), qrCodeImported: false, qrCardPrintedAt: null };
  }
  return { qrToken: suppliedToken, qrCodeImported: true, qrCardPrintedAt: new Date() };
}

// Knowing a token is enough to print a working card, so it leaves the server through
// exactly one response: POST /api/schools/:schoolId/qr-cards. Create and update both
// returned the whole row, which quietly made that claim false — and put the token in
// browser history and every proxy log along the way.
function withoutQrToken(student) {
  if (!student) return student;
  const { qrToken, ...rest } = student;
  return rest;
}

// P2002 on Student can now come from two different unique constraints, and telling an
// admin "RFID tag already assigned" when they pasted a duplicate QR code sends them
// looking at the wrong column.
function duplicateStudentFieldError(err) {
  const target = String(err?.meta?.target || '');
  if (target.includes('qrToken')) {
    return 'That QR code is already assigned to another student in this school.';
  }
  return 'RFID Tag is already assigned to another student.';
}

function distanceMeters(aLat, aLng, bLat, bLng) {
  const rad = n => n * Math.PI / 180;
  const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
}

const config = require('./config');
const logger = require('./logger');
const S = require('./schemas');
const { selectJourney, selectNextJourney, stopEta, journeyState } = require('./journey');
const { calendarDate, dayBounds, DEFAULT_ZONE } = require('./schoolTime');
const { validate } = require('./middleware/validate');
const { authenticate, authorizeRoles, requireTenant, requireSelfOrRoles, logoutToken, invalidateUser, requireCurrentPassword } = require('./middleware/auth');
const { telemetryHmac } = require('./middleware/telemetryHmac');
const { attachSocketAuth, emitToSchool, emitToUser, emitToUsers } = require('./middleware/socketAuth');
const { persistRevocations } = require('./sessionRevocations');
const { tripTelemetryKey } = require('./telemetryKeys');
const positionAudience = require('./positionAudience');
// Who may see a bus's live position is cached per trip for 5 minutes. Anything that
// changes a trip's riders or crew drops that cache, so a parent taken off a route stops
// receiving the bus on the next fix rather than for another five minutes.
const rosterChanged = () => positionAudience.clear();
const { getSimulatedAlerts, getMockNotifications } = require('./mock-data');
const {
  syncGpsLogToFirebase,
  syncEmergencyAlertToFirebase,
  syncStudentToFirebase,
  sendPush,
  isPushConfigured,
} = require('./firebase');

// ─── Boot ───────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: config.CORS_ORIGINS, credentials: true },
});
const prisma = new PrismaClient({ log: ['error', 'warn'] });

attachSocketAuth(io);
// Save every sign-out-everywhere so a restart does not revive the tokens it ended.
persistRevocations(prisma, logger);

// ─── Global middleware ─────────────────────────────────────
app.set('trust proxy', 1); // behind nginx
app.use(helmet());
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // allow curl / server-to-server
      if (config.CORS_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS origin not allowed: ${origin}`));
    },
    credentials: true,
  })
);
app.use(express.json({ limit: '256kb' }));
app.use(
  pinoHttp({
    logger,
    genReqId: (req) => req.headers['x-request-id'] || crypto.randomUUID(),
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
  })
);

// Rate limits
const loginLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.RATE_LIMIT_LOGIN_PER_MIN,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts; try again shortly.' },
});
const globalLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.RATE_LIMIT_GLOBAL_PER_MIN,
  standardHeaders: true,
  legacyHeaders: false,
});
const bulkImportLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many bulk imports; try again shortly.' },
});
app.use(globalLimiter);

// ─── Public routes (health, login, telemetry) ──────────────
app.get('/', (_req, res) => res.send('Fleet API is running perfectly!'));

// Reports the running process's clock. School-calendar operations use each school's
// configured IANA timezone, while this remains useful for diagnosing host clock drift.
app.get('/healthz', (_req, res) =>
  res.status(200).json({
    status: 'ok',
    serverTime: new Date().toString(),
    utcOffsetMinutes: -new Date().getTimezoneOffset(),
  })
);

app.get('/readyz', async (_req, res) => {
  const checks = { db: false, firestore: null };
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, rej) => setTimeout(() => rej(new Error('db timeout')), 2000)),
    ]);
    checks.db = true;
  } catch (err) {
    return res.status(503).json({ status: 'degraded', checks, error: err.message });
  }
  res.status(200).json({ status: 'ok', checks });
});

// Parents need a working contact before sign-in and before a child is linked. Keep
// this deliberately narrow: operational contact details only, no account roster.
app.get('/api/public/schools/:schoolId/support', async (req, res) => {
  try {
    const school = await prisma.school.findFirst({
      where: { id: req.params.schoolId, status: 'ACTIVE' },
      select: { id: true, name: true, contactPerson: true, contactPhone: true, phone: true, contactEmail: true, email: true, supportHours: true, timezone: true, leaveCutoffMinutes: true, leaveResponseHours: true },
    });
    if (!school) return res.status(404).json({ error: 'School support details not found' });
    res.json({ ...school, phone: school.contactPhone || school.phone || null, email: school.contactEmail || school.email || null });
  } catch (err) {
    req.log.error({ err }, 'public support lookup failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Login (rate-limited, unauthenticated)
const DUMMY_HASH = '$2a$10$e8wWwFkWyVb0f4pL7pTDe.a9B6gZ7rV5rY6f8rG8g8g8g8g8g8g8g';
app.post('/api/auth/login', loginLimiter, validate({ body: S.login }), async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      await bcrypt.compare(password, DUMMY_HASH);
      req.log.warn('login rejected');
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      req.log.warn({ userId: user.id }, 'login rejected');
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    const token = jwt.sign(
      {
        id: user.id, role: user.role, schoolId: user.schoolId,
        // Enforced by requireCurrentPassword. change-password's replacement token omits it.
        ...(user.role === 'PARENT' && user.mustResetPassword ? { mustResetPassword: true } : {}),
      },
      config.JWT_SECRET,
      { expiresIn: config.JWT_EXPIRES_IN || '24h' }
    );
    req.log.info({ userId: user.id, role: user.role, schoolId: user.schoolId }, 'login succeeded');

    let preferences = {};
    if (user.notificationSettings) {
      preferences =
        typeof user.notificationSettings === 'string'
          ? JSON.parse(user.notificationSettings)
          : user.notificationSettings;
    }

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        schoolId: user.schoolId,
        mustResetPassword: user.mustResetPassword || false,
        preferences,
      },
    });
  } catch (err) {
    req.log.error({ err }, 'login failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Change Password (authenticated)
app.post('/api/auth/change-password', authenticate, validate({ body: S.changePassword }), async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const ok = await bcrypt.compare(oldPassword, user.password);
    if (!ok) return res.status(401).json({ error: 'Incorrect current password' });

    const hashed = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: user.id },
      data: { password: hashed, mustResetPassword: false },
    });
    // A password change ends every existing session for this user, including this one...
    invalidateUser(user.id);
    logoutToken(req.token);

    // ...and hands back a replacement, so the client is not pushed into an immediate
    // re-login it cannot win. invalidateUser stamps a cutoff in whole seconds and
    // authenticate rejects `iat <= cutoff`, but JWT iat is second-resolution — a token
    // minted in this same second is indistinguishable from the ones just revoked, so a
    // prompt re-login gets 401d. Dating this one a second past the cutoff keeps every
    // prior token dead while this one lives. Nothing is given away: the caller proved
    // knowledge of oldPassword in this very request.
    // ponytail: dodges the second-resolution cutoff rather than fixing it. A
    // `tokenVersion` claim (REVIEW_LOG open item 3) makes the iat shift unnecessary.
    const token = jwt.sign(
      { id: user.id, role: user.role, schoolId: user.schoolId, iat: Math.floor(Date.now() / 1000) + 1 },
      config.JWT_SECRET,
      { expiresIn: config.JWT_EXPIRES_IN || '24h' }
    );
    res.json({ message: 'Password updated successfully', token });
  } catch (err) {
    req.log.error({ err }, 'change password failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Logout — revoke the presented token so it can no longer be used.
app.post('/api/auth/logout', authenticate, async (req, res) => {
  logoutToken(req.token);
  // Drop the device token too, so a signed-out phone stops receiving pushes.
  try {
    await prisma.user.updateMany({ where: { id: req.user.id }, data: { fcmToken: null } });
  } catch (err) {
    req.log.warn({ err: err.message }, 'clearing fcmToken on logout failed');
  }
  res.json({ message: 'Logged out' });
});

// Which accounts a school admin may reset. Anyone can file a forgot-password request
// for any email, and approving one hands the approver a working password. A school
// admin approving a request for another admin, or for a super admin who carries their
// school's id, would sign in as that account: so administrators' requests are for
// super admins only.
const SCHOOL_RESETTABLE_ROLES = ['PARENT', 'DRIVER'];
const schoolCanReset = (role) => SCHOOL_RESETTABLE_ROLES.includes(role);

// Forgot password. There is no mail sender in this stack, so instead of emailing a
// code this queues a request for the user's school admin, who resets the password and
// hands it over directly. Always answers 200 with the same body: a different response
// for an unknown address would confirm which emails have accounts.
app.post('/api/auth/forgot-password', loginLimiter, validate({ body: S.forgotPassword }), async (req, res) => {
  const sameAnswer = {
    success: true,
    message: 'If that account exists, your school admin has been notified and will share a new password.',
  };
  try {
    const user = await prisma.user.findUnique({ where: { email: req.body.email } });
    if (!user) return res.json(sameAnswer);

    // Re-tapping the button must not pile up requests for the same person.
    const pending = await prisma.passwordResetRequest.findFirst({
      where: { userId: user.id, status: 'PENDING' },
    });
    if (pending) return res.json(sameAnswer);

    const request = await prisma.passwordResetRequest.create({
      data: { userId: user.id, schoolId: user.schoolId || null, status: 'PENDING' },
    });

    // Tell the people who can act on it: that school's admins, or the super admins
    // when the account belongs to no school or is an administrator's own.
    const admins = await prisma.user.findMany({
      where: user.schoolId && schoolCanReset(user.role)
        ? { schoolId: user.schoolId, role: { in: ['SCHOOL_ADMIN', 'SUPER_ADMIN'] } }
        : { role: 'SUPER_ADMIN' },
      select: { id: true },
    });
    const adminIds = admins.map((a) => a.id);
    if (adminIds.length > 0) {
      const title = 'Password reset requested';
      const message = `${user.name} (${user.email}) cannot sign in and asked for a password reset.`;
      await prisma.notification.createMany({
        data: adminIds.map((id) => ({ userId: id, title, message, type: 'SYSTEM' })),
      });
      if (io) {
        adminIds.forEach((id) =>
          emitToUser(io, id, 'notification', { title, message, type: 'SYSTEM', requestId: request.id })
        );
      }
      pushToUsers(adminIds, { title, body: message, data: { type: 'PASSWORD_RESET', requestId: request.id } });
    }

    req.log.info({ userId: user.id, requestId: request.id }, 'password reset requested');
    res.json(sameAnswer);
  } catch (err) {
    req.log.error({ err }, 'forgot password failed');
    // Still the same answer: an error here must not become an account oracle either.
    res.json(sameAnswer);
  }
});

// Telemetry (HMAC-authenticated, not JWT). Bus is looked up by the HMAC middleware
// and attached as req.bus.
const telemetryCache = require('./telemetryCache');
const liveFixGuard = require('./liveFixGuard');
const busPresence = require('./busPresence');
const mailer = require('./mailer');
const gpsWriteGate = require('./gpsWriteGate');
const { resolveRunOnDate, departureAt, ymd } = require('./runSchedule');
app.post('/api/telemetry', validate({ body: S.telemetry }), (req, res, next) => next(), // placeholder to satisfy ordering
  // deferred HMAC attach after prisma exists:
  async (req, res, next) => (await telemetryHmac(prisma))(req, res, next),
  async (req, res) => {
    try {
      const { deviceId, lat, lng, speed, timestamp } = req.body;
      let bus = req.bus;
      if (!bus) {
        // HMAC disabled path — fall back to cached lookup
        const cached = telemetryCache.get(deviceId);
        bus = cached || (await prisma.bus.findUnique({
          where: { deviceId },
          include: {
            trips: {
              // DELAYED is running too. Matching only ON_SCHEDULE filed every fix
              // from a late bus under tripId null — exactly when the track matters.
              where: { status: { in: ['ON_SCHEDULE', 'DELAYED'] } },
              // Only the id is needed: the trip tags the GpsLog row. Identity used to
              // ride the location_update broadcast and no longer does — see below.
              select: { id: true },
            },
          },
        }));
        if (bus) telemetryCache.set(deviceId, bus);
      }
      if (!bus) return res.status(404).json({ error: 'Bus not found' });

      const activeTrip = bus.trips?.[0];
      const fixAt = timestamp ? new Date(timestamp) : new Date();
      const fixSpeed = speed || 0;

      // Not every packet earns a row — see gpsWriteGate. The broadcast below is
      // unaffected and still runs on every packet.
      if (gpsWriteGate.shouldPersist(bus.id, activeTrip?.id, fixSpeed)) {
        await prisma.gpsLog.create({
          data: { busId: bus.id, tripId: activeTrip?.id || null, lat, lng, speed: fixSpeed, timestamp: fixAt },
        });
      }

      // Throttle state lives in busPresence, not on `bus`: with HMAC enforced the row
      // is re-read per request, so a marker stored on the object was always missing
      // and every single packet wrote to the DB.
      busPresence.noteFix(bus.id, { speed: fixSpeed, source: 'phone' });
      const presence = busPresence.evaluate(bus.id, bus.status);
      if (presence.write) {
        await prisma.bus.update({
          where: { id: bus.id },
          data: { status: 'ONLINE' },
        });
        bus.status = 'ONLINE';
        telemetryCache.set(deviceId, bus);
      }
      if (presence.cameOnline) {
        emitToSchool(io, bus.schoolId, 'device_status_change', {
          deviceId: bus.id,
          status: 'ONLINE',
          message: `${bus.licensePlate} is reporting`,
        });
      }

      // An offline queue flush from the driver app (or a retried post) can deliver a
      // fix older than one already broadcast. It belongs in the trail above, but
      // broadcasting it would drag the live marker backwards.
      if (liveFixGuard.shouldBroadcast(bus.id, fixAt)) {
        syncGpsLogToFirebase({
          busId: bus.id,
          licensePlate: bus.licensePlate,
          lat,
          lng,
          speed: speed || 0,
          timestamp: fixAt,
        });

        // location_update is POSITION ONLY, and both ingest paths must agree on that.
        //
        // driverName and routeName used to ride along, which meant every parent held
        // every driver name on their device — and only for phone-GPS buses, because
        // the TM-100 path never sent them. So the fields were present in testing,
        // absent in production, and a privacy leak in between. Identity now comes
        // from GET /api/devices/locations.
        const positionPayload = {
          busId: bus.id,
          licensePlate: bus.licensePlate,
          capacity: bus.capacity,
          lat,
          lng,
          speed,
          timestamp: fixAt,
        };
        emitToSchool(io, bus.schoolId, 'location_update', positionPayload);
        // Admins get every bus in their school; a parent or driver gets only the bus
        // their own trip is on. Both halves are required — the school room no longer
        // contains parents, so without this the tracking screen never updates.
        await positionAudience.emitToRiders(
          io, prisma, activeTrip?.id, 'location_update', positionPayload, req.log
        );
      } else {
        req.log.debug({ busId: bus.id, timestamp: fixAt }, 'telemetry: skipping live broadcast for stale fix');
      }

      res.status(200).json({ success: true });
    } catch (err) {
      req.log.error({ err }, 'telemetry failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── Authenticated routes below ────────────────────────────
app.use(authenticate);
// A parent on their provisioning password can only change it (see middleware/auth.js).
// Before the audit routes so leave requests are covered too.
app.use(requireCurrentPassword);
require('./auditRoutes').registerAuditRoutes(app, { prisma, io, emitToUser, emitToSchool, isPushConfigured, pushToUsers, parentIdsOnTrip, mailer });

// Broad RBAC prefixes
app.use('/api/admin', authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'));
app.use('/api/admins', authorizeRoles('SUPER_ADMIN'));
app.use('/api/settings', authorizeRoles('SUPER_ADMIN'));
const schoolAdminsOnly = authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN');

// ─── Tenant-scoped: /api/schools/:schoolId/* ──────────────
app.get('/api/schools/:schoolId/buses', requireTenant('schoolId'), schoolAdminsOnly, async (req, res) => {
  try {
    const buses = await prisma.bus.findMany({
      where: { schoolId: req.params.schoolId },
      include: {
        gpsLogs: { orderBy: { timestamp: 'desc' }, take: 1 },
        trips: {
          where: { status: { in: ['PLANNED', 'ON_SCHEDULE', 'DELAYED'] } },
          include: { driver: { select: { name: true } }, route: { select: { name: true } } },
        },
      },
    });
    res.json(
      buses.map((b) => {
        const t = b.trips.find(x => x.status === 'ON_SCHEDULE' || x.status === 'DELAYED');
        const isAvailable = b.trips.length === 0;
        // Spreading the row shipped Bus.deviceSecret — /api/devices already scrubs it.
        const { deviceSecret, ...bus } = b;
        return { ...bus, driverName: t?.driver?.name || 'Unassigned', routeName: t?.route?.name || 'Off-Route', isAvailable };
      })
    );
  } catch (err) {
    req.log.error({ err }, 'list buses failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/schools/:schoolId/leaves', requireTenant('schoolId'), schoolAdminsOnly, async (req, res) => {
  try {
    const { status } = req.query;
    const where = { student: { schoolId: req.params.schoolId } };
    if (status && status !== 'all') where.status = String(status).toUpperCase();
    const leaves = await prisma.leaveApplication.findMany({
      where,
      include: { student: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json(leaves);
  } catch (err) {
    req.log.error({ err }, 'list leaves failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Doc-parity alias: /api/schools/:schoolId/leaves/pending
app.get('/api/schools/:schoolId/leaves/pending', requireTenant('schoolId'), schoolAdminsOnly, async (req, res) => {
  try {
    const leaves = await prisma.leaveApplication.findMany({
      where: { student: { schoolId: req.params.schoolId }, status: 'PENDING' },
      include: { student: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json(leaves);
  } catch (err) {
    req.log.error({ err }, 'list pending leaves failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Creating, changing, approving, rejecting, cancelling and deleting a leave all live in
// auditRoutes.js (the leave workflow). It is mounted before this file's routes and
// answers every request itself, so a handler for those paths here would never run.
async function ownsLeave(req, res, next) {
  if (req.user.role === 'SUPER_ADMIN') return next();
  const leave = await prisma.leaveApplication.findUnique({
    where: { id: req.params.id },
    include: { student: true },
  });
  if (!leave) return res.status(404).json({ error: 'Leave not found' });
  if (req.user.role === 'SCHOOL_ADMIN' && leave.student.schoolId === req.user.schoolId) return next();
  return res.status(403).json({ error: 'Forbidden' });
}

// Doc-parity: PUT /api/parent/leaves/:id { status: APPROVED|REJECTED }
app.put('/api/parent/leaves/:id',
  authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'),
  ownsLeave,
  validate({ body: S.leaveStatus }),
  async (req, res) => {
    try {
      const leave = await prisma.leaveApplication.update({
        where: { id: req.params.id },
        data: { status: req.body.status },
      });
      res.json(leave);
    } catch (err) {
      req.log.error({ err }, 'update leave failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// Routes
app.get('/api/schools/:schoolId/routes', requireTenant('schoolId'), schoolAdminsOnly, async (req, res) => {
  try {
    // ?summary=1 for the screens that only need names.
    //
    // The full shape ships every route's OSRM polyline and every one of its stops. A
    // 12-route school with 40 stops each is a dozen encoded polylines and ~480 stop
    // rows — sent to populate a dropdown. The map editor genuinely needs all of it;
    // Overview and the students page do not, and they call this on every load.
    //
    // Opt-in rather than a new default so the editor keeps working unchanged.
    // Most-recently-started first, so a running leg always beats a finished one and a
    // trip that has not started sorts last. `createdAt: 'desc'` was correct while a
    // route had one trip a day; the scheduler is about to make two the norm, at which
    // point it hands back an arbitrary leg. This is the sweep item that has to ship
    // with the change that makes it live, rather than after it.
    const currentTrip = {
      take: 1,
      orderBy: [{ startTime: { sort: 'desc', nulls: 'last' } }, { createdAt: 'asc' }],
    };

    if (req.query.summary) {
      const routes = await prisma.route.findMany({
        where: { schoolId: req.params.schoolId },
        select: {
          id: true,
          name: true,
          distanceKm: true,
          estimatedDuration: true,
          _count: { select: { stops: true } },
          // The Active Routes widget reads this and nothing else, so without it the
          // panel renders perfectly and shows nothing — a silently empty screen rather
          // than an error. Stops are still excluded; screens that need a routeStopId
          // must fetch the full shape.
          trips: { ...currentTrip, select: { id: true, status: true, startTime: true, scheduledStart: true, direction: true } },
        },
        orderBy: { name: 'asc' },
      });
      return res.json(
        routes.map(({ _count, ...r }) => ({ ...r, stopCount: _count.stops }))
      );
    }

    const routes = await prisma.route.findMany({
      where: { schoolId: req.params.schoolId },
      include: { stops: { orderBy: { orderIdx: 'asc' } }, trips: currentTrip },
    });
    res.json(routes);
  } catch (err) {
    req.log.error({ err }, 'list routes failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/schools/:schoolId/routes',
  requireTenant('schoolId'),
  authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'),
  validate({ body: S.createRoute }),
  async (req, res) => {
    try {
      const { name, estimatedDuration, distanceKm, geometry, stops } = req.body;
      const route = await prisma.$transaction(async (tx) => {
        const r = await tx.route.create({
          data: {
            schoolId: req.params.schoolId,
            name,
            estimatedDuration: estimatedDuration ?? null,
            distanceKm: distanceKm ?? null,
            geometry: geometry ?? null,
          },
        });
        await tx.routeStop.createMany({
          data: stops.map((s) => ({
            routeId: r.id,
            name: s.name,
            address: s.address ?? null,
            lat: s.lat,
            lng: s.lng,
            orderIdx: s.orderIdx,
            expectedArrivalMinutes: s.expectedArrivalMinutes ?? null,
          })),
        });
        return tx.route.findUnique({
          where: { id: r.id },
          include: { stops: { orderBy: { orderIdx: 'asc' } } },
        });
      });
      res.json(route);
    } catch (err) {
      req.log.error({ err }, 'create route failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

async function ownsRoute(req, res, next) {
  if (req.user.role === 'SUPER_ADMIN') return next();
  const route = await prisma.route.findUnique({ where: { id: req.params.id } });
  if (!route) return res.status(404).json({ error: 'Route not found' });
  if (req.user.role === 'SCHOOL_ADMIN' && route.schoolId === req.user.schoolId) return next();
  return res.status(403).json({ error: 'Forbidden' });
}

app.put('/api/routes/:id',
  authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'),
  ownsRoute,
  validate({ body: S.updateRoute }),
  async (req, res) => {
    try {
      const route = await prisma.route.update({ where: { id: req.params.id }, data: req.body });
      res.json(route);
    } catch (err) {
      req.log.error({ err }, 'update route failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

app.delete('/api/routes/:id', authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'), ownsRoute, async (req, res) => {
  try {
    const [activeTrips, tripCount] = await Promise.all([
      prisma.trip.count({
        where: { routeId: req.params.id, status: { in: ['PLANNED', 'ON_SCHEDULE', 'DELAYED'] } },
      }),
      // Completed and cancelled trips still reference Route through a restrictive
      // foreign key. Deleting them would also erase the context for attendance and
      // GPS history, so route deletion is intentionally blocked for any trip state.
      prisma.trip.count({ where: { routeId: req.params.id } }),
    ]);
    if (tripCount > 0) {
      return res.status(409).json({
        error: `Cannot delete route: ${tripCount} trip(s) reference it. Route deletion is blocked to preserve trip history.`,
        code: 'ROUTE_HAS_TRIPS',
        tripCount,
        activeTripCount: activeTrips,
      });
    }
    await prisma.route.delete({ where: { id: req.params.id } });
    rosterChanged();
    res.json({ success: true });
  } catch (err) {
    // A trip can be created after the counts above. Preserve the database constraint
    // as the final authority and translate that race (or another dependent record)
    // into the same intentional conflict class instead of leaking a generic 500.
    if (err.code === 'P2003') {
      req.log.warn({ routeId: req.params.id, err }, 'route deletion blocked by dependent records');
      return res.status(409).json({
        error: 'Cannot delete route because dependent records still reference it.',
        code: 'ROUTE_IN_USE',
      });
    }
    req.log.error({ err }, 'delete route failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── RouteStop CRUD ─────────────────────────────────────
// Tenant guard: route must belong to caller's school (SUPER_ADMIN bypasses).
async function ownsRouteByParam(req, res, next) {
  if (req.user.role === 'SUPER_ADMIN') return next();
  const route = await prisma.route.findUnique({ where: { id: req.params.routeId }, select: { schoolId: true } });
  if (!route) return res.status(404).json({ error: 'Route not found' });
  if (req.user.role === 'SCHOOL_ADMIN' && route.schoolId === req.user.schoolId) return next();
  return res.status(403).json({ error: 'Forbidden' });
}

app.post('/api/routes/:routeId/stops',
  authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'),
  ownsRouteByParam,
  validate({ body: S.createStop }),
  async (req, res) => {
    try {
      const stop = await prisma.routeStop.create({
        data: {
          routeId: req.params.routeId,
          name: req.body.name,
          address: req.body.address ?? null,
          lat: req.body.lat,
          lng: req.body.lng,
          orderIdx: req.body.orderIdx,
          expectedArrivalMinutes: req.body.expectedArrivalMinutes ?? null,
        },
      });
      res.json(stop);
    } catch (err) {
      req.log.error({ err }, 'create stop failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

app.put('/api/routes/:routeId/stops/reorder',
  authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'),
  ownsRouteByParam,
  validate({ body: S.reorderStops }),
  async (req, res) => {
    try {
      const ids = req.body.map((r) => r.id);
      const stops = await prisma.routeStop.findMany({ where: { id: { in: ids } } });
      if (stops.length !== ids.length || stops.some((s) => s.routeId !== req.params.routeId)) {
        return res.status(400).json({ error: 'Some stops do not belong to this route' });
      }
      // Two-phase update to avoid transient unique-collisions on (routeId, orderIdx)
      // if you ever add such a constraint later. For now the index is non-unique so a
      // single pass would work, but two-phase is safer.
      await prisma.$transaction([
        ...req.body.map((r, i) =>
          prisma.routeStop.update({ where: { id: r.id }, data: { orderIdx: 1000000 + i } })
        ),
        ...req.body.map((r) =>
          prisma.routeStop.update({ where: { id: r.id }, data: { orderIdx: r.orderIdx } })
        ),
      ]);
      const updated = await prisma.routeStop.findMany({
        where: { routeId: req.params.routeId },
        orderBy: { orderIdx: 'asc' },
      });
      res.json(updated);
    } catch (err) {
      req.log.error({ err }, 'reorder stops failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

app.put('/api/routes/:routeId/stops/:id',
  authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'),
  ownsRouteByParam,
  validate({ body: S.updateStop }),
  async (req, res) => {
    try {
      const existing = await prisma.routeStop.findUnique({ where: { id: req.params.id } });
      if (!existing || existing.routeId !== req.params.routeId) {
        return res.status(404).json({ error: 'Stop not found on this route' });
      }
      const stop = await prisma.routeStop.update({ where: { id: req.params.id }, data: req.body });
      res.json(stop);
    } catch (err) {
      req.log.error({ err }, 'update stop failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

app.delete('/api/routes/:routeId/stops/:id',
  authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'),
  ownsRouteByParam,
  async (req, res) => {
    try {
      const existing = await prisma.routeStop.findUnique({ where: { id: req.params.id } });
      if (!existing || existing.routeId !== req.params.routeId) {
        return res.status(404).json({ error: 'Stop not found on this route' });
      }
      await prisma.routeStop.delete({ where: { id: req.params.id } });
      rosterChanged();
      res.json({ success: true });
    } catch (err) {
      req.log.error({ err }, 'delete stop failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// Drivers
app.get('/api/schools/:schoolId/parents', requireTenant('schoolId'), schoolAdminsOnly, async (req, res) => {
  try {
    const parents = await prisma.user.findMany({
      where: { schoolId: req.params.schoolId, role: 'PARENT' },
      select: {
        id: true, name: true, email: true, phone: true, role: true, photoUrl: true,
        createdAt: true, updatedAt: true,
        parentStudents: {
          include: {
            routeMappings: {
              // Oldest first: a child can hold a pickup and a drop-off mapping now, and
              // the screens below read [0]. Unordered, that label changes per refresh.
              orderBy: { createdAt: 'asc' },
              include: { routeStop: { include: { route: true } } },
            },
          }
        }
      },
    });
    res.json(parents);
  } catch (err) {
    req.log.error({ err }, 'list parents failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/parents/:id', authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'), validate({ body: S.updateDriver }), async (req, res) => {
  try {
    const parent = await prisma.user.findUnique({ where: { id: req.params.id, role: 'PARENT' } });
    if (!parent) return res.status(404).json({ error: 'Parent not found' });
    if (req.user.role === 'SCHOOL_ADMIN' && parent.schoolId !== req.user.schoolId) return res.status(403).json({ error: 'Forbidden' });
    
    const data = { ...req.body };
    if (data.password) {
      data.password = await bcrypt.hash(data.password, 10);
      data.mustResetPassword = true;
    }
    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data
    });
    // A password reset must revoke the parent's existing tokens.
    if (req.body.password) invalidateUser(req.params.id);
    delete updated.password;
    delete updated.fcmToken;
    res.json(updated);
  } catch (err) {
    if (err.code === 'P2002' && err.meta?.target?.includes('email')) {
      return res.status(400).json({ error: 'Email already in use' });
    }
    req.log.error({ err }, 'update parent failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// A message from the school office to one family: the school dashboard's "Message
// parent" on the students page. The dashboard has always called this, and the route
// did not exist, so every message failed. It reaches the parent the way a broadcast
// does: in their notifications, live on the socket, and as a push.
app.post('/api/parents/:parentId/messages',
  authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'),
  validate({ body: S.parentMessage }),
  async (req, res) => {
    try {
      const parent = await prisma.user.findUnique({
        where: { id: req.params.parentId },
        select: { id: true, role: true, schoolId: true },
      });
      if (!parent || parent.role !== 'PARENT') return res.status(404).json({ error: 'Parent not found' });
      if (req.user.role === 'SCHOOL_ADMIN' && parent.schoolId !== req.user.schoolId) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const notification = await prisma.notification.create({
        data: {
          userId: parent.id,
          title: req.body.subject,
          message: req.body.message,
          type: 'SYSTEM',
          context: { type: 'SCHOOL_MESSAGE', sentBy: req.user.id },
        },
      });
      if (io) emitToUser(io, parent.id, 'notification', notification);
      pushToUsers([parent.id], {
        title: req.body.subject,
        body: req.body.message,
        data: { type: 'SCHOOL_MESSAGE', notificationId: notification.id },
      });
      res.status(201).json({ id: notification.id, sentAt: notification.createdAt });
    } catch (err) {
      req.log.error({ err }, 'message parent failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

app.get('/api/schools/:schoolId/drivers', requireTenant('schoolId'), schoolAdminsOnly, async (req, res) => {
  try {
    const drivers = await prisma.user.findMany({
      where: { schoolId: req.params.schoolId, role: 'DRIVER' },
      select: {
        id: true, name: true, email: true, phone: true, role: true, photoUrl: true,
        notificationSettings: true, schoolId: true, createdAt: true, updatedAt: true,
        driverTrips: {
          where: { status: { in: ['PLANNED', 'ON_SCHEDULE', 'DELAYED'] } },
          // `bus: true` here also carried the HMAC deviceSecret out to any admin.
          include: {
            bus: { select: { id: true, licensePlate: true, capacity: true, deviceId: true, status: true } },
            route: true,
          },
        },
      },
    });
    res.json(drivers.map(d => ({ ...d, isAvailable: d.driverTrips.length === 0 })));
  } catch (err) {
    req.log.error({ err }, 'list drivers failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/schools/:schoolId/drivers',
  requireTenant('schoolId'),
  authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'),
  validate({ body: S.createDriver }),
  async (req, res) => {
    try {
      const { name, email, phone } = req.body;
      const tempPassword = generateTempPassword();
      const hashed = await bcrypt.hash(tempPassword, 10);
      const driver = await prisma.user.create({
        data: { schoolId: req.params.schoolId, name, email, phone: phone || null, password: hashed, role: 'DRIVER', mustResetPassword: true },
      });
      res.json({ driver: { id: driver.id, name: driver.name, email: driver.email, phone: driver.phone }, tempPassword });
    } catch (err) {
      if (err.code === 'P2002' && err.meta?.target?.includes('email')) {
        return res.status(400).json({ error: 'Email already in use' });
      }
      req.log.error({ err }, 'create driver failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// Trips
// A conflicting trip only genuinely blocks if it could still be running. Nothing in
// this system ever sets COMPLETED except a driver tapping it, so an abandoned run
// otherwise locks its bus AND driver out of every future trip, permanently. Past the
// window it is over whatever the row says: close it and let the caller through.
// Both the create and the start path route through here — fixing only one leaves the
// other door locked.
async function stillBlocking(conflict, log) {
  if (!conflict) return null;
  const startedAt = conflict.startTime || conflict.createdAt;
  if (Date.now() - new Date(startedAt).getTime() <= config.TRIP_STALE_HOURS * 3_600_000) {
    return conflict;
  }
  await prisma.trip.update({
    where: { id: conflict.id },
    // endTime is when we closed it, not when it really ended. The oversized duration
    // that produces is the point — it makes the abandonment visible.
    data: { status: 'COMPLETED', endTime: new Date() },
  });
  log?.warn({ tripId: conflict.id, startedAt }, 'auto-completed stale trip blocking a new one');
  return null;
}

app.post('/api/schools/:schoolId/trips',
  requireTenant('schoolId'),
  authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'),
  validate({ body: S.createTrip }),
  async (req, res) => {
    try {
      // Verify all referenced entities belong to this school
      const [route, bus, driver] = await Promise.all([
        prisma.route.findUnique({ where: { id: req.body.routeId } }),
        prisma.bus.findUnique({ where: { id: req.body.busId } }),
        prisma.user.findUnique({ where: { id: req.body.driverId } }),
      ]);
      if (!route || route.schoolId !== req.params.schoolId) return res.status(400).json({ error: 'Route not in this school' });
      if (!bus || (bus.schoolId && bus.schoolId !== req.params.schoolId)) return res.status(400).json({ error: 'Bus not in this school' });
      if (!driver || driver.role !== 'DRIVER' || driver.schoolId !== req.params.schoolId) return res.status(400).json({ error: 'Driver not in this school' });
      
      const conflict = await prisma.trip.findFirst({
        where: {
          OR: [{ busId: req.body.busId }, { driverId: req.body.driverId }],
          status: { in: ['ON_SCHEDULE', 'DELAYED'] },
        },
      });
      if (await stillBlocking(conflict, req.log)) {
        return res.status(400).json({ error: 'Bus or Driver is already assigned to an active trip' });
      }
      const trip = await prisma.trip.create({
        data: {
          routeId: req.body.routeId,
          busId: req.body.busId,
          driverId: req.body.driverId,
          status: 'PLANNED',
          scheduledStart: req.body.scheduledStart ? new Date(req.body.scheduledStart) : null,
          // Null stays legal for a trip whose direction genuinely is not known, but
          // three consumers read it — driver stop order, parent wording, attendance
          // labelling — so a null here degrades all three silently.
          direction: req.body.direction ?? null,
        },
        include: { route: { select: { schoolId: true, name: true } } },
      });
      emitTripChange(trip, 'created');
      res.json(trip);
    } catch (err) {
      req.log.error({ err }, 'create trip failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// Students & attendance

app.put('/api/trips/:tripId',
  authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'),
  ownsTrip,
  validate({ body: S.updateTrip }),
  async (req, res) => {
    try {
      const tripId = req.params.tripId;
      const { busId, driverId, routeId } = req.body;
      
      const existingTrip = await prisma.trip.findUnique({ where: { id: tripId }, include: { route: true } });
      if (!existingTrip) return res.status(404).json({ error: 'Trip not found' });
      
      // If bus or driver is changing, ensure they aren't on another active trip
      if (busId || driverId) {
        const checkBus = busId || existingTrip.busId;
        const checkDriver = driverId || existingTrip.driverId;
        
        const activeTrips = await prisma.trip.findMany({
          where: {
            id: { not: tripId },
            OR: [{ busId: checkBus }, { driverId: checkDriver }],
            status: { in: ['ON_SCHEDULE', 'DELAYED'] },
          }
        });
        if (activeTrips.length > 0) return res.status(400).json({ error: 'New Bus or Driver is already assigned to an active trip' });
      }

      // If updating route, bus, or driver, ensure they belong to the same school
      const schoolId = existingTrip.route.schoolId;
      if (routeId && routeId !== existingTrip.routeId) {
        const route = await prisma.route.findUnique({ where: { id: routeId } });
        if (!route || route.schoolId !== schoolId) return res.status(400).json({ error: 'Route not in this school' });
      }
      if (busId && busId !== existingTrip.busId) {
        const bus = await prisma.bus.findUnique({ where: { id: busId } });
        if (!bus || (bus.schoolId && bus.schoolId !== schoolId)) return res.status(400).json({ error: 'Bus not in this school' });
      }
      if (driverId && driverId !== existingTrip.driverId) {
        const driver = await prisma.user.findUnique({ where: { id: driverId } });
        if (!driver || driver.role !== 'DRIVER' || driver.schoolId !== schoolId) return res.status(400).json({ error: 'Driver not in this school' });
      }

      const updated = await prisma.trip.update({
        where: { id: tripId },
        data: {
          ...(busId && { busId }),
          ...(driverId && { driverId }),
          ...(routeId && { routeId }),
          ...(req.body.scheduledStart !== undefined && {
            scheduledStart: req.body.scheduledStart ? new Date(req.body.scheduledStart) : null,
          }),
          ...(req.body.direction !== undefined && { direction: req.body.direction }),
          // A human has now hand-edited this trip. Nothing wrote this flag, so the
          // guard in applyExceptionToExistingTrip could never fire and a run-level
          // exception would quietly overwrite an edit somebody made at 07:00 — the
          // exact failure the column was added to prevent.
          isOverridden: true,
        },
        include: { route: { select: { schoolId: true, name: true } } },
      });
      // A new driver or route means a different audience for this trip's position.
      if (driverId || routeId) positionAudience.invalidate(tripId);
      emitTripChange(updated, 'assignment');
      // The outgoing driver loses this trip, so tell them too.
      if (driverId && driverId !== existingTrip.driverId) {
        emitToUser(io, existingTrip.driverId, 'trip_status_change', { tripId, status: updated.status, reason: 'unassigned' });
      }
      res.json(updated);
    } catch (err) {
      req.log.error({ err }, 'update trip failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

app.get('/api/schools/:schoolId/students', requireTenant('schoolId'), schoolAdminsOnly, async (req, res) => {
  try {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const students = await prisma.student.findMany({
      where: { schoolId: req.params.schoolId },
      include: {
        // The primary contact is the parent account; guardianPhone is the fallback
        // for families without one. Only shipping the fallback meant the office saw
        // an empty field and concluded there was no number on file.
        parent: { select: { name: true, phone: true } },
        // `route: true` dragged the whole row, including the OSRM polyline, for every
        // student — to read two names.
        routeMappings: {
          // Oldest first: a child can hold a pickup and a drop-off mapping now, and the
          // office list renders one stop. Unordered, that label changes per refresh.
          orderBy: { createdAt: 'asc' },
          // Ids and coordinates, not just names. Without the mapping id the dashboard
          // cannot move or remove an assignment at all — it had to go to the parents
          // endpoint for it, which is the wrong screen's payload. Still a narrow select:
          // `route: true` would drag the OSRM polyline in for every student.
          include: {
            routeStop: {
              select: {
                id: true, name: true, lat: true, lng: true, routeId: true,
                route: { select: { name: true } },
              },
            },
          },
        },
      },
    });

    // Today's scans in one bounded query, latest per student. These two fields used
    // to be the literals 'Absent' and '--:--', so every child read as absent forever.
    const logs = await prisma.attendanceLog.findMany({
      where: { student: { schoolId: req.params.schoolId }, timestamp: { gte: startOfToday } },
      orderBy: { timestamp: 'desc' },
      select: { studentId: true, type: true, timestamp: true },
    });
    const latest = new Map();
    for (const l of logs) if (!latest.has(l.studentId)) latest.set(l.studentId, l);

    res.json(
      students.map((s) => {
        const m = s.routeMappings[0];
        const a = latest.get(s.id);
        return {
          id: s.id,
          rfidTag: s.rfidTag,
          name: s.name,
          grade: s.grade,
          photoUrl: s.photoUrl,
          guardianPhone: s.guardianPhone || null,
          parentName: s.parent?.name || null,
          parentPhone: s.parent?.phone || null,
          assignedRoute: m?.routeStop?.route?.name || 'Unassigned',
          routeStopName: m?.routeStop?.name || 'Unassigned',
          // Every assignment this child holds — a pickup and a drop-off stop are two.
          // The two fields above stay as they are, showing the first, so nothing reading
          // them breaks; anything that needs to ACT on an assignment reads this instead.
          mappings: (s.routeMappings || []).map((rm) => ({
            id: rm.id,
            routeStopId: rm.routeStopId,
            direction: rm.direction, // null = serves both legs
            stopName: rm.routeStop?.name ?? null,
            lat: rm.routeStop?.lat ?? null,
            lng: rm.routeStop?.lng ?? null,
            routeId: rm.routeStop?.routeId ?? null,
            routeName: rm.routeStop?.route?.name ?? null,
          })),
          // BOARDED | ALIGHTED | null. null means no scan today — genuinely unknown,
          // which is not the same as absent and must not render as it.
          boardingStatus: a?.type || null,
          lastCheckIn: a?.timestamp?.toISOString() || null,
          // Whether this child already holds a card the school issued itself. The
          // print screen filters on this BEFORE calling /qr-cards, so it has to be
          // here and not only on that response — otherwise the exclusion reads
          // undefined for everyone, silently selects the whole school, and a school
          // with 40 imported codes prints 40 unnecessary cards. Harmless while the
          // flag is false for everyone; wrong the day imports land, and quiet either
          // way. The token itself is never on this payload.
          qrCodeImported: s.qrCodeImported,
        };
      })
    );
  } catch (err) {
    req.log.error({ err }, 'list students failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function studentCreateHandler(req, res) {
  try {
    const schoolId = req.params.schoolId || req.body.schoolId || req.user?.schoolId;
    if (!schoolId) return res.status(400).json({ error: 'schoolId is required' });

    // Tenant check: SCHOOL_ADMIN can only create in own school
    if (req.user.role === 'SCHOOL_ADMIN' && req.user.schoolId !== schoolId) {
      return res.status(403).json({ error: 'Forbidden: cross-tenant' });
    }
    if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'SCHOOL_ADMIN') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    let { rfidTag, name, grade, guardianPhone, parentEmail, parentName } = req.body;
    if (!rfidTag || typeof rfidTag !== 'string' || rfidTag.trim() === '') {
      rfidTag = `RFID-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;
    } else {
      rfidTag = rfidTag.trim();
    }

    // Wrap parent-provisioning + student-create in a transaction
    const result = await prisma.$transaction(async (tx) => {
      let parentId = null;
      let generatedPassword = null;
      if (parentEmail) {
        let parent = await tx.user.findUnique({ where: { email: parentEmail } });
        if (parent && (parent.role !== 'PARENT' || parent.schoolId !== schoolId)) {
          const err = new Error('Parent account belongs to another tenant or role');
          err.code = 'PARENT_TENANT_CONFLICT';
          throw err;
        }
        if (!parent) {
          generatedPassword = parentOpeningPassword();
          const hashed = await bcrypt.hash(generatedPassword, 10);
          parent = await tx.user.create({
            data: {
              email: parentEmail,
              password: hashed,
              role: 'PARENT',
              name: parentName || `Parent of ${name}`,
              schoolId,
              mustResetPassword: true,
            },
          });
        }
        parentId = parent.id;
      }
      const student = await tx.student.create({
        data: {
          schoolId, rfidTag, name, grade: grade || 'General',
          guardianPhone: guardianPhone || null, parentId,
          ...qrFieldsFor(req.body.qrToken),
        },
      });
      return { student, generatedPassword };
    });

    res.json({
      student: withoutQrToken(result.student),
      parentCredentials: result.generatedPassword
        ? { email: parentEmail, temporaryPassword: result.generatedPassword }
        : null,
    });
  } catch (err) {
    if (err.code === 'PARENT_TENANT_CONFLICT') {
      return res.status(409).json({ error: 'Parent email is already associated with another account' });
    }
    if (err.code === 'P2002') {
      return res.status(400).json({ error: duplicateStudentFieldError(err) });
    }
    req.log.error({ err }, 'create student failed');
    res.status(500).json({ error: 'Internal server error' });
  }
}

app.post('/api/schools/:schoolId/students', requireTenant('schoolId'), schoolAdminsOnly, validate({ body: S.createStudent }), studentCreateHandler);
app.post('/api/schools/:schoolId/broadcast', requireTenant('schoolId'), authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'), validate({ body: S.broadcast }), async (req, res) => {
  try {
    const audience = req.body.audience || 'PARENTS';
    const wantsParents = audience === 'PARENTS' || audience === 'ALL';
    const wantsDrivers = audience === 'DRIVERS' || audience === 'ALL';
    const notifType = req.body.type || (audience === 'DRIVERS' ? 'SYSTEM' : 'SOS');
    const notifTitle = req.body.title || (notifType === 'SOS' ? 'Emergency Broadcast' : 'Message from school');

    // One trip lookup serves both audiences when the broadcast is trip-scoped.
    let trip = null;
    if (req.body.tripId) {
      trip = await prisma.trip.findUnique({
        where: { id: req.body.tripId },
        include: { route: { include: { stops: { include: { studentMappings: { select: { student: { select: { parentId: true } } } } } } } } }
      });
      if (!trip) return res.status(404).json({ error: 'Trip not found' });
      if (trip.route.schoolId !== req.params.schoolId) {
        return res.status(403).json({ error: 'Forbidden: trip belongs to another school' });
      }
    }

    // NOTE: EmergencyAlert has no routeId column — only tripId. Passing routeId
    // would throw. senderId records who broadcast it. Create only after every
    // referenced resource has passed tenant authorization.
    const alert = await prisma.emergencyAlert.create({
      data: {
        schoolId: req.params.schoolId,
        senderId: req.user.id,
        type: 'ADMIN_BROADCAST',
        message: req.body.message,
        tripId: req.body.tripId || null,
        audience,
      }
    });

    const recipientIds = new Set();

    if (wantsParents) {
      if (trip?.route) {
        trip.route.stops.forEach(stop => {
          stop.studentMappings.forEach(mapping => {
            if (mapping.student.parentId) recipientIds.add(mapping.student.parentId);
          });
        });
      } else if (!req.body.tripId) {
        // School-wide broadcast: every parent in the school
        const students = await prisma.student.findMany({
          where: { schoolId: req.params.schoolId },
          select: { parentId: true }
        });
        students.forEach(s => {
          if (s.parentId) recipientIds.add(s.parentId);
        });
      }
    }

    if (wantsDrivers) {
      // driverIds narrows the send; otherwise it is the trip's driver, or every
      // driver in the school. The schoolId filter keeps a SUPER_ADMIN from
      // messaging another school's drivers through this route.
      if (req.body.driverIds?.length) {
        const drivers = await prisma.user.findMany({
          where: { id: { in: req.body.driverIds }, role: 'DRIVER', schoolId: req.params.schoolId },
          select: { id: true }
        });
        drivers.forEach(d => recipientIds.add(d.id));
      } else if (trip?.driverId) {
        recipientIds.add(trip.driverId);
      } else if (!req.body.tripId) {
        const drivers = await prisma.user.findMany({
          where: { schoolId: req.params.schoolId, role: 'DRIVER' },
          select: { id: true }
        });
        drivers.forEach(d => recipientIds.add(d.id));
      }
    }

    const recipients = Array.from(recipientIds);
    if (recipients.length > 0) {
      const sentAt = new Date();
      await prisma.notification.createMany({
        data: recipients.map(userId => ({
          userId,
          title: notifTitle,
          message: req.body.message,
          type: notifType,
          context: { type: notifType, incidentId: alert.id, tripId: alert.tripId }
        }))
      });

      // Read the rows back so each client receives a real Notification (with an id
      // it can mark read) rather than a shape that only looks like one.
      const created = await prisma.notification.findMany({
        where: { userId: { in: recipients }, createdAt: { gte: sentAt } },
      });
      if (io) created.forEach(n => emitToUser(io, n.userId, 'notification', n));
      pushToUsers(recipients, {
        title: notifTitle,
        body: req.body.message,
        data: { type: notifType, schoolId: req.params.schoolId, tripId: req.body.tripId || '' },
      });
    }

    // Also notify the tenant's admin-only realtime room. Parents and drivers receive
    // only the per-user notifications selected above.
    if (io) emitToSchool(io, req.params.schoolId, 'emergency_alert', alert);

    // recipientCount lets the sending dashboard show "sent to N people" instead of
    // guessing whether anyone was actually targeted.
    res.json({ ...alert, audience, recipientCount: recipients.length });
  } catch (err) {
    req.log.error({ err }, 'broadcast failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/schools/:schoolId/students/bulk', bulkImportLimiter, requireTenant('schoolId'), authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'), validate({ body: S.bulkStudents }), async (req, res) => {
  try {
    const students = req.body;
    let createdCount = 0;
    // Temp passwords for parents provisioned by this import, returned once so the
    // admin can hand them out. Shape depends on PARENT_DEFAULT_PASSWORD: one shared
    // string for the whole school when set — the owner's call, so an import of 300
    // families is one notice rather than 300 slips — or a unique readable password per
    // parent when it is not.
    //
    // Shared means exactly what it says: the string opens every parent account created
    // since it last changed, and each of those shows a child's live location. See the
    // note on PARENT_DEFAULT_PASSWORD in config.js before changing how this is handled.
    const parentCredentials = [];

    // Process in transaction
    await prisma.$transaction(async (tx) => {
      for (const [i, st] of students.entries()) {
        let parent = null;
        if (st.parentEmail) {
          const existing = await tx.user.findUnique({ where: { email: st.parentEmail } });
          if (existing) {
            if (existing.role !== 'PARENT' || existing.schoolId !== req.params.schoolId) {
              const err = new Error('Parent account belongs to another tenant or role');
              err.code = 'PARENT_TENANT_CONFLICT';
              throw err;
            }
            parent = existing;
          } else {
            const tempPassword = parentOpeningPassword();
            parent = await tx.user.create({
              data: {
                email: st.parentEmail,
                name: st.parentName || 'Parent',
                password: await bcrypt.hash(tempPassword, 10),
                role: 'PARENT',
                schoolId: req.params.schoolId,
                mustResetPassword: true,
              }
            });
            parentCredentials.push({ email: st.parentEmail, temporaryPassword: tempPassword });
          }
        }
        try {
          await tx.student.create({
            data: {
              schoolId: req.params.schoolId,
              rfidTag: st.rfidTag,
              name: st.name,
              grade: st.grade,
              guardianPhone: st.guardianPhone || null,
              parentId: parent ? parent.id : null,
              ...qrFieldsFor(st.qrToken),
            }
          });
        } catch (rowErr) {
          // A 600-row import that fails with "a code is already in use" and no row
          // number is a spreadsheet someone has to bisect by hand. Name the row and
          // the student; the transaction still aborts, so nothing is half-applied.
          if (rowErr.code === 'P2002') {
            const err = new Error('duplicate in import');
            err.code = 'IMPORT_ROW_CONFLICT';
            err.row = i + 1;
            err.studentName = st.name;
            err.detail = duplicateStudentFieldError(rowErr);
            throw err;
          }
          throw rowErr;
        }
        createdCount++;
      }
    });
    // parentCredentials still lists every provisioned parent, because the office needs
    // to know WHICH families now have an account. With a shared password every row
    // carries the same string; `sharedPassword` says so, so the UI can print one notice
    // instead of repeating it 300 times.
    res.json({
      success: true,
      message: `Created ${createdCount} students successfully.`,
      parentCredentials,
      sharedPassword: Boolean(config.PARENT_DEFAULT_PASSWORD),
    });
  } catch (err) {
    if (err.code === 'PARENT_TENANT_CONFLICT') {
      return res.status(409).json({ error: 'Import aborted: a parent email belongs to another account' });
    }
    if (err.code === 'IMPORT_ROW_CONFLICT') {
      return res.status(409).json({
        error: `Import aborted at row ${err.row} (${err.studentName}): ${err.detail}`,
        row: err.row,
        studentName: err.studentName,
      });
    }
    if (err.code === 'P2002') {
      return res.status(400).json({ error: 'Import aborted: an RFID tag or parent email in this batch is already in use.' });
    }
    req.log.error({ err }, 'bulk student import failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/students', schoolAdminsOnly, validate({ body: S.createStudent }), studentCreateHandler);

app.put('/api/students/:id', authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'), validate({ body: S.updateStudent }), async (req, res) => {
  try {
    const student = await prisma.student.findUnique({ where: { id: req.params.id } });
    if (!student) return res.status(404).json({ error: 'Student not found' });
    if (req.user.role === 'SCHOOL_ADMIN' && student.schoolId !== req.user.schoolId) return res.status(403).json({ error: 'Forbidden' });
    
    // A supplied qrToken is an imported card, so it carries the same two companion
    // facts as it does on create. Spreading req.body alone would set the token and
    // leave qrCodeImported false and qrCardPrintedAt null — the driver app would then
    // read hasCard: false for a child holding a card we just recorded.
    const { qrToken, ...rest } = req.body;
    const updated = await prisma.student.update({
      where: { id: req.params.id },
      data: qrToken ? { ...rest, ...qrFieldsFor(qrToken) } : rest,
    });
    res.json(withoutQrToken(updated));
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(400).json({ error: duplicateStudentFieldError(err) });
    }
    req.log.error({ err }, 'update student failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/students/:id', authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'), async (req, res) => {
  try {
    const student = await prisma.student.findUnique({ where: { id: req.params.id } });
    if (!student) return res.status(404).json({ error: 'Student not found' });
    if (req.user.role === 'SCHOOL_ADMIN' && student.schoolId !== req.user.schoolId) return res.status(403).json({ error: 'Forbidden' });
    
    await prisma.student.delete({ where: { id: req.params.id } });
    rosterChanged();
    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, 'delete student failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Student → route stop
app.delete('/api/student-route-mappings/:id', authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'), async (req, res) => {
  try {
    const mapping = await prisma.studentRouteMapping.findUnique({
      where: { id: req.params.id },
      include: { student: true }
    });
    if (!mapping) return res.status(404).json({ error: 'Mapping not found' });
    if (req.user.role === 'SCHOOL_ADMIN' && mapping.student.schoolId !== req.user.schoolId) return res.status(403).json({ error: 'Forbidden' });
    
    await prisma.studentRouteMapping.delete({ where: { id: req.params.id } });
    rosterChanged();
    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, 'delete mapping failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Student and stop must both belong to the caller's school. Returns the loaded stop, or
// null once it has already answered the request itself.
//
// 403 and not 404 on a missing stop: a school admin must not be able to probe which stop
// ids exist outside their own school.
async function loadMappingTargets(req, res, studentId, routeStopId) {
  const [student, stop] = await Promise.all([
    prisma.student.findUnique({ where: { id: studentId }, select: { schoolId: true } }),
    prisma.routeStop.findUnique({
      where: { id: routeStopId },
      select: { routeId: true, route: { select: { schoolId: true } } },
    }),
  ]);
  if (req.user.role === 'SCHOOL_ADMIN') {
    if (!student || student.schoolId !== req.user.schoolId) { res.status(403).json({ error: 'Forbidden' }); return null; }
    if (!stop || stop.route.schoolId !== req.user.schoolId) { res.status(403).json({ error: 'Forbidden' }); return null; }
  } else {
    if (!student) { res.status(404).json({ error: 'Student not found' }); return null; }
    if (!stop) { res.status(404).json({ error: 'Route stop not found' }); return null; }
    if (student.schoolId !== stop.route.schoolId) {
      res.status(400).json({ error: 'Student and route stop must belong to the same school' });
      return null;
    }
  }
  return stop;
}

// One stop per student per route PER LEG. The @@unique is (studentId, routeStopId),
// which only makes re-assigning the SAME stop idempotent — a second stop on the same
// route slips past it and the student then appears twice on the driver roster.
//
// A null direction means "both legs", so it collides with everything on the route and
// everything collides with it: that is the old one-stop-per-route rule, kept exactly as
// it was for anyone not using directions. Two stops are allowed only when both name a
// leg and the legs differ — morning outside the house, afternoon at a grandparent's. No
// unique index can express this, because it needs NULL to conflict rather than be
// distinct.
//
// Shared by create and move. Two copies of this rule drifting apart is precisely how a
// child ends up on two rosters.
function conflictingMapping({ studentId, routeId, direction, exceptStopId, exceptId }) {
  return prisma.studentRouteMapping.findFirst({
    where: {
      studentId,
      routeStop: { routeId },
      ...(exceptStopId ? { routeStopId: { not: exceptStopId } } : {}),
      ...(exceptId ? { id: { not: exceptId } } : {}),
      // A both-legs mapping narrows nothing: anything already on the route conflicts.
      ...(direction ? { OR: [{ direction: null }, { direction }] } : {}),
    },
    select: { direction: true, routeStop: { select: { id: true, name: true } } },
  });
}

// Both endpoints must answer a conflict identically, or the dialog has to handle two
// shapes for one situation.
function mappingConflict(res, existing) {
  return res.status(409).json({
    error: existing.direction
      ? `Student already has a ${existing.direction === 'TO_SCHOOL' ? 'pickup' : 'drop-off'} stop on this route`
      : 'Student is already assigned to another stop on this route',
    stopId: existing.routeStop.id,
    stopName: existing.routeStop.name,
    // So the UI can offer "make that one morning-only" instead of a dead end.
    conflictingDirection: existing.direction,
  });
}

// Move an existing assignment to another stop, on this route or a different one.
//
// Delete-then-create was the only way to do this, which is two requests with a window
// between them: if the create fails, the child is left assigned to nothing and the
// office sees "Unassigned" with no idea a move was attempted. One UPDATE keeps the
// mapping row and its id, so there is no such window and nothing to reconcile.
app.put('/api/student-route-mappings/:id',
  authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'),
  validate({ body: S.moveMapping }),
  async (req, res) => {
    try {
      const existing = await prisma.studentRouteMapping.findUnique({
        where: { id: req.params.id },
        select: { id: true, studentId: true, direction: true },
      });
      if (!existing) return res.status(404).json({ error: 'Mapping not found' });

      // Tenancy is checked against the mapping's OWN student, never a body field.
      const stop = await loadMappingTargets(req, res, existing.studentId, req.body.routeStopId);
      if (!stop) return;

      // Absent means keep the leg this mapping already serves; explicit null widens it
      // back to both.
      const direction = req.body.direction !== undefined ? req.body.direction : existing.direction;

      const elsewhere = await conflictingMapping({
        studentId: existing.studentId,
        routeId: stop.routeId,
        direction,
        exceptId: existing.id,
      });
      if (elsewhere) return mappingConflict(res, elsewhere);

      const mapping = await prisma.studentRouteMapping.update({
        where: { id: existing.id },
        data: { routeStopId: req.body.routeStopId, direction },
        include: { student: true, routeStop: { include: { route: true } } },
      });
      rosterChanged();
      res.json(mapping);
    } catch (err) {
      // The child already holds a DIFFERENT mapping row for the target stop, and
      // (studentId, routeStopId) is unique. Same situation as a conflict, so it must not
      // surface as a 500 — but the conflict search above cannot see it, because the two
      // rows name different legs and so do not collide on the rule.
      if (err.code === 'P2002') {
        return res.status(409).json({
          error: 'Student already has a mapping for that stop',
          code: 'MAPPING_EXISTS',
        });
      }
      req.log.error({ err }, 'move mapping failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

app.post('/api/student-route-mappings',
  authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'),
  validate({ body: S.mapping }),
  async (req, res) => {
    try {
      const { studentId, routeStopId } = req.body;
      const stop = await loadMappingTargets(req, res, studentId, routeStopId);
      if (!stop) return;

      const direction = req.body.direction ?? null;
      const elsewhere = await conflictingMapping({
        studentId, routeId: stop.routeId, direction, exceptStopId: routeStopId,
      });
      if (elsewhere) return mappingConflict(res, elsewhere);

      const mapping = await prisma.studentRouteMapping.upsert({
        where: { studentId_routeStopId: { studentId, routeStopId } },
        // Re-posting the same stop with a direction is how an existing both-legs
        // mapping is narrowed to one leg, so this can no longer be a no-op.
        update: { direction },
        create: { studentId, routeStopId, direction },
        include: { student: true, routeStop: { include: { route: true } } },
      });
      rosterChanged();
      res.json(mapping);
    } catch (err) {
      req.log.error({ err }, 'create mapping failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── Runs (the recurring schedule) ─────────────────────────

// Active runs still pointing at a bus or driver. Named in the 409 so an admin can act
// on it rather than being told no: "this bus is in use" without saying where is the
// same dead end as "please try again" on a conflict.
async function runsDependingOn(where) {
  const runs = await prisma.run.findMany({
    where: { ...where, active: true },
    select: { id: true, name: true, direction: true, route: { select: { id: true, name: true } } },
  });
  return runs.map((r) => ({
    id: r.id, name: r.name, direction: r.direction, routeName: r.route?.name || null,
  }));
}

// A run belongs to a route and the route carries the school, so tenancy is checked by
// walking to the route rather than trusting anything in the request.
async function loadRunForCaller(req, res) {
  const run = await prisma.run.findUnique({
    where: { id: req.params.runId },
    include: { route: { select: { schoolId: true, school: { select: { timezone: true } } } } },
  });
  if (!run) { res.status(404).json({ error: 'Run not found' }); return null; }
  if (req.user.role !== 'SUPER_ADMIN' && run.route.schoolId !== req.user.schoolId) {
    res.status(403).json({ error: 'Forbidden' }); return null;
  }
  return run;
}

// Trip creation has always verified that a bus and driver belong to the school it is
// dispatching for. Run creation spread the request body straight into the row and
// verified neither, so a school admin could attach another school's bus or any
// non-driver user to a run — and the materialiser would then turn that into a real
// trip every morning, unattended. Same check, same wording, one place both run
// endpoints call. Null is allowed: a run may legitimately be saved before its crew is
// known, and the materialiser already warns about those.
async function crewProblem(schoolId, { busId, driverId }) {
  const [bus, driver] = await Promise.all([
    busId ? prisma.bus.findUnique({ where: { id: busId }, select: { schoolId: true } }) : null,
    driverId ? prisma.user.findUnique({ where: { id: driverId }, select: { role: true, schoolId: true } }) : null,
  ]);
  // An unassigned bus (schoolId null) is shared fleet and stays usable, matching
  // POST /api/schools/:schoolId/trips.
  if (busId && (!bus || (bus.schoolId && bus.schoolId !== schoolId))) return 'Bus not in this school';
  if (driverId && (!driver || driver.role !== 'DRIVER' || driver.schoolId !== schoolId)) {
    return 'Driver not in this school';
  }
  return null;
}

// Dates arrive as YYYY-MM-DD and are calendar days in the school's timezone, which is
// the server's — TZ is pinned in ecosystem.config.js precisely so this is a local day
// and not a UTC one beginning at 05:30 IST.
function dateOnly(str) {
  const d = new Date(`${str}T00:00:00`);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Applies an exception to a trip that already exists for that date, and reports
// whether it changed anything so the client can say so rather than assume.
//
// Exceptions and closures reach FORWARD into trips that already exist; the
// materialiser never reaches backward. Without this an override saved for a date
// inside the materialisation window does nothing at all — the trip departs at the old
// time and the preview confidently shows the new one.
async function applyExceptionToExistingTrip(run, date, exception, log) {
  const trip = await prisma.trip.findUnique({
    where: { runId_serviceDate: { runId: run.id, serviceDate: date } },
  });
  if (!trip) return false;
  // A trip a human has already adjusted outranks a pattern-level exception. Most
  // specific intent wins, same precedence the three calendar layers follow.
  if (trip.isOverridden) return false;
  if (['COMPLETED', 'CANCELLED'].includes(trip.status)) return false;

  if (exception.type === 'REMOVED') {
    await prisma.trip.update({ where: { id: trip.id }, data: { status: 'CANCELLED' } });
    log?.info({ tripId: trip.id, runId: run.id }, 'Exception cancelled an existing trip');
    return true;
  }
  if (exception.departure) {
    await prisma.trip.update({
      where: { id: trip.id },
      data: { scheduledStart: departureAt(date, exception.departure, run.route?.school?.timezone || DEFAULT_ZONE) },
    });
    log?.info({ tripId: trip.id, runId: run.id }, 'Exception shifted an existing trip');
    return true;
  }
  return false;
}

app.get('/api/routes/:routeId/runs', schoolAdminsOnly, async (req, res) => {
  try {
    const route = await prisma.route.findUnique({
      where: { id: req.params.routeId }, select: { schoolId: true },
    });
    if (!route) return res.status(404).json({ error: 'Route not found' });
    if (req.user.role !== 'SUPER_ADMIN' && route.schoolId !== req.user.schoolId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const runs = await prisma.run.findMany({
      where: { routeId: req.params.routeId },
      orderBy: [{ direction: 'asc' }, { departure: 'asc' }],
    });
    // Inactive runs are returned deliberately, not filtered: a soft-deleted run is
    // invisible but still occupies its slot, and an admin recreating it would collide
    // with something they cannot see. The client hides them.
    res.json(
      runs.map((r) => ({
        ...r,
        startDate: ymd(r.startDate),
        endDate: ymd(r.endDate),
        // A run without both cannot become a trip. Derived here so a run list can show
        // what will not run tomorrow, without fetching every bus and driver to work it
        // out.
        hasCrew: Boolean(r.busId && r.driverId),
      }))
    );
  } catch (err) {
    req.log.error({ err }, 'list runs failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/routes/:routeId/runs',
  authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'),
  validate({ body: S.createRun }),
  async (req, res) => {
    try {
      const route = await prisma.route.findUnique({
        where: { id: req.params.routeId }, select: { schoolId: true },
      });
      if (!route) return res.status(404).json({ error: 'Route not found' });
      if (req.user.role !== 'SUPER_ADMIN' && route.schoolId !== req.user.schoolId) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      const { startDate, endDate, ...rest } = req.body;
      if (dateOnly(endDate) < dateOnly(startDate)) {
        return res.status(400).json({ error: 'endDate is before startDate' });
      }
      const badCrew = await crewProblem(route.schoolId, rest);
      if (badCrew) return res.status(400).json({ error: badCrew });
      const run = await prisma.run.create({
        data: { ...rest, routeId: req.params.routeId, startDate: dateOnly(startDate), endDate: dateOnly(endDate) },
      });
      res.json({ ...run, startDate: ymd(run.startDate), endDate: ymd(run.endDate) });
    } catch (err) {
      req.log.error({ err }, 'create run failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

app.put('/api/runs/:runId',
  authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'),
  validate({ body: S.updateRun }),
  async (req, res) => {
    try {
      const existing = await loadRunForCaller(req, res);
      if (!existing) return;
      const { startDate, endDate, ...rest } = req.body;
      const badCrew = await crewProblem(existing.route.schoolId, rest);
      if (badCrew) return res.status(400).json({ error: badCrew });
      const data = { ...rest };
      if (startDate) data.startDate = dateOnly(startDate);
      if (endDate) data.endDate = dateOnly(endDate);
      // Edits apply from the next materialisation. Trips already generated are
      // snapshots: the per-trip edit screen owns today, and a run edit silently
      // rewriting a trip somebody adjusted at 07:00 would fight that control with no
      // indication why it snapped back.
      const run = await prisma.run.update({ where: { id: req.params.runId }, data });
      res.json({ ...run, startDate: ymd(run.startDate), endDate: ymd(run.endDate) });
    } catch (err) {
      req.log.error({ err }, 'update run failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// Soft delete. Hard-deleting a run with materialised trips behind it either orphans
// their history or cascades it away, and both are worse than a flag.
app.delete('/api/runs/:runId', authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'), async (req, res) => {
  try {
    if (!(await loadRunForCaller(req, res))) return;
    await prisma.run.update({ where: { id: req.params.runId }, data: { active: false } });
    res.json({ success: true, active: false });
  } catch (err) {
    req.log.error({ err }, 'deactivate run failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/runs/:runId/exceptions', schoolAdminsOnly, async (req, res) => {
  try {
    if (!(await loadRunForCaller(req, res))) return;
    const rows = await prisma.runException.findMany({
      where: { runId: req.params.runId }, orderBy: { date: 'asc' },
    });
    res.json(rows.map((r) => ({ ...r, date: ymd(r.date) })));
  } catch (err) {
    req.log.error({ err }, 'list run exceptions failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/runs/:runId/exceptions',
  authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'),
  validate({ body: S.runException }),
  async (req, res) => {
    try {
      const run = await loadRunForCaller(req, res);
      if (!run) return;
      const payload = {
        type: req.body.type,
        departure: req.body.departure ?? null,
        reason: req.body.reason ?? null,
      };
      const dates = [...new Set(req.body.dates)].map(dateOnly);

      // All of them or none. A half-applied exam week — some days shifted, some not,
      // and nothing on screen saying which — is worse than a clean failure the admin
      // can retry.
      const rows = await prisma.$transaction(
        dates.map((date) =>
          prisma.runException.upsert({
            where: { runId_date: { runId: run.id, date } },
            update: payload,
            create: { runId: run.id, date, ...payload },
          })
        )
      );

      // Reaching forward is per-date and outside the transaction on purpose: an
      // exception that saved correctly must not be rolled back because one already
      // materialised trip could not be updated. The exception is the durable fact;
      // touching today's trip is a courtesy on top of it.
      const appliedTo = [];
      for (const date of dates) {
        if (await applyExceptionToExistingTrip(run, date, req.body, req.log)) {
          appliedTo.push(ymd(date));
        }
      }

      res.json({
        saved: rows.length,
        exceptions: rows.map((r) => ({ ...r, date: ymd(r.date) })),
        // Which dates were close enough to have already materialised, so the client
        // can say "these take effect now, the rest at the next pass" rather than
        // guessing which side of the horizon a date fell on.
        appliedToExistingTrips: appliedTo,
      });
    } catch (err) {
      req.log.error({ err }, 'save run exception failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

app.delete('/api/exceptions/:id', authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'), async (req, res) => {
  try {
    const ex = await prisma.runException.findUnique({
      where: { id: req.params.id },
      include: { run: { include: { route: { select: { schoolId: true } } } } },
    });
    if (!ex) return res.status(404).json({ error: 'Exception not found' });
    if (req.user.role !== 'SUPER_ADMIN' && ex.run.route.schoolId !== req.user.schoolId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    await prisma.runException.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, 'delete exception failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Shared calendar ──────────────────────────────────────

// What closing this date would actually do. The SAME function serves the dry run and
// the write, so a preview cannot disagree with the outcome — a preview that hands an
// operator a comforting wrong number is worse than no preview.
async function closureImpact(schoolId, date) {
  const routeScope = schoolId ? { schoolId } : {};
  const [schools, tripCount, runCount] = await Promise.all([
    prisma.school.findMany({ where: schoolId ? { id: schoolId } : {}, select: { id: true, name: true } }),
    prisma.trip.count({
      where: {
        serviceDate: date,
        status: { in: ['PLANNED', 'ON_SCHEDULE', 'DELAYED'] },
        ...(schoolId ? { route: { schoolId } } : {}),
      },
    }),
    prisma.run.count({
      where: { active: true, startDate: { lte: date }, endDate: { gte: date }, route: routeScope },
    }),
  ]);
  const d = new Date(date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return {
    date: ymd(date),
    // A mistyped year lands on a different weekday. An operator who meant a Saturday
    // and reads 'Friday' stops — cheaper and more reliable than any warning copy.
    weekday: d.toLocaleDateString('en-GB', { weekday: 'long' }),
    isPast: d < today,
    schools,
    schoolCount: schools.length,
    // Runs that WOULD have operated, regardless of the materialisation horizon.
    // tripCount is rows that exist right now and will be cancelled — for a holiday
    // marked weeks out that is legitimately zero, which must not read as no impact.
    runCount,
    tripCount,
  };
}

app.get('/api/calendar', schoolAdminsOnly, async (req, res) => {
  try {
    const from = req.query.from ? dateOnly(req.query.from) : (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();
    const to = req.query.to ? dateOnly(req.query.to) : new Date(from.getTime() + 90 * 86400000);
    // Not merged: a super admin has to tell their own platform rows from a school's,
    // and merged they are indistinguishable.
    const where = { date: { gte: from, lte: to } };
    if (req.user.role !== 'SUPER_ADMIN') {
      where.OR = [{ schoolId: req.user.schoolId }, { schoolId: null }];
    }
    const rows = await prisma.calendarDay.findMany({
      where, orderBy: { date: 'asc' },
      include: { school: { select: { id: true, name: true } } },
    });
    res.json(rows.map((r) => ({ ...r, date: ymd(r.date) })));
  } catch (err) {
    req.log.error({ err }, 'list calendar failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/calendar', schoolAdminsOnly, validate({ body: S.calendarDay }), async (req, res) => {
  try {
    const platform = req.body.scope === 'PLATFORM';
    // A platform closure shuts every school. That is the only new privilege this
    // feature introduces, and it is enforced here rather than in a console — a school
    // admin's token can reach this endpoint directly whatever any UI renders.
    if (platform && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Only a super admin can close a date for every school' });
    }
    const schoolId = platform ? null : req.body.schoolId;
    if (!platform && req.user.role !== 'SUPER_ADMIN' && schoolId !== req.user.schoolId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const date = dateOnly(req.body.date);
    const impact = await closureImpact(schoolId, date);

    if (req.query.dryRun) return res.json({ ...impact, applied: false });

    const existing = await prisma.calendarDay.findFirst({ where: { schoolId, date } });
    if (existing) return res.status(409).json({ error: 'That date is already closed', id: existing.id });

    const row = await prisma.calendarDay.create({
      data: { schoolId, date, closed: true, reason: req.body.reason },
    });

    // Cancel rather than delete, so reopening can restore — and record WHICH closure
    // did it. Restoring everything CANCELLED for a date would resurrect trips a
    // driver or a school had deliberately called off, dispatching a bus for a run
    // somebody had explicitly stopped.
    const { count } = await prisma.trip.updateMany({
      where: {
        serviceDate: date,
        status: { in: ['PLANNED', 'ON_SCHEDULE', 'DELAYED'] },
        ...(schoolId ? { route: { schoolId } } : {}),
      },
      data: { status: 'CANCELLED', cancelledByCalendarDayId: row.id },
    });

    res.json({ ...row, date: ymd(row.date), ...impact, tripsCancelled: count, applied: true });
  } catch (err) {
    req.log.error({ err }, 'create calendar day failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/calendar/:id', schoolAdminsOnly, async (req, res) => {
  try {
    const row = await prisma.calendarDay.findUnique({ where: { id: req.params.id } });
    if (!row) return res.status(404).json({ error: 'Calendar entry not found' });
    if (!row.schoolId && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Only a super admin can reopen a platform-wide closure' });
    }
    if (row.schoolId && req.user.role !== 'SUPER_ADMIN' && row.schoolId !== req.user.schoolId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Reopening must RESTORE, not merely remove the row. Once the materialiser has
    // run for that date, deleting the closure alone regenerates nothing: no trips, no
    // error, no alarm — the undo path would itself be the outage it was undoing.
    const { count } = await prisma.trip.updateMany({
      where: { cancelledByCalendarDayId: row.id },
      data: { status: 'PLANNED', cancelledByCalendarDayId: null },
    });
    await prisma.calendarDay.delete({ where: { id: row.id } });

    res.json({ success: true, tripsRestored: count });
  } catch (err) {
    req.log.error({ err }, 'delete calendar day failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Preview ──────────────────────────────────────────────
//
// A verdict per date, never a bare list of surviving days. 'Thursday is missing' and
// 'Thursday is missing because Diwali' are different screens, and a bare list forces
// the dashboard to re-derive the reason — which is the duplicated-logic trap that
// lets a preview and reality drift apart. Both this and the materialiser call the
// same resolver, so they cannot disagree.
app.get('/api/routes/:routeId/schedule-preview', schoolAdminsOnly, async (req, res) => {
  try {
    const route = await prisma.route.findUnique({
      where: { id: req.params.routeId }, select: { schoolId: true },
    });
    if (!route) return res.status(404).json({ error: 'Route not found' });
    if (req.user.role !== 'SUPER_ADMIN' && route.schoolId !== req.user.schoolId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const days = Math.min(parseInt(req.query.days, 10) || 14, 60);
    const from = req.query.from
      ? dateOnly(req.query.from)
      : (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();
    const dates = Array.from({ length: days }, (_, i) => {
      const d = new Date(from); d.setDate(d.getDate() + i); return d;
    });
    const to = dates[dates.length - 1];

    const runs = await prisma.run.findMany({ where: { routeId: req.params.routeId } });
    const [exceptions, closures] = await Promise.all([
      prisma.runException.findMany({
        where: { runId: { in: runs.map((r) => r.id) }, date: { gte: from, lte: to } },
      }),
      prisma.calendarDay.findMany({
        where: { date: { gte: from, lte: to }, OR: [{ schoolId: route.schoolId }, { schoolId: null }] },
      }),
    ]);
    const exFor = new Map(exceptions.map((e) => [`${e.runId}::${ymd(e.date)}`, e]));
    const closureFor = new Map();
    for (const c of closures) closureFor.set(`${c.schoolId || '*'}::${ymd(c.date)}`, c);

    res.json(
      runs.map((run) => ({
        runId: run.id,
        name: run.name,
        direction: run.direction,
        dates: dates.map((date) => {
          const day = ymd(date);
          const v = resolveRunOnDate(
            run,
            date,
            exFor.get(`${run.id}::${day}`) || null,
            closureFor.get(`${route.schoolId}::${day}`) || closureFor.get(`*::${day}`) || null
          );
          return { date: day, status: v.status, reason: v.reason, departure: v.departure };
        }),
      }))
    );
  } catch (err) {
    req.log.error({ err }, 'schedule preview failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── QR cards ─────────────────────────────────────────────
//
// The ONLY response in this system that emits qrToken. Not the students list, not
// search, not the CSV export, not any driver or parent payload. One response shape
// means "who can see card credentials" has exactly one answer, and the day someone
// adds a field to the students endpoint they cannot leak it by accident.
//
// POST with explicit ids rather than GET over a school: a GET returning every
// credential would sit in browser history and in any school proxy log, and schools run
// filtered, logged connections as a matter of course.
app.post('/api/schools/:schoolId/qr-cards',
  requireTenant('schoolId'),
  authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'),
  validate({ body: S.qrCards }),
  async (req, res) => {
    try {
      const students = await prisma.student.findMany({
        // schoolId is not optional here even though the ids are explicit — without it
        // an admin could print another school's cards by pasting their ids.
        where: { id: { in: req.body.studentIds }, schoolId: req.params.schoolId },
        select: {
          id: true, name: true, grade: true, qrToken: true, qrCodeImported: true,
          routeMappings: {
            select: { routeStop: { select: { name: true } } },
            orderBy: { createdAt: 'asc' },
            take: 1,
          },
        },
        orderBy: [{ grade: 'asc' }, { name: 'asc' }],
      });

      // A partial result would conceal forged or stale ids. Reject the entire request
      // without revealing which id belongs to another tenant.
      if (students.length !== req.body.studentIds.length) {
        return res.status(403).json({ error: 'Forbidden: one or more students are outside this school' });
      }

      // Stamp what we just handed out. Printing is the act that creates a card, so
      // recording it here means nobody has to remember to tick anything — and it is
      // the only honest signal that a card exists in a child's hand rather than a
      // token existing in a table.
      //
      // Deliberately not conditional on the sheet actually reaching paper: we cannot
      // observe a printer. "These were issued for printing" is what we know, and
      // reissuing is cheap, so erring towards marking them is the right way round.
      const issuedAt = new Date();
      if (students.length > 0) {
        await prisma.student.updateMany({
          where: { id: { in: students.map((st) => st.id) } },
          data: { qrCardPrintedAt: issuedAt },
        });
      }

      req.log.info(
        { schoolId: req.params.schoolId, requested: req.body.studentIds.length, returned: students.length },
        'qr cards issued'
      );

      res.json(
        students.map((st) => ({
          studentId: st.id,
          name: st.name,
          grade: st.grade,
          routeStopName: st.routeMappings[0]?.routeStop?.name || null,
          qrToken: st.qrToken,
          // A school that brought its own codes already has cards for these children.
          // Printing again hands a child a second, competing code.
          qrCodeImported: st.qrCodeImported,
          printedAt: issuedAt.toISOString(),
        }))
      );
    } catch (err) {
      req.log.error({ err }, 'qr cards failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// Resolve a scanned card that is not on the caller's own roster — the wrong-bus case.
//
// Rate limited and school-scoped rather than a free resolver, because imported codes
// are roll and admission numbers: short, sequential and guessable. Without both, a
// driver token would be an oracle for enumerating children.
const qrLookupLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many card lookups — slow down' },
});

app.post('/api/qr-lookup',
  authorizeRoles('DRIVER', 'SCHOOL_ADMIN', 'SUPER_ADMIN'),
  qrLookupLimiter,
  validate({ body: S.qrLookup }),
  async (req, res) => {
    try {
      // A driver's school comes from their own record, never from the request.
      const me = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { schoolId: true },
      });
      const schoolId = req.user.role === 'SUPER_ADMIN' ? undefined : me?.schoolId;
      if (!schoolId && req.user.role !== 'SUPER_ADMIN') {
        return res.status(403).json({ error: 'Forbidden' });
      }

      // qrToken is not stored hashed, so this compares in the application. At one
      // school's roll it is a bounded scan; if that ever stops being true, store the
      // hash as a column and index it rather than widening this.
      const students = await prisma.student.findMany({
        where: schoolId ? { schoolId } : {},
        select: { id: true, name: true, grade: true, photoUrl: true, schoolId: true, qrToken: true },
      });
      const match = students.find((st) => st.qrToken && qrHash(st.qrToken) === req.body.qrHash);

      if (!match) {
        // Deliberately the same answer for "no such card" and "not this school": a
        // driver must not be able to probe which codes exist elsewhere.
        return res.status(404).json({ error: 'No student matches this card' });
      }

      res.json({
        studentId: match.id,
        name: match.name,
        grade: match.grade,
        photoUrl: match.photoUrl,
      });
    } catch (err) {
      req.log.error({ err }, 'qr lookup failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

app.get('/api/schools/:schoolId/attendance/today', requireTenant('schoolId'), schoolAdminsOnly, async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const logs = await prisma.attendanceLog.findMany({
      where: { student: { schoolId: req.params.schoolId }, timestamp: { gte: today } },
      include: { student: true, trip: { include: { route: true } } },
    });
    res.json(logs);
  } catch (err) {
    req.log.error({ err }, 'list attendance failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// School stats
app.get('/api/schools/:schoolId/stats', requireTenant('schoolId'), schoolAdminsOnly, async (req, res) => {
  try {
    const schoolId = req.params.schoolId;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const [totalStudents, totalRoutes, activeTrips, totalBoarded, pendingLeaves] = await Promise.all([
      prisma.student.count({ where: { schoolId } }),
      prisma.route.count({ where: { schoolId } }),
      // Named activeTrips, so it must count DELAYED as well — a late bus is still
      // out on the road, and the dashboard under-reported every time one ran late.
      prisma.trip.count({ where: { route: { schoolId }, status: { in: ['ON_SCHEDULE', 'DELAYED'] } } }),
      prisma.attendanceLog.count({ where: { student: { schoolId }, type: 'BOARDED', timestamp: { gte: today } } }),
      prisma.leaveApplication.count({ where: { student: { schoolId }, status: 'PENDING' } }),
    ]);
    res.json({ totalStudents, totalRoutes, activeTrips, totalBoarded, pendingLeaves });
  } catch (err) {
    req.log.error({ err }, 'school stats failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Parent APIs ──────────────────────────────────────────
app.patch('/api/parents/:id/preferences',
  requireSelfOrRoles('id', 'SUPER_ADMIN'),
  validate({ body: S.preferences }),
  async (req, res) => {
    try {
      const notificationSettings = req.body || {};
      const user = await prisma.user.update({
        where: { id: req.params.id },
        data: { notificationSettings: JSON.stringify(notificationSettings) },
      });
      const prefs = user.notificationSettings
        ? typeof user.notificationSettings === 'string'
          ? JSON.parse(user.notificationSettings)
          : user.notificationSettings
        : {};
      res.json({ preferences: prefs });
    } catch (err) {
      req.log.error({ err }, 'update parent prefs failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// Parents of the children riding a given trip. Used to scope emergency alerts to the
// families actually affected instead of the whole school.
async function parentIdsOnTrip(tripId) {
  if (!tripId) return [];
  const trip = await prisma.trip.findUnique({
    where: { id: tripId },
    include: {
      route: {
        include: {
          stops: { include: { studentMappings: { select: { student: { select: { parentId: true } } } } } },
        },
      },
    },
  });
  const ids = new Set();
  trip?.route?.stops?.forEach((stop) => {
    stop.studentMappings.forEach((m) => {
      if (m.student.parentId) ids.add(m.student.parentId);
    });
  });
  return Array.from(ids);
}

// Confirms the student belongs to this parent. Admins pass through — the route-level
// tenant-user guard has already established they may act for this parent.
async function loadParentStudent(req, res) {
  const student = await prisma.student.findUnique({
    where: { id: req.params.studentId },
    include: { school: { select: { phone: true, contactPhone: true } } },
  });
  if (!student) {
    res.status(404).json({ error: 'Student not found' });
    return null;
  }
  if (student.parentId !== req.params.parentId) {
    res.status(403).json({ error: 'Forbidden: not your child' });
    return null;
  }
  return student;
}

function requireTenantUserAccess(paramName, expectedRole) {
  return async (req, res, next) => {
    if (req.user.role === 'SUPER_ADMIN') return next();
    const targetId = req.params[paramName];
    if (req.user.role === expectedRole && req.user.id === targetId) return next();
    if (req.user.role !== 'SCHOOL_ADMIN') return res.status(403).json({ error: 'Forbidden' });

    try {
      const target = await prisma.user.findUnique({
        where: { id: targetId },
        select: { role: true, schoolId: true },
      });
      if (target?.role === expectedRole && target.schoolId === req.user.schoolId) return next();
      return res.status(403).json({ error: 'Forbidden' });
    } catch (err) {
      req.log.error({ err }, 'tenant user authorization failed');
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}

const requireParentAccess = requireTenantUserAccess('parentId', 'PARENT');
const requireDriverAccess = requireTenantUserAccess('driverId', 'DRIVER');

app.get('/api/parents/:parentId/students',
  requireParentAccess,
  async (req, res) => {
    try {
      const students = await prisma.student.findMany({
        where: { parentId: req.params.parentId },
        include: {
          school: { select: { phone: true, contactPhone: true, timezone: true, leaveCutoffMinutes: true, leaveResponseHours: true } },
          routeMappings: {
            // Oldest first, so the fallbacks below are stable across refreshes.
            orderBy: { createdAt: 'asc' },
            include: {
              routeStop: {
                include: {
                  route: {
                    include: {
                      trips: {
                        where: { status: { in: ['PLANNED', 'ON_SCHEDULE', 'DELAYED', 'COMPLETED', 'CANCELLED'] }, OR: [{ serviceDate: { gte: new Date(Date.now() - 2 * 86400000) } }, { serviceDate: null }] },
                        // The parent screen shows ONE trip, so the order decides which.
                        // Unordered, a school day with a morning and an afternoon leg on the
                        // same route handed out whichever Postgres returned first — and an
                        // abandoned morning trip stuck in ON_SCHEDULE could win all afternoon,
                        // reporting IN_TRANSIT for a run that finished before lunch.
                        //
                        // Most recently STARTED first, so a running leg always beats a
                        // finished one. Trips that have not started sort last (startTime is
                        // null) and fall back to creation order, which is the next one due.
                        orderBy: [{ startTime: { sort: 'desc', nulls: 'last' } }, { createdAt: 'asc' }],
                        include: {
                          driver: { select: { name: true, phone: true } },
                          bus: { select: { licensePlate: true, deviceId: true } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });
      // Today's boarding state and approved leave, in two bounded queries across this
      // parent's children. The home screen said "On board" off a bus telemetry packet
      // because it had nothing else to read — a child at home sick showed as on board
      // while the bus ran its route. These are what it should have been reading.
      const bounds = students.map(s => dayBounds(calendarDate(new Date(), s.school?.timezone || DEFAULT_ZONE), s.school?.timezone || DEFAULT_ZONE));
      const startOfToday = new Date(Math.min(...bounds.map(b => +b.start), Date.now()));
      const endOfToday = new Date(Math.max(...bounds.map(b => +b.end), Date.now()));
      const childIds = students.map((s) => s.id);

      const [todaysLogs, todaysLeave] = await Promise.all([
        childIds.length
          ? prisma.attendanceLog.findMany({
              where: { studentId: { in: childIds }, timestamp: { gte: startOfToday } },
              orderBy: { timestamp: 'desc' },
              select: { studentId: true, type: true, timestamp: true, tripId: true, source: true, stopId: true, stopName: true, lat: true, lng: true, recordedBy: true, handoverConfirmed: true, evidenceAt: true },
            })
          : [],
        childIds.length
          ? prisma.leaveApplication.findMany({
              where: {
                studentId: { in: childIds },
                status: 'APPROVED',
                startDate: { lte: endOfToday },
                endDate: { gte: startOfToday },
              },
              select: { studentId: true, direction: true, startDay: true, endDay: true, timezone: true },
            })
          : [],
      ]);

      const formatted = students.map((s) => {
        // A child can hold a pickup mapping and a drop-off mapping, each on its own
        // route with its own active trip, so [0] showed the morning stop all afternoon
        // — and picked whichever row Postgres returned first while doing it. Prefer the
        // leg whose trip direction matches the mapping, then a trip that has actually
        // started, then any trip at all. One symmetric mapping resolves to itself,
        // exactly as before.
        const zone = s.school?.timezone || DEFAULT_ZONE;
        const best = selectJourney(s.routeMappings, new Date(), zone);
        const next = selectNextJourney(s.routeMappings, new Date());
        const stop = best?.stop || null;
        const t = best?.trip || null;
        const localDay = calendarDate(new Date(), zone);
        const scan = t ? todaysLogs.find(l => l.studentId === s.id && l.tripId === t.id && calendarDate(l.timestamp, zone) === localDay) || null : null;
        let tripStatus = 'NOT_STARTED';
        if (t) {
          if (t.status === 'ON_SCHEDULE') tripStatus = 'IN_TRANSIT';
          else tripStatus = t.status;
        }
        return {
          id: s.id,
          name: s.name,
          grade: s.grade,
          photoUrl: s.photoUrl,
          routeStopName: stop?.name || 'Unassigned',
          driverName: t?.driver?.name || 'Unassigned',
          licensePlate: t?.bus?.licensePlate || 'Unassigned',
          tripStatus,
          journeyState: journeyState(t, scan),
          schoolDate: localDay,
          timezone: zone,
          syncedAt: new Date().toISOString(),
          readiness: {
            childLinked: true,
            stopAssigned: Boolean(stop),
            journeyScheduled: Boolean(t || next),
            contactsAvailable: Boolean(s.guardianPhone || t?.driver?.phone || s.school?.phone || s.school?.contactPhone),
          },
          leavePolicy: {
            cutoffMinutes: s.school?.leaveCutoffMinutes ?? null,
            expectedResponseHours: s.school?.leaveResponseHours ?? null,
          },
          nextJourney: next ? {
            tripId: next.trip.id,
            direction: next.trip.direction || null,
            scheduledStart: next.trip.scheduledStart,
            stopId: next.stop?.id || null,
            stopName: next.stop?.name || null,
          } : null,
          // Where the CHILD is, as opposed to where the bus is. null status means no
          // scan today — genuinely unknown, and not the same as absent. The app must
          // render unknown as unknown; that distinction is the whole point.
          attendance: {
            status: scan?.type || null,
            at: scan?.timestamp?.toISOString() || null,
            tripId: scan?.tripId || null,
            source: scan?.source || null,
            stopId: scan?.stopId || null,
            stopName: scan?.stopName || null,
            lat: scan?.lat ?? null,
            lng: scan?.lng ?? null,
            recordedBy: scan?.recordedBy || null,
            handoverConfirmed: scan?.handoverConfirmed || false,
            evidenceAt: scan?.evidenceAt || null,
          },
          // Approved leave covering today. A child on leave who never boards is not a
          // no-show, and must not read as one on any screen.
          onLeave: todaysLeave.some(l => l.studentId === s.id && (!l.direction || l.direction === t?.direction) && (!l.startDay || (l.startDay <= localDay && l.endDay >= localDay))),
          busId: t?.busId || null,
          tripId: t?.id || null,
          // The child's own stop — needed to draw the pin and to measure an ETA against.
          stopId: stop?.id || null,
          stopLat: stop?.lat ?? null,
          stopLng: stop?.lng ?? null,
          // Schedule offset from trip start, in minutes (null when the school has not
          // filled it in). Combined with trip.startTime it gives a real arrival time.
          stopOffsetMinutes: stop?.expectedArrivalMinutes ?? null,
          ...stopEta(t, stop),
          trip: t
            ? {
                id: t.id,
                status: t.status,
                // Which way the bus is going. Null on a hand-created trip — only the
                // materialiser sets it — so "reached school" vs "reached home" is a
                // three-way render, not a boolean.
                direction: t.direction ?? null,
                scheduledStart: t.scheduledStart,
                startTime: t.startTime,
                endTime: t.endTime,
                // Computed at departure against scheduledStart; null/0 when the school
                // has not scheduled the trip.
                currentEtaMessage: t.currentEtaMessage ?? null,
                delayMinutes: t.delayMinutes ?? 0,
              }
            : null,
          guardianPhone: s.guardianPhone || null,
          driverPhone: t?.driver?.phone || null,
          schoolPhone: s.school?.phone || s.school?.contactPhone || null,
        };
      });
      res.json(formatted);
    } catch (err) {
      req.log.error({ err }, 'list parent students failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// Trip detail for a parent: the same route/stop shape drivers get, minus every other
// child's identity. studentMappings are reduced to counts before they leave the server.
app.get('/api/parents/:parentId/students/:studentId/trip',
  requireParentAccess,
  async (req, res) => {
    try {
      const student = await loadParentStudent(req, res);
      if (!student) return;

      // Every mapping the child has, not the oldest one. A child can be collected at
      // one stop and returned to another, so which stop is "theirs" depends on the leg
      // that is running — and locking to the oldest mapping meant the afternoon screen
      // was labelled with the morning stop, on whichever route happened to be saved
      // first.
      const mappings = await prisma.studentRouteMapping.findMany({
        where: { studentId: student.id },
        include: { routeStop: { select: { id: true, routeId: true } } },
        orderBy: { createdAt: 'asc' },
      });
      if (mappings.length === 0) return res.status(404).json({ error: 'Student is not mapped to a route stop' });

      const rideClauses = mappings.map((m) => ({
        routeId: m.routeStop.routeId,
        ...(m.direction ? { direction: m.direction } : {}),
      }));

      const trip = await prisma.trip.findFirst({
        where: {
          OR: rideClauses,
          status: { in: ['PLANNED', 'ON_SCHEDULE', 'DELAYED'] },
        },
        include: {
          route: {
            include: {
              stops: {
                orderBy: { orderIdx: 'asc' },
                // `direction` rides along so a stop's boarding count covers the children
                // riding THIS leg, not everyone ever mapped to the stop.
                include: { studentMappings: { select: { studentId: true, direction: true } } },
              },
            },
          },
          bus: { select: { id: true, licensePlate: true } },
          driver: { select: { name: true } },
        },
        // Same rule as the students list above, and for the same reason: createdAt
        // alone let an abandoned morning trip stuck in ON_SCHEDULE win all afternoon.
        // The two endpoints back the same screen, so they must pick the same trip —
        // disagreeing here shows a parent one trip on the card and another on tap.
        orderBy: [{ startTime: { sort: 'desc', nulls: 'last' } }, { createdAt: 'asc' }],
      });
      if (!trip) return res.status(404).json({ error: 'No active trip on this route' });

      // The leg that is running decides which stop is this child's. Exact direction
      // match first, then a both-legs mapping, then anything on that route — so a
      // child with one symmetric stop resolves exactly as it always did.
      const onThisRoute = (m) => m.routeStop.routeId === trip.routeId;
      const mapping =
        mappings.find((m) => onThisRoute(m) && m.direction === trip.direction) ||
        mappings.find((m) => onThisRoute(m) && !m.direction) ||
        mappings.find(onThisRoute) ||
        mappings[0];

      const [logs, routeEvents] = await Promise.all([
        prisma.attendanceLog.findMany({
          where: { tripId: trip.id },
          select: { studentId: true, type: true, timestamp: true, stopId: true },
        }),
        prisma.stopEvent?.findMany
          ? prisma.stopEvent.findMany({ where: { tripId: trip.id }, orderBy: { occurredAt: 'asc' } })
          : [],
      ]);

      const ridesThisLeg = (m) => !trip.direction || !m.direction || m.direction === trip.direction;
      const stops = trip.route.stops.map((stop) => {
        const stopStudentIds = new Set(
          stop.studentMappings.filter(ridesThisLeg).map((m) => m.studentId)
        );
        const boardings = logs.filter((l) => l.type === 'BOARDED' && stopStudentIds.has(l.studentId));
        // Only a record captured at this exact stop advances progress. A scheduled
        // time passing, or a child assigned to this stop scanning somewhere else,
        // is not evidence that the bus reached it.
        const stopEvents = [
          ...logs.filter((l) => l.stopId === stop.id),
          ...routeEvents.filter((e) => e.stopId === stop.id && e.type === 'ARRIVED').map((e) => ({ timestamp: e.occurredAt })),
        ];
        const firstPassage = stopEvents.reduce(
          (earliest, l) => (!earliest || l.timestamp < earliest ? l.timestamp : earliest),
          null
        );
        return {
          id: stop.id,
          name: stop.name,
          lat: stop.lat,
          lng: stop.lng,
          orderIdx: stop.orderIdx,
          expectedArrivalMinutes: stop.expectedArrivalMinutes ?? null,
          ...stopEta(trip, stop),
          isMyStop: stop.id === mapping.routeStop.id,
          boardedCount: boardings.length,
          passedAt: firstPassage ? new Date(firstPassage).toISOString() : null,
        };
      });

      res.json({
        id: trip.id,
        status: trip.status,
        direction: trip.direction ?? null,
        startTime: trip.startTime,
        endTime: trip.endTime,
        busId: trip.busId,
        licensePlate: trip.bus?.licensePlate || null,
        driverName: trip.driver?.name || 'Unassigned',
        route: { id: trip.routeId, name: trip.route.name, stops },
      });
    } catch (err) {
      req.log.error({ err }, 'parent trip detail failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// Attendance history for one child.
app.get('/api/parents/:parentId/students/:studentId/attendance',
  requireParentAccess,
  async (req, res) => {
    try {
      const student = await loadParentStudent(req, res);
      if (!student) return;

      const limit = Math.min(parseInt(req.query.limit) || 20, 100);
      const [logs, mapping] = await Promise.all([
        prisma.attendanceLog.findMany({
          where: { studentId: student.id },
          orderBy: { timestamp: 'desc' },
          take: limit,
          // `source` belongs here rather than only on the card's latest-scan object:
          // this is the screen where a school reconstructs a disputed day, and
          // "scanned" versus "asserted by the office" is precisely what is in question.
          select: { id: true, type: true, timestamp: true, tripId: true, source: true },
        }),
        // Same ordering as the trip endpoint above — these two label the same child's
        // stop on two screens, and picking differently is how a parent sees one stop
        // on the card and another in history.
        prisma.studentRouteMapping.findFirst({
          where: { studentId: student.id },
          include: { routeStop: { select: { name: true } } },
          orderBy: { createdAt: 'asc' },
        }),
      ]);

      // AttendanceLog has no stop column: this is the child's assigned pickup stop,
      // not necessarily where each individual scan happened.
      const stopName = mapping?.routeStop?.name || null;
      res.json(
        logs.map((l) => ({
          id: l.id,
          type: l.type,
          tripId: l.tripId,
          source: l.source,
          timestamp: l.timestamp,
          createdAt: l.timestamp,
          stopName,
        }))
      );
    } catch (err) {
      req.log.error({ err }, 'parent attendance history failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// Cold-start companion to the `emergency_alert` socket event: alerts raised on the
// trips this parent's children ride. School-wide alerts for other buses are excluded.
app.get('/api/parents/:parentId/alerts',
  requireParentAccess,
  async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 20, 100);
      const mappings = await prisma.studentRouteMapping.findMany({
        where: { student: { parentId: req.params.parentId } },
        include: { routeStop: { select: { routeId: true } } },
      });
      const routeIds = [...new Set(mappings.map((m) => m.routeStop.routeId))];
      if (routeIds.length === 0) return res.json([]);

      const trips = await prisma.trip.findMany({
        where: { routeId: { in: routeIds } },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { id: true },
      });
      const tripIds = trips.map((t) => t.id);
      if (tripIds.length === 0) return res.json([]);

      const alerts = await prisma.emergencyAlert.findMany({
        where: { tripId: { in: tripIds } },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });
      res.json(
        alerts.map((a) => ({
          id: a.id,
          type: a.type,
          message: a.message,
          status: a.status,
          resolved: a.status === 'RESOLVED',
          tripId: a.tripId,
          createdAt: a.createdAt,
        }))
      );
    } catch (err) {
      req.log.error({ err }, 'parent alerts failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

app.get('/api/parents/:parentId/leaves',
  requireParentAccess,
  async (req, res) => {
    try {
      const leaves = await prisma.leaveApplication.findMany({
        where: { student: { parentId: req.params.parentId } },
        include: { student: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
      });
      res.json(leaves);
    } catch (err) {
      req.log.error({ err }, 'list parent leaves failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

app.get('/api/parents/:parentId/notifications',
  requireSelfOrRoles('parentId', 'SUPER_ADMIN'),
  async (req, res) => {
    try {
      const notifications = await prisma.notification.findMany({
        where: { userId: req.params.parentId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      res.json(notifications);
    } catch (err) {
      req.log.error({ err }, 'list parent notifications failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── Driver APIs ──────────────────────────────────────────
async function sosHandler(req, res) {
  try {
    // Enforce: caller must be authenticated. schoolId is derived from token, not body.
    const schoolId = req.user.schoolId;
    if (!schoolId && req.user.role !== 'SUPER_ADMIN') return res.status(400).json({ error: 'No school context' });

    const { message, tripId } = req.body;
    if (tripId) {
      const trip = await prisma.trip.findUnique({ where: { id: tripId }, include: { route: true } });
      if (!trip) return res.status(404).json({ error: 'Trip not found' });
      if (trip.driverId !== req.user.id && req.user.role !== 'SUPER_ADMIN') {
        return res.status(403).json({ error: 'Forbidden: not your trip' });
      }
      if (trip.route.schoolId !== schoolId && req.user.role !== 'SUPER_ADMIN') {
        return res.status(403).json({ error: 'Forbidden: cross-tenant' });
      }
    }

    const alert = await prisma.emergencyAlert.create({
      data: {
        schoolId: schoolId || 'unknown',
        senderId: req.user.id,
        type: req.body.type || 'DRIVER_SOS',
        message: message || 'Driver triggered SOS',
        tripId: tripId || null,
        status: 'ACTIVE',
        audience: 'PARENTS',
      },
    });
    syncEmergencyAlertToFirebase(alert);
    emitToSchool(io, alert.schoolId, 'emergency_alert', alert);
    // Parents are not in the school room. Reach only the families whose child rides
    // this trip — a parent should not be alarmed by an unrelated bus.
    if (alert.tripId) {
      const parents = await parentIdsOnTrip(alert.tripId);
      parents.forEach((pid) => emitToUser(io, pid, 'emergency_alert', alert));
      pushToUsers(parents, {
        title: 'Emergency alert',
        body: alert.message || 'An emergency was raised on your child bus route.',
        data: { type: 'EMERGENCY', alertId: alert.id, tripId: alert.tripId },
      });
    }
    // alertId duplicates `id` so the driver app can poll GET /api/alerts/:id for
    // acknowledgement without unpacking the alert object.
    res.json({ ...alert, alertId: alert.id });
  } catch (err) {
    req.log.error({ err }, 'sos failed');
    res.status(500).json({ error: 'Internal server error' });
  }
}
// Acknowledgement check for a raised SOS. The driver who sent it, any admin of that
// school, and SUPER_ADMIN may read it. `acknowledged` flips once an admin resolves
// the alert via POST /api/notifications/:id/resolve.
app.get('/api/alerts/:id', async (req, res) => {
  try {
    const alert = await prisma.emergencyAlert.findUnique({ where: { id: req.params.id } });
    if (!alert) return res.status(404).json({ error: 'Alert not found' });

    const isSuper = req.user.role === 'SUPER_ADMIN';
    const isOwnSchoolAdmin = req.user.role === 'SCHOOL_ADMIN' &&
      Boolean(req.user.schoolId) && alert.schoolId === req.user.schoolId;
    const isSender = alert.senderId === req.user.id;
    if (!isSuper && !isOwnSchoolAdmin && !isSender) return res.status(403).json({ error: 'Forbidden' });

    res.json({ ...alert, alertId: alert.id, acknowledged: alert.status !== 'ACTIVE' });
  } catch (err) {
    req.log.error({ err }, 'get alert failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/alerts/sos', authorizeRoles('DRIVER', 'SUPER_ADMIN'), validate({ body: S.sos }), sosHandler);
app.post('/api/driver/emergency', authorizeRoles('DRIVER', 'SUPER_ADMIN'), validate({ body: S.sos }), sosHandler); // doc-parity alias

// Which of a driver's trips the phone should sign GPS for.
//
// This used to be the oldest-created trip across PLANNED and running, so a trip that was
// materialised but never started (a skipped morning run, say) outranked the one the driver
// had actually started. The phone then signed every fix as the old trip's bus: that bus
// moved on every map while the bus really on the road was invisible to its school and its
// parents. The trip being driven wins; failing that, the one due soonest.
function telemetryTripFor(trips) {
  const running = trips
    .filter((t) => t.status === 'ON_SCHEDULE' || t.status === 'DELAYED')
    // Only one should be running; if two are, the one started last is the one on the road.
    .sort((a, b) => (+new Date(b.startTime || 0)) - (+new Date(a.startTime || 0)));
  if (running.length) return running[0];
  const due = (t) => (t.scheduledStart ? +new Date(t.scheduledStart) : Infinity);
  return trips
    .filter((t) => t.status === 'PLANNED')
    .sort((a, b) => due(a) - due(b) || (+new Date(a.createdAt)) - (+new Date(b.createdAt)))[0] || null;
}

// Phone-GPS telemetry credentials for the authenticated driver's assigned bus.
// Fetch this only when starting phone-based tracking. Returns, to the DRIVER only, a
// key for their own active trip (telemetryKeys.js) — never the bus's permanent secret.
// The field keeps its old name, deviceSecret, so every app build signs with it as is.
// The key verifies only while that trip is running with this driver on it.
app.get('/api/driver/telemetry-credentials', async (req, res) => {
  try {
    if (req.user.role !== 'DRIVER') return res.status(403).json({ error: 'Forbidden: drivers only' });
    const trips = await prisma.trip.findMany({
      where: { driverId: req.user.id, status: { in: ['PLANNED', 'ON_SCHEDULE', 'DELAYED'] } },
      select: {
        id: true, status: true, startTime: true, scheduledStart: true, createdAt: true,
        bus: { select: { id: true, deviceId: true } },
      },
    });
    const activeTrip = telemetryTripFor(trips);
    if (!activeTrip || !activeTrip.bus) {
      return res.status(404).json({ error: 'No active trip with an assigned device' });
    }
    res.json({
      deviceId: activeTrip.bus.deviceId,
      deviceSecret: tripTelemetryKey(activeTrip.bus.id, activeTrip.id, req.user.id),
      tripId: activeTrip.id,
    });
  } catch (err) {
    req.log.error({ err }, 'telemetry credentials failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Self Profile Management
app.get('/api/users/me', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    delete user.password;
    delete user.fcmToken;
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Device push token registration. Send the token after the user grants notification
// permission; send null on sign-out from that device.
app.post('/api/users/me/fcm-token', validate({ body: S.fcmToken }), async (req, res) => {
  // Refuse rather than accept a registration we cannot honour.
  //
  // Without a service account sendPush silently does nothing, so a client would
  // register a token, get a 200, and ship onboarding copy promising alerts that
  // never arrive — with no signal in the client, the logs, or to the parent. The
  // first sign would be a parent who quietly stops opening the app.
  //
  // So the far end announces its own absence rather than the near end assuming
  // presence. A client that checks can hold its copy; one that ignores this gets
  // an error instead of a false success.
  if (req.body.fcmToken && !isPushConfigured()) {
    req.log.error("fcm-token registration refused: FIREBASE_SERVICE_ACCOUNT is not set");
    return res.status(503).json({
      error: 'Push notifications are not configured on this server',
      pushEnabled: false,
    });
  }
  try {
    await prisma.user.update({
      where: { id: req.user.id },
      data: { fcmToken: req.body.fcmToken || null },
    });
    res.json({ success: true, registered: Boolean(req.body.fcmToken) });
  } catch (err) {
    req.log.error({ err }, 'fcm token registration failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/users/me', validate({ body: S.updateMe }), async (req, res) => {
  try {
    const { currentPassword, ...data } = req.body;
    if (data.password) {
      // A token alone must not be enough to change the password, or a stolen or
      // left-signed-in session becomes a permanent takeover: the new password locks
      // the owner out. Same rule as change-password. 400, not 401: every client
      // treats a 401 as a dead session and signs the user out.
      const me = await prisma.user.findUnique({ where: { id: req.user.id }, select: { password: true } });
      if (!me || !currentPassword || !(await bcrypt.compare(currentPassword, me.password))) {
        return res.status(400).json({ error: 'Enter your current password to change it', code: 'CURRENT_PASSWORD_REQUIRED' });
      }
      data.password = await bcrypt.hash(data.password, 10);
      data.mustResetPassword = false;
    }
    const updated = await prisma.user.update({ where: { id: req.user.id }, data });
    // A self password change revokes existing sessions (consistency with change-password).
    if (req.body.password) {
      invalidateUser(req.user.id);
      logoutToken(req.token);
    }
    delete updated.password;
    delete updated.fcmToken;
    res.json(updated);
  } catch (err) {
    if (err.code === 'P2002' && err.meta?.target?.includes('email')) {
      return res.status(400).json({ error: 'Email already in use' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/drivers/:id', authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'), validate({ body: S.updateDriver }), async (req, res) => {
  try {
    const driver = await prisma.user.findUnique({ where: { id: req.params.id, role: 'DRIVER' } });
    if (!driver) return res.status(404).json({ error: 'Driver not found' });
    if (req.user.role === 'SCHOOL_ADMIN' && driver.schoolId !== req.user.schoolId) return res.status(403).json({ error: 'Forbidden' });
    
    const data = { ...req.body };
    if (data.password) {
      data.password = await bcrypt.hash(data.password, 10);
      data.mustResetPassword = true;
    }
    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data
    });
    // A password reset must revoke the driver's existing tokens.
    if (req.body.password) invalidateUser(req.params.id);
    delete updated.password;
    delete updated.fcmToken;
    res.json(updated);
  } catch (err) {
    if (err.code === 'P2002' && err.meta?.target?.includes('email')) {
      return res.status(400).json({ error: 'Email already in use' });
    }
    req.log.error({ err }, 'update driver failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/drivers/:id', authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'), async (req, res) => {
  try {
    const driver = await prisma.user.findUnique({ where: { id: req.params.id, role: 'DRIVER' } });
    if (!driver) return res.status(404).json({ error: 'Driver not found' });
    if (req.user.role === 'SCHOOL_ADMIN' && driver.schoolId !== req.user.schoolId) return res.status(403).json({ error: 'Forbidden' });

    // Same as deleting a bus: a run that loses its driver silently stops producing
    // trips, and nothing about this action would have told anyone.
    const dependentRuns = await runsDependingOn({ driverId: req.params.id });
    if (dependentRuns.length > 0) {
      return res.status(409).json({
        error: 'This driver is assigned to a recurring run',
        runs: dependentRuns,
        hint: 'Assign another driver to these runs first, or deactivate them.',
      });
    }

    await prisma.user.delete({ where: { id: req.params.id } });
    invalidateUser(req.params.id);
    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, 'delete driver failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/drivers/:driverId/trips',
  requireDriverAccess,
  async (req, res) => {
    try {
      // This is the driver app's polling endpoint — by far the most requested one,
      // so every column it drags along is paid for on every poll. Keep the payload
      // to what docs/frontend/driver-app.md §2 actually documents.
      // The route include below reveals the school's timezone. Pull a deliberately
      // narrow two-day scan window first, then trim it to the exact school-local day
      // after the trips arrive. This avoids using the Render host timezone while
      // keeping a long-running trip's lifetime attendance out of the hot response.
      const attendanceLookback = new Date(Date.now() - 48 * 60 * 60 * 1000);

      const trips = await prisma.trip.findMany({
        where: { driverId: req.params.driverId, status: { in: ['PLANNED', 'ON_SCHEDULE', 'DELAYED'] } },
        include: {
          route: {
            include: {
              school: { select: { timezone: true } },
              stops: {
                orderBy: { orderIdx: 'asc' },
                include: {
                  studentMappings: {
                    include: {
                      student: { select: { id: true, name: true, rfidTag: true, grade: true, photoUrl: true, guardianPhone: true, qrToken: true, qrCardPrintedAt: true } },
                    },
                  },
                },
              },
            },
          },
          // `bus: true` shipped Bus.deviceSecret — the HMAC key — in every response.
          bus: { select: { id: true, licensePlate: true, capacity: true, deviceId: true, status: true, schoolId: true } },
          // Unbounded, this grows for the life of the trip; the app only needs
          // today's scans to know who is already aboard.
          attendanceLogs: {
            where: { timestamp: { gte: attendanceLookback } },
            select: { id: true, studentId: true, type: true, timestamp: true },
          },
        },
        orderBy: { createdAt: 'asc' },
      });

      const schoolZone = trips.find((t) => t.route?.school?.timezone)?.route.school.timezone || DEFAULT_ZONE;
      const schoolDay = dayBounds(calendarDate(new Date(), schoolZone), schoolZone);
      for (const trip of trips) {
        trip.attendanceLogs = (trip.attendanceLogs || []).filter((row) =>
          new Date(row.timestamp) >= schoolDay.start && new Date(row.timestamp) < schoolDay.end
        );
        if (trip.route) delete trip.route.school;
      }

      // Shape each trip to the leg it is actually driving, before anything downstream
      // counts students or fans out leaves.
      //
      // Stop order: a route's stops are stored in pickup order, and the app walks the
      // list top-down. On the way home that order is backwards — houses first, school
      // last. `orderIdx` is deliberately left alone; it is the route's canonical order
      // and the map editor owns it. Only the sequence handed to the driver flips.
      //
      // Roster: a child with separate pickup and drop-off stops has a mapping per leg,
      // and the wrong one must not appear. A mapping with no direction serves both,
      // which is every mapping made before that column existed.
      //
      // A trip with no direction gets both untouched — pickup order, every mapping —
      // which is exactly what it got before any of this existed.
      for (const t of trips) {
        if (!t.direction) continue;
        if (t.direction === 'FROM_SCHOOL' && t.route?.stops) t.route.stops.reverse();
        for (const stop of t.route?.stops || []) {
          stop.studentMappings = (stop.studentMappings || []).filter(
            (m) => !m.direction || m.direction === t.direction
          );
        }
      }

      // LeaveApplication hangs off Student, not Trip, so it cannot ride the include
      // above. One extra bounded query covers every student on every returned trip,
      // then fans out — the driver app reads `trip.leaveApplications` to grey out
      // kids who are not coming, so a stop is not held for them.
      const startOfToday = schoolDay.start;
      const endOfToday = schoolDay.end;

      const studentIdsByTrip = trips.map((t) => [
        ...new Set((t.route?.stops || []).flatMap((s) => s.studentMappings.map((m) => m.student.id))),
      ]);
      const allStudentIds = [...new Set(studentIdsByTrip.flat())];

      // A leave is a date range, not a single day: it covers today when it starts on
      // or before today and ends on or after it.
      const leaves = allStudentIds.length
        ? await prisma.leaveApplication.findMany({
            where: {
              studentId: { in: allStudentIds },
              status: 'APPROVED',
              startDate: { lt: endOfToday },
              endDate: { gte: startOfToday },
            },
            select: { id: true, studentId: true, status: true, startDate: true, endDate: true, scope: true, direction: true },
          })
        : [];

      // One entry per student, not one per leave row. A student can hold two APPROVED
      // leaves whose ranges both cover today, and a second entry for the same child is
      // meaningless to render — it only collides keys in the client.
      trips.forEach((t, i) => {
        t.leaveApplications = studentIdsByTrip[i].map((id) => leaves.find((l) =>
          l.studentId === id && (l.scope === 'SCHOOL' || !l.direction || !t.direction || l.direction === t.direction)
        )).filter(Boolean);
      });

      // Swap every token for its hash before this leaves the server. The scanner
      // matches on the hash, so this is all a phone needs — and it means a driver
      // payload, cached or intercepted, cannot be used to print a working card.
      // Deleting rather than omitting from the select: the token is needed here to
      // compute the hash, so it has to be removed on the way out.
      for (const t of trips) {
        for (const stop of t.route?.stops || []) {
          for (const m of stop.studentMappings || []) {
            if (!m.student) continue;
            m.student.qrHash = qrHash(m.student.qrToken);
            // A token exists for every child; a CARD exists only once the office has
            // printed one. The scanner gates on this, not on the hash — otherwise it
            // opens for a school that has printed nothing and refuses every child.
            m.student.hasCard = Boolean(m.student.qrCardPrintedAt);
            delete m.student.qrToken;
            delete m.student.qrCardPrintedAt;
          }
        }
      }

      res.json(trips);
    } catch (err) {
      req.log.error({ err }, 'list driver trips failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// Announce a trip change so clients can drop their polling loop. Goes to the school
// room (admin dashboards) and to the assigned driver, who is not in that room.
// `trip` must carry route.schoolId.
function emitTripChange(trip, reason) {
  if (!io || !trip) return;
  const payload = {
    tripId: trip.id,
    status: trip.status,
    busId: trip.busId,
    driverId: trip.driverId,
    routeId: trip.routeId,
    routeName: trip.route?.name || null,
    startTime: trip.startTime || null,
    endTime: trip.endTime || null,
    reason,
  };
  emitToSchool(io, trip.route?.schoolId, 'trip_status_change', payload);
  if (trip.driverId) emitToUser(io, trip.driverId, 'trip_status_change', payload);
  parentIdsOnTrip(trip.id)
    .then((ids) => ids.forEach((id) => emitToUser(io, id, 'journey_changed', payload)))
    .catch((err) => logger.warn({ err: err.message, tripId: trip.id }, 'parent journey event failed'));
}

async function ownsTrip(req, res, next) {
  if (req.user.role === 'SUPER_ADMIN') return next();
  const trip = await prisma.trip.findUnique({
    where: { id: req.params.tripId },
    include: { route: true },
  });
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (req.user.role === 'DRIVER' && trip.driverId === req.user.id) return next();
  if (req.user.role === 'SCHOOL_ADMIN' && trip.route.schoolId === req.user.schoolId) return next();
  return res.status(403).json({ error: 'Forbidden' });
}

app.patch('/api/trips/:tripId/status', ownsTrip, validate({ body: S.tripStatus }), async (req, res) => {
  try {
    if (req.user.role === 'DRIVER' && !['ON_SCHEDULE', 'DELAYED', 'COMPLETED'].includes(req.body.status)) {
      return res.status(403).json({ error: 'Drivers may only start, delay, or complete their own trip' });
    }

    let currentTrip = null;
    // Creation only blocks a *running* conflict, so two PLANNED trips may share a bus
    // or driver. The conflict has to be re-checked here, or both can be started and
    // the bus ends up on two live trips at once.
    if (req.body.status === 'ON_SCHEDULE' || req.body.status === 'DELAYED') {
      currentTrip = await prisma.trip.findUnique({ where: { id: req.params.tripId } });
      if (!currentTrip) return res.status(404).json({ error: 'Trip not found' });
      if (req.user.role === 'DRIVER' && ['COMPLETED', 'CANCELLED'].includes(currentTrip.status)) {
        return res.status(409).json({ error: 'A completed or cancelled trip cannot be restarted' });
      }
      const conflict = await prisma.trip.findFirst({
        where: {
          id: { not: req.params.tripId },
          OR: [{ busId: currentTrip.busId }, { driverId: currentTrip.driverId }],
          status: { in: ['ON_SCHEDULE', 'DELAYED'] },
        },
      });
      if (await stillBlocking(conflict, req.log)) {
        return res.status(400).json({ error: 'Bus or driver is already on an active trip' });
      }
    }

    if (req.body.status === 'COMPLETED' && req.user.role === 'DRIVER') {
      currentTrip = currentTrip || await prisma.trip.findUnique({ where: { id: req.params.tripId } });
      if (!currentTrip) return res.status(404).json({ error: 'Trip not found' });
      if (!['ON_SCHEDULE', 'DELAYED'].includes(currentTrip.status)) {
        return res.status(409).json({ error: 'Only a running trip can be completed' });
      }

      // Newest-first means the first row per student is their current onboard state.
      // Do not let a driver close the journey while the system still tells a family
      // their child is on the bus. School admins retain override access for genuine
      // record corrections and abandoned-trip recovery.
      const attendance = await prisma.attendanceLog.findMany({
        where: { tripId: req.params.tripId, type: { in: ['BOARDED', 'ALIGHTED'] } },
        select: { studentId: true, type: true },
        orderBy: { timestamp: 'desc' },
      });
      const latest = new Map();
      for (const row of attendance) {
        if (!latest.has(row.studentId)) latest.set(row.studentId, row.type);
      }
      const studentIds = [...latest.entries()]
        .filter(([, type]) => type === 'BOARDED')
        .map(([studentId]) => studentId);
      if (studentIds.length) {
        return res.status(409).json({
          error: 'Cannot complete trip while children are still aboard',
          studentIds,
          action: 'Record each child as ALIGHTED or ask the school office to reconcile the trip.',
        });
      }
    }

    const data = { status: req.body.status };
    if (req.body.status === 'ON_SCHEDULE' || req.body.status === 'DELAYED') {
      const actualStart = currentTrip?.startTime || new Date();
      if (!currentTrip?.startTime) data.startTime = actualStart;
      // delayMinutes and currentEtaMessage were columns nothing ever wrote. With a
      // scheduledStart to compare against they finally mean something.
      if (currentTrip?.scheduledStart) {
        const late = Math.round((actualStart - new Date(currentTrip.scheduledStart)) / 60_000);
        data.delayMinutes = Math.max(0, late);
        data.currentEtaMessage = late > 0 ? `Running ${late} min late` : 'On time';
      }
    }
    if (req.body.status === 'COMPLETED') data.endTime = new Date();
    const trip = await prisma.trip.update({
      where: { id: req.params.tripId },
      data,
      include: { route: { select: { schoolId: true, name: true } } },
    });
    emitTripChange(trip, 'status');
    res.json(trip);
  } catch (err) {
    req.log.error({ err }, 'update trip failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// The walk-around the driver app files just before it starts a trip. Until this route
// existed every one was a 404 the app swallowed, so no inspection was ever kept.
// A record, not a gate: a trip can still start without one, as it always could.
app.post('/api/trips/:tripId/pre-trip-check', ownsTrip, validate({ body: S.preTripCheck }), async (req, res) => {
  try {
    // ownsTrip lets the school in too, but this is the driver's own account of the bus.
    if (req.user.role !== 'DRIVER') {
      return res.status(403).json({ error: "Only the trip's driver can file its pre-trip check" });
    }
    const trip = await prisma.trip.findUnique({
      where: { id: req.params.tripId },
      select: { status: true, preTripCheck: { select: { id: true } } },
    });
    if (!trip) return res.status(404).json({ error: 'Trip not found' });
    if (trip.status === 'COMPLETED' || trip.status === 'CANCELLED') {
      return res.status(409).json({ error: 'This trip has ended' });
    }
    // Before departure the latest walk-around wins: a driver may redo it. Once the bus
    // is moving, the one filed before it left is the record and is not replaced.
    if (trip.status !== 'PLANNED' && trip.preTripCheck) {
      return res.status(409).json({ error: 'A pre-trip check is already recorded for this trip' });
    }

    const data = {
      driverId: req.user.id,
      items: req.body.items,
      note: req.body.note || null,
      submittedAt: new Date(),
    };
    const check = await prisma.preTripCheck.upsert({
      where: { tripId: req.params.tripId },
      create: { tripId: req.params.tripId, ...data },
      update: data,
    });
    res.json(check);
  } catch (err) {
    req.log.error({ err }, 'pre-trip check failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// The school (or the driver) reads it back. Parents are kept out by ownsTrip.
app.get('/api/trips/:tripId/pre-trip-check', ownsTrip, async (req, res) => {
  try {
    const check = await prisma.preTripCheck.findUnique({ where: { tripId: req.params.tripId } });
    if (!check) return res.status(404).json({ error: 'No pre-trip check recorded for this trip' });
    res.json(check);
  } catch (err) {
    req.log.error({ err }, 'read pre-trip check failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Notification preferences (PATCH /api/parents/:id/preferences) are free-form JSON.
// These are the keys the parent app ships; anything absent counts as enabled, so a
// parent who has never opened the settings screen keeps getting everything.
//   approaching → 5-minutes-away alert
//   boarding    → check-in / drop-off
//   delay       → delays and emergencies
function wantsNotification(settings, key) {
  if (!settings) return true;
  let prefs = settings;
  if (typeof prefs === 'string') {
    try { prefs = JSON.parse(prefs); } catch { return true; }
  }
  return prefs?.[key] !== false;
}

// Deliver an OS push to users who have registered a device token. Socket events only
// reach an app that is open; this is what reaches a locked phone.
// Never throws — a push failure must not fail the request that triggered it.
// Email the same people push reaches, for the events worth an inbox. Deliberately
// NOT wired to routine boarding scans: that is ~26,400 mails a month for one school,
// and a parent who filters those to spam stops seeing the emergency mail too. Push
// carries the routine; this carries what a parent has to act on.
//
// Gated on the same emailAlerts preference the settings screen already exposes — a
// toggle that has existed and done nothing until now.
async function emailUsers(userIds, { subject, text, html }) {
  try {
    if (!mailer.isConfigured()) return;
    const ids = [...new Set((userIds || []).filter(Boolean))];
    if (ids.length === 0) return;
    const users = await prisma.user.findMany({
      where: { id: { in: ids }, email: { not: null } },
      select: { email: true, notificationSettings: true },
    });
    const to = users.filter((u) => wantsNotification(u.notificationSettings, 'emailAlerts')).map((u) => u.email);
    if (to.length === 0) return;
    await mailer.sendMailTo(to, { subject, text, html });
  } catch (err) {
    logger.error({ err: err.message }, 'emailUsers failed');
  }
}

async function pushToUsers(userIds, payload) {
  try {
    const ids = [...new Set((userIds || []).filter(Boolean))];
    if (ids.length === 0) return;
    const users = await prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, fcmToken: true, notificationSettings: true },
    });
    const enabledUsers = users.filter((u) => wantsNotification(u.notificationSettings, 'pushNotifications'));
    const enabledIds = enabledUsers.map((u) => u.id);
    const devices = prisma.pushDevice?.findMany
      ? await prisma.pushDevice.findMany({
          where: { userId: { in: enabledIds }, enabled: true, provider: 'FCM' },
          select: { token: true },
        })
      : [];
    const tokens = [...new Set([...enabledUsers.map((u) => u.fcmToken), ...devices.map((d) => d.token)].filter(Boolean))];
    if (tokens.length === 0) return;

    const { invalidTokens, accepted = [], failed = [] } = await sendPush(tokens, payload);
    if (invalidTokens?.length) {
      // Uninstalled app / re-registered device: drop the token so it is not retried.
      await prisma.user.updateMany({
        where: { fcmToken: { in: invalidTokens } },
        data: { fcmToken: null },
      });
      if (prisma.pushDevice?.updateMany) {
        await prisma.pushDevice.updateMany({
          where: { token: { in: invalidTokens } },
          data: { enabled: false, lastFailure: 'INVALID_TOKEN' },
        });
      }
    }
    if (prisma.pushDevice?.updateMany) {
      // Only tokens FCM actually accepted count as delivered. Everything that was not
      // counted used to be stamped accepted, so a revoked key or wrong Firebase project
      // read as a healthy device. A failure leaves lastAcceptedAt alone: it stays the
      // time of the last push that really went through.
      if (accepted.length) await prisma.pushDevice.updateMany({
        where: { token: { in: accepted } }, data: { lastAcceptedAt: new Date(), lastFailure: null },
      });
      const byCode = new Map();
      for (const { token, code } of failed) {
        if (!byCode.has(code)) byCode.set(code, []);
        byCode.get(code).push(token);
      }
      for (const [code, failedTokens] of byCode) {
        await prisma.pushDevice.updateMany({
          where: { token: { in: failedTokens } }, data: { lastFailure: code },
        });
      }
    }
  } catch (err) {
    logger.error({ err: err.message }, 'push dispatch failed');
  }
}

// How far back a replayed check-in is recognised as the same scan.
const IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000;

app.post('/api/attendance', validate({ body: S.attendance }), async (req, res) => {
  try {
    const trip = await prisma.trip.findUnique({
      where: { id: req.body.tripId },
      include: { route: { include: { school: { select: { timezone: true } } } } },
    });
    if (!trip) return res.status(404).json({ error: 'Trip not found' });
    if (req.user.role === 'DRIVER' && trip.driverId !== req.user.id) return res.status(403).json({ error: 'Forbidden: not your trip' });
    if (req.user.role === 'SCHOOL_ADMIN' && trip.route.schoolId !== req.user.schoolId) return res.status(403).json({ error: 'Forbidden' });
    if (!['DRIVER', 'SCHOOL_ADMIN', 'SUPER_ADMIN'].includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });

    // A journey has to be happening for someone to board it. Nothing here checked
    // trip status, so a driver could mark children aboard a trip that was never
    // started — no departure time, no GPS track, and a real "your child boarded"
    // push to a parent about a bus standing still. The same hole accepted scans on
    // finished and cancelled trips.
    //
    // Corrections after the fact are legitimate, which is why COMPLETED is allowed for
    // the office and not for the driver: once a driver has ended a run, a missed scan
    // is a records question, and records belong to the school.
    const isAdmin = req.user.role !== 'DRIVER';

    // A queued scan flushed after the trip ended is a legitimate scan that arrived
    // late, not an invalid one — and the end of a route is exactly where signal dies,
    // so this is the common case rather than the edge. Judge it by when it happened.
    const occurredAt = req.body.occurredAt ? new Date(req.body.occurredAt) : new Date();
    // A phone with a wrong clock must not be able to file boardings into the future.
    if (occurredAt.getTime() > Date.now() + 60_000) {
      return res.status(400).json({ error: 'Scan time is in the future' });
    }
    const duringTheRun = Boolean(
      trip.startTime &&
        occurredAt >= trip.startTime &&
        (!trip.endTime || occurredAt <= trip.endTime)
    );

    if (trip.status === 'CANCELLED') {
      return res.status(409).json({ error: 'This trip was cancelled — nobody travelled on it' });
    }
    if (trip.status === 'PLANNED') {
      return res.status(409).json({ error: 'Start the trip before marking attendance' });
    }
    // Refuse a driver scanning a trip that is over — unless the scan itself happened
    // while it was running, in which case it is a late flush and belongs in the record.
    if (trip.status === 'COMPLETED' && !isAdmin && !duringTheRun) {
      return res.status(409).json({ error: 'This trip has ended. Ask the school office to correct the record' });
    }

    const student = await prisma.student.findUnique({ 
      where: { id: req.body.studentId },
      include: { parent: { select: { id: true, notificationSettings: true } } }
    });
    if (!student) return res.status(404).json({ error: 'Student not found' });
    if (student.schoolId !== trip.route.schoolId) return res.status(400).json({ error: 'Student not on this trip route' });

    // The route mappings that ride this trip's leg: all of them on a trip with no
    // direction, else the both-legs ones and this leg's. The same rule builds the
    // driver's roster (GET /api/drivers/:driverId/trips).
    const ridesThisLeg = trip.direction ? { OR: [{ direction: null }, { direction: trip.direction }] } : {};

    // Same school is not enough for a driver: their token could otherwise tell any
    // family in the school that their child had boarded a bus the child was never on.
    // The driver app only ever offers children on the trip's roster, so this refuses
    // nothing it sends. The office can still record an exception, such as a child who
    // took another bus that day.
    if (req.user.role === 'DRIVER') {
      const onRoster = await prisma.studentRouteMapping.findFirst({
        where: { studentId: student.id, routeStop: { routeId: trip.routeId }, ...ridesThisLeg },
        select: { id: true },
      });
      if (!onRoster) {
        return res.status(400).json({ error: "This child is not on this trip's route. Ask the school office to record it" });
      }
    }

    // A child on approved leave is not a no-show. Recording one would tell a family
    // their child failed to board on a day the school had already agreed they would
    // not — and because every planned absence would generate one, the alert becomes
    // noise inside a week and stops being read at all. That would destroy the only
    // notification in this product with a window in which a parent can still act.
    if (req.body.type === 'NO_SHOW') {
      const zone = trip.route?.school?.timezone || DEFAULT_ZONE;
      const { start: startOfDay, end: endOfDay } = dayBounds(calendarDate(occurredAt, zone), zone);

      const onLeave = await prisma.leaveApplication.findFirst({
        where: {
          studentId: req.body.studentId,
          status: 'APPROVED',
          startDate: { lt: endOfDay },
          endDate: { gte: startOfDay },
          OR: [
            { scope: 'SCHOOL' },
            {
              scope: 'TRANSPORT',
              ...(trip.direction ? { OR: [{ direction: null }, { direction: trip.direction }] } : {}),
            },
          ],
        },
        select: { id: true },
      });
      if (onLeave) {
        return res.status(409).json({
          error: 'This child is on approved leave today — not a no-show',
          onLeave: true,
        });
      }
    }

    // Idempotency for the driver app's offline check-in queue: a replayed scan must
    // not create a second row or fire a second notification to the parent. Callers
    // opt in with an Idempotency-Key header; the same scan (student + trip + type)
    // inside the window is treated as that replay and answered with the original row.
    //
    // The hashed key provides exact replay identity. The short natural-key fallback
    // keeps older offline clients safe until they start sending the header.
    const requestKey = req.headers['idempotency-key']
      ? crypto.createHash('sha256').update(`${req.user.id}:${req.headers['idempotency-key']}`).digest('hex')
      : null;
    if (requestKey) {
      const keyed = await prisma.attendanceLog.findFirst({ where: { requestKey } });
      if (keyed) {
        if (keyed.studentId !== req.body.studentId || keyed.tripId !== req.body.tripId || keyed.type !== req.body.type) {
          return res.status(409).json({ error: 'Idempotency-Key was already used for a different attendance record' });
        }
        return res.status(200).json({ ...keyed, duplicate: true });
      }
      const replayWindow = new Date(Date.now() - IDEMPOTENCY_WINDOW_MS);
      const existing = await prisma.attendanceLog.findFirst({
        where: {
          studentId: req.body.studentId,
          tripId: req.body.tripId,
          type: req.body.type,
          timestamp: { gte: replayWindow },
        },
        orderBy: { timestamp: 'desc' },
      });
      if (existing) return res.status(200).json({ ...existing, duplicate: true });
    }

    // MANUAL is an office correction. It asserts the same fact a scan does, so it
    // belongs in the record — but the parent stopped worrying hours ago, and pushing
    // "your child boarded" at 15:02 about a 07:38 boarding would manufacture exactly
    // the alarm this product exists to prevent.
    const source = isAdmin && req.body.source === 'MANUAL' ? 'MANUAL' : 'SCAN';

    if ((req.body.lat == null) !== (req.body.lng == null)) {
      return res.status(400).json({ error: 'lat and lng must be supplied together' });
    }
    if (req.body.handoverConfirmed && req.body.type !== 'ALIGHTED') {
      return res.status(400).json({ error: 'Handover can only be confirmed for a drop-off record' });
    }
    let evidence = {};
    if (req.body.stopId) {
      const stop = await prisma.routeStop.findFirst({
        where: {
          id: req.body.stopId,
          routeId: trip.routeId,
          studentMappings: { some: { studentId: req.body.studentId, ...ridesThisLeg } },
        },
        select: { id: true, name: true, lat: true, lng: true },
      });
      if (!stop) return res.status(400).json({ error: 'Stop is not assigned to this child for this trip' });
      const distance = req.body.lat == null ? null : distanceMeters(stop.lat, stop.lng, req.body.lat, req.body.lng);
      evidence = {
        stopId: stop.id,
        stopName: stop.name,
        lat: req.body.lat ?? null,
        lng: req.body.lng ?? null,
        recordedBy: req.user.id,
        handoverConfirmed: Boolean(req.body.handoverConfirmed),
        evidenceAt: occurredAt,
        distanceFromStopMeters: distance,
        evidenceStatus: distance == null ? 'STOP_RECORDED' : distance <= 200 ? 'EXPECTED_STOP' : 'OUTSIDE_STOP_RADIUS',
      };
    }

    const log = await prisma.attendanceLog.create({
      data: {
        studentId: req.body.studentId,
        tripId: req.body.tripId,
        type: req.body.type,
        timestamp: occurredAt,
        source,
        requestKey,
        ...evidence,
      },
    });

    if (student.parentId) emitToUser(io, student.parentId, 'journey_changed', {
      studentId: student.id, tripId: req.body.tripId, attendanceId: log.id,
      type: req.body.type, occurredAt: occurredAt.toISOString(),
    });

    if (student.parentId && source === 'SCAN') {
      const NOTIFY = {
        BOARDED: { type: 'BOARDING', title: 'Boarded the bus', body: (n) => `${n} is on board.` },
        ALIGHTED: { type: 'ARRIVAL', title: 'Off the bus', body: (n) => `${n} has been dropped off.` },
        // The one message in this product a parent can still act on, so it is worded
        // as the fact rather than as a status change, and never softened.
        NO_SHOW: { type: 'SOS', title: 'Did not board', body: (n) => `${n} was not at the stop and did not board.` },
      };
      // One scan type means two different things depending on which way the bus is
      // going. Alighting on the way in is arriving at school; on the way home it is the
      // drop-off at the child's own stop. A single wording for both sent "has been
      // dropped off" to a parent at 07:55 about a child walking into assembly — the
      // distinction Trip.direction exists to carry, read here for the first time.
      //
      // The notification `type` is deliberately unchanged, because the parent app's
      // preference toggles key off it.
      const BY_DIRECTION = {
        TO_SCHOOL: {
          BOARDED: { type: 'BOARDING', title: 'Boarded for school', body: (n) => `${n} is on board, heading to school.` },
          ALIGHTED: { type: 'ARRIVAL', title: 'Arrived at school', body: (n) => `${n} has arrived at school.` },
        },
        FROM_SCHOOL: {
          BOARDED: { type: 'BOARDING', title: 'Boarded for home', body: (n) => `${n} is on board, heading home.` },
          ALIGHTED: { type: 'ARRIVAL', title: 'Dropped off', body: (n) => `${n} has been dropped off.` },
        },
      };
      // A trip with no direction — every trip created before this, and any one-off
      // replacement service — keeps the neutral wording rather than guessing.
      const spec =
        BY_DIRECTION[trip.direction]?.[req.body.type] || NOTIFY[req.body.type] || NOTIFY.BOARDED;
      const typeEnum = spec.type;
      const title = spec.title;
      const message = spec.body(student.name);

      // The parent's toggles were being read and then ignored. `boarding` off means
      // no row and no push for check-in/drop-off; absent means on. A no-show is not a
      // routine boarding update and is not silenced by that toggle.
      if (req.body.type === 'NO_SHOW' || wantsNotification(student.parent?.notificationSettings, 'boarding')) {
        const notif = await prisma.notification.create({
          data: { userId: student.parentId, title, message, type: typeEnum,
            context: { type: typeEnum, studentId: student.id, tripId: req.body.tripId, attendanceId: log.id } }
        });

        emitToUser(io, student.parentId, 'notification', notif);
        pushToUsers([student.parentId], {
          title,
          body: message,
          data: { notificationId: notif.id, type: typeEnum, studentId: student.id, tripId: req.body.tripId },
        });
      }
    }
    
    res.json(log);
  } catch (err) {
    req.log.error({ err }, 'attendance failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Admin stats (role-aware) ─────────────────────────────
const getSchoolAdminStats = async (schoolId) => {
  const fifteenMinsAgo = new Date(Date.now() - 15 * 60000);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [
    totalBuses, totalStudents, totalRoutes, pendingLeaves,
    activeBusesLogs, busesThisMonth, studentsThisMonth,
    avgDurationRes, minRouteRes, unoptimizedRoutesCount,
  ] = await Promise.all([
    prisma.bus.count({ where: { schoolId } }),
    prisma.student.count({ where: { schoolId } }),
    prisma.route.count({ where: { schoolId } }),
    prisma.leaveApplication.count({ where: { student: { schoolId }, status: 'PENDING' } }),
    prisma.gpsLog.groupBy({ by: ['busId'], where: { bus: { schoolId }, timestamp: { gte: fifteenMinsAgo, lte: new Date() } } }),
    prisma.bus.count({ where: { schoolId, createdAt: { gte: thirtyDaysAgo } } }),
    prisma.student.count({ where: { schoolId, createdAt: { gte: thirtyDaysAgo } } }),
    prisma.route.aggregate({ _avg: { estimatedDuration: true }, where: { schoolId } }),
    prisma.route.findFirst({ where: { schoolId, estimatedDuration: { not: null } }, orderBy: { estimatedDuration: 'asc' } }),
    prisma.route.count({ where: { schoolId, stops: { none: {} } } }),
  ]);

  const activeDevices = activeBusesLogs.length;
  const offlineDevices = Math.max(0, totalBuses - activeDevices);
  const busesBase = totalBuses - busesThisMonth;
  const studentsBase = totalStudents - studentsThisMonth;

  return {
    totalBuses,
    totalStudents,
    totalRoutes,
    pendingLeaves,
    activeDevices,
    offlineDevices,
    busesGrowthPercent: busesBase > 0 ? Math.round((busesThisMonth / busesBase) * 100) : null,
    studentsGrowthPercent: studentsBase > 0 ? Math.round((studentsThisMonth / studentsBase) * 100) : null,
    averageRouteDuration: avgDurationRes._avg.estimatedDuration ? Math.round(avgDurationRes._avg.estimatedDuration) : null,
    mostEfficientRoute: minRouteRes ? `${minRouteRes.name} (${minRouteRes.estimatedDuration} mins)` : null,
    pendingOptimizations: unoptimizedRoutesCount,
  };
};

const getSuperAdminStats = async () => {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const fifteenMinsAgo = new Date(Date.now() - 15 * 60000);
  const [totalSchools, totalBuses, totalStudents, schoolsThisMonth, busesThisMonth, activeLogs] = await Promise.all([
    prisma.school.count(),
    prisma.bus.count(),
    prisma.student.count(),
    prisma.school.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
    prisma.bus.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
    prisma.gpsLog.groupBy({ by: ['busId'], where: { timestamp: { gte: fifteenMinsAgo, lte: new Date() } } }),
  ]);
  const activeDevices = activeLogs.length;
  const offlineDevices = Math.max(0, totalBuses - activeDevices);
  const schoolsBase = totalSchools - schoolsThisMonth;
  const busesBase = totalBuses - busesThisMonth;

  return {
    totalSchools,
    totalBuses,
    activeDevices,
    offlineDevices,
    stationaryDevices: 0, // computed only when driven by real state
    totalStudents,
    schoolsGrowthPercent: schoolsBase > 0 ? Math.round((schoolsThisMonth / schoolsBase) * 100) : null,
    busesGrowthPercent: busesBase > 0 ? Math.round((busesThisMonth / busesBase) * 100) : null,
  };
};

app.get(['/api/admin/stats', '/api/stats'], async (req, res) => {
  try {
    const { role, schoolId } = req.user;
    if (role === 'SCHOOL_ADMIN' && schoolId) return res.json(await getSchoolAdminStats(schoolId));
    if (role === 'SUPER_ADMIN') return res.json(await getSuperAdminStats());
    return res.status(403).json({ error: 'Forbidden' });
  } catch (err) {
    req.log.error({ err }, 'stats failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── School directory (SUPER_ADMIN) ───────────────────────
app.get('/api/schools', authorizeRoles('SUPER_ADMIN'), async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const search = req.query.search || '';
    const where = search ? { name: { contains: search, mode: 'insensitive' } } : {};
    if (req.query.status) where.status = req.query.status;
    
    // Whitelisted: an unknown column reaches Prisma as a validation error and
    // surfaces to the caller as a 500.
    const SORTABLE = ['name', 'city', 'state', 'status', 'createdAt', 'updatedAt'];
    let orderBy = { createdAt: 'desc' };
    if (req.query.sort) {
      if (!SORTABLE.includes(req.query.sort)) {
        return res.status(400).json({ error: `Cannot sort by '${req.query.sort}'. Allowed: ${SORTABLE.join(', ')}` });
      }
      orderBy = { [req.query.sort]: req.query.order === 'asc' ? 'asc' : 'desc' };
    }
    
    const [schools, total] = await Promise.all([
      prisma.school.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy }),
      prisma.school.count({ where }),
    ]);
    res.json({ data: schools, total, page, limit });
  } catch (err) {
    req.log.error({ err }, 'list schools failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});


app.get('/api/schools/summary', authorizeRoles('SUPER_ADMIN'), async (req, res) => {
  try {
    const [total, active, pending, suspended] = await Promise.all([
      prisma.school.count(),
      prisma.school.count({ where: { status: 'ACTIVE' } }),
      prisma.school.count({ where: { status: 'PENDING' } }),
      prisma.school.count({ where: { status: 'SUSPENDED' } })
    ]);
    res.json({ total, active, pending, suspended });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/schools/:id', schoolAdminsOnly, async (req, res) => {
  try {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.schoolId !== req.params.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const school = await prisma.school.findUnique({ where: { id: req.params.id } });
    if (!school) return res.status(404).json({ error: 'School not found' });
    res.json(school);
  } catch (err) {
    req.log.error({ err }, 'get school failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/schools', authorizeRoles('SUPER_ADMIN'), validate({ body: S.createSchool }), async (req, res) => {
  try {
    const school = await prisma.school.create({ data: req.body });
    res.json(school);
  } catch (err) {
    req.log.error({ err }, 'create school failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/schools/:id', authorizeRoles('SUPER_ADMIN'), validate({ body: S.updateSchool }), async (req, res) => {
  try {
    const school = await prisma.school.update({ where: { id: req.params.id }, data: req.body });
    res.json(school);
  } catch (err) {
    req.log.error({ err }, 'update school failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/schools/:id', authorizeRoles('SUPER_ADMIN'), async (req, res) => {
  try {
    await prisma.school.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, 'delete school failed');
    res.status(400).json({ error: 'Cannot delete school with active associations. Remove devices and routes first.' });
  }
});

// ─── Devices ──────────────────────────────────────────────
app.get('/api/devices', authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'), async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const search = req.query.search || '';
    const where = {};
    if (search) where.OR = [{ licensePlate: { contains: search } }, { deviceId: { contains: search } }];
    if (req.user.role === 'SCHOOL_ADMIN') {
      where.schoolId = req.user.schoolId;
    } else {
      if (req.query.schoolId !== undefined) where.schoolId = req.query.schoolId === 'null' ? null : req.query.schoolId;
      // Unassigned devices are platform inventory, so listing them is a SUPER_ADMIN
      // question. This line used to sit OUTSIDE the role branch and overwrite the
      // scoping above it, so `?assigned=false` handed any school admin every
      // unassigned device on the platform with its IMEI — the only confirmed
      // cross-tenant read in the system. Read-only, since the update path re-checks
      // ownership and an unassigned device fails that check, but a leak nonetheless.
      //
      // The super-admin console's Assign Device picker is the caller, and it was
      // relying on its own client-side filter to make this safe. Scoping is not a
      // client's job.
      if (req.query.assigned === 'false') where.schoolId = null;
    }
    if (req.query.status) where.status = req.query.status;
    const [devices, total] = await Promise.all([
      prisma.bus.findMany({ where, include: { school: { select: { name: true } } }, skip: (page - 1) * limit, take: limit, orderBy: { licensePlate: 'asc' } }),
      prisma.bus.count({ where }),
    ]);
    // Never return deviceSecret over the wire
    const scrubbed = devices.map(({ deviceSecret, ...rest }) => rest);
    res.json({ data: scrubbed, total, page, limit });
  } catch (err) {
    req.log.error({ err }, 'list devices failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/devices/locations', async (req, res) => {
  try {
    let where = {};
    if (req.user.role === 'SUPER_ADMIN') {
      if (req.query.schoolId) where.schoolId = req.query.schoolId;
    } else if (req.user.role === 'SCHOOL_ADMIN') {
      where.schoolId = req.user.schoolId;
    } else if (req.user.role === 'DRIVER') {
      const activeTrips = await prisma.trip.findMany({
        where: { driverId: req.user.id, status: { in: ['PLANNED', 'ON_SCHEDULE', 'DELAYED'] } },
        select: { busId: true },
      });
      const busIds = activeTrips.map((t) => t.busId);
      where.id = { in: busIds };
    } else if (req.user.role === 'PARENT') {
      const children = await prisma.student.findMany({
        where: { parentId: req.user.id },
        include: {
          routeMappings: {
            include: {
              routeStop: {
                include: {
                  route: {
                    include: {
                      trips: {
                        where: { status: { in: ['PLANNED', 'ON_SCHEDULE', 'DELAYED'] } },
                        select: { busId: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });
      const busIds = new Set();
      for (const child of children) {
        for (const rm of child.routeMappings || []) {
          for (const trip of rm.routeStop?.route?.trips || []) {
            if (trip.busId) busIds.add(trip.busId);
          }
        }
      }
      where.id = { in: Array.from(busIds) };
    } else {
      return res.status(403).json({ error: 'Forbidden: unrecognized role' });
    }

    const buses = await prisma.bus.findMany({
      where,
      include: {
        gpsLogs: { orderBy: { timestamp: 'desc' }, take: 1 },
        school: { select: { name: true } },
        // Who is driving it right now, so a dashboard can actually place the call its
        // "Contact driver" button offers. Running trips only, most recently started
        // first — an unordered take(1) hands back an arbitrary leg on a two-leg day.
        trips: {
          where: { status: { in: ['ON_SCHEDULE', 'DELAYED'] } },
          orderBy: [{ startTime: { sort: 'desc', nulls: 'last' } }, { createdAt: 'asc' }],
          take: 1,
          select: { id: true, driver: { select: { name: true, phone: true } } },
        },
      },
    });
    const locations = buses
      .map((b) => ({
        // Both names for the same value. /api/schools/:schoolId/buses spreads the row
        // and so keys on `id`, this endpoint mapped explicitly and keyed on `busId`,
        // and a client joining the two lists gets undefined on every lookup with no
        // error to explain it. Renaming would break live readers; carrying both costs
        // nothing and means neither spelling is wrong.
        id: b.id,
        busId: b.id,
        licensePlate: b.licensePlate,
        schoolName: b.school?.name || 'Unassigned',
        tripId: b.trips[0]?.id || null,
        driverName: b.trips[0]?.driver?.name || null,
        // null means nobody to call — render the control disabled rather than
        // offering an action that silently does nothing.
        driverPhone: b.trips[0]?.driver?.phone || null,
        lastKnownLat: b.gpsLogs[0]?.lat || null,
        lastKnownLng: b.gpsLogs[0]?.lng || null,
        speed: b.gpsLogs[0]?.speed || 0,
        lastUpdate: b.gpsLogs[0]?.timestamp || null,
      }))
      .filter((b) => b.lastKnownLat !== null);
    res.json(locations);
  } catch (err) {
    req.log.error({ err }, 'list locations failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});


app.get('/api/devices/summary', authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'), async (req, res) => {
  try {
    const where = req.user.role === 'SCHOOL_ADMIN' ? { schoolId: req.user.schoolId } : {};
    const staleTime = new Date(Date.now() - 30 * 60 * 1000);
    const [total, online, offline, staleOver30m] = await Promise.all([
      prisma.bus.count({ where }),
      prisma.bus.count({ where: { ...where, status: 'ONLINE' } }),
      prisma.bus.count({ where: { ...where, status: 'OFFLINE' } }),
      prisma.bus.count({ where: { ...where, updatedAt: { lt: staleTime } } })
    ]);
    res.json({ total, online, offline, staleOver30m });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/devices/:id', authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'), async (req, res) => {
  try {
    const device = await prisma.bus.findUnique({
      where: { id: req.params.id },
      include: { school: { select: { name: true } } },
    });
    if (!device) return res.status(404).json({ error: 'Device not found' });
    if (req.user.role === 'SCHOOL_ADMIN' && device.schoolId !== req.user.schoolId) return res.status(403).json({ error: 'Forbidden' });
    const { deviceSecret, ...rest } = device;
    res.json(rest);
  } catch (err) {
    req.log.error({ err }, 'get device failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/devices', authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'), validate({ body: S.createDevice }), async (req, res) => {
  if (req.user.role === 'SCHOOL_ADMIN') req.body.schoolId = req.user.schoolId;
  try {
    const { deviceId, licensePlate, capacity, schoolId } = req.body;
    // Auto-generate device secret for HMAC
    const deviceSecret = crypto.randomBytes(32).toString('hex');
    const device = await prisma.bus.create({
      data: { deviceId, licensePlate, capacity: capacity || 40, schoolId: schoolId || null, deviceSecret },
    });
    emitToSchool(io, device.schoolId, 'device_status_change', { deviceId: device.id, status: 'ONLINE', message: 'New device provisioned' });
    // Return the secret ONCE on creation so ops can flash it to the device
    res.json({ ...device, deviceSecret });
  } catch (err) {
    if (err.code === 'P2002') {
      const field = err.meta?.target?.includes('licensePlate') ? 'License plate' : 'Device ID';
      return res.status(400).json({ error: `${field} is already registered` });
    }
    req.log.error({ err }, 'create device failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/devices/:id', authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'), validate({ body: S.updateDevice }), async (req, res) => {
  try {
    if (req.user.role === 'SCHOOL_ADMIN') {
      const existing = await prisma.bus.findUnique({ where: { id: req.params.id } });
      if (!existing || existing.schoolId !== req.user.schoolId) return res.status(403).json({ error: 'Forbidden' });
      req.body.schoolId = req.user.schoolId;
    }
    const { deviceSecret, ...safeBody } = req.body || {};
    const device = await prisma.bus.update({ where: { id: req.params.id }, data: safeBody });
    // Report the status the device actually has — an edit is not a presence signal,
    // and hardcoding ONLINE here lit up buses that were not reporting at all.
    emitToSchool(io, device.schoolId, 'device_status_change', { deviceId: device.id, status: device.status, message: 'Device updated' });
    const { deviceSecret: _s, ...rest } = device;
    res.json(rest);
  } catch (err) {
    req.log.error({ err }, 'update device failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/devices/:id/rotate-secret', authorizeRoles('SUPER_ADMIN'), async (req, res) => {
  try {
    const deviceSecret = crypto.randomBytes(32).toString('hex');
    const device = await prisma.bus.update({ where: { id: req.params.id }, data: { deviceSecret } });
    res.json({ deviceId: device.id, deviceSecret });
  } catch (err) {
    req.log.error({ err }, 'rotate device secret failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/devices/:id', authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'), async (req, res) => {
  try {
    if (req.user.role === 'SCHOOL_ADMIN') {
      const existing = await prisma.bus.findUnique({ where: { id: req.params.id } });
      if (!existing || existing.schoolId !== req.user.schoolId) return res.status(403).json({ error: 'Forbidden' });
    }
    // Refuse if a recurring run depends on it, and name them.
    //
    // Nothing about deleting a bus touches a run, so a run that has worked for six
    // weeks would silently stop producing trips and the first signal would be a stop
    // full of children. The materialiser now warns the school when that happens, but
    // catching it at the moment of the deletion is better than telling them after.
    const dependentRuns = await runsDependingOn({ busId: req.params.id });
    if (dependentRuns.length > 0) {
      return res.status(409).json({
        error: 'This bus is assigned to a recurring run',
        runs: dependentRuns,
        hint: 'Assign another bus to these runs first, or deactivate them.',
      });
    }

    await prisma.bus.delete({ where: { id: req.params.id } });
    emitToSchool(io, null, 'device_status_change', { deviceId: req.params.id, status: 'OFFLINE', message: 'Device decommissioned' });
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, 'delete device failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Admin (super-admin) endpoints ────────────────────────
app.get('/api/admin/logs', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const { busId, schoolId, startDate } = req.query;
    const where = {};
    if (busId) where.busId = busId;
    if (schoolId) where.bus = { schoolId };
    if (startDate) where.timestamp = { gte: new Date(startDate) };
    // SCHOOL_ADMIN sees only their own school
    if (req.user.role === 'SCHOOL_ADMIN') where.bus = { schoolId: req.user.schoolId };
    const [logs, total] = await Promise.all([
      prisma.gpsLog.findMany({ where, orderBy: { timestamp: 'desc' }, skip: (page - 1) * limit, take: limit, include: { bus: { select: { licensePlate: true } } } }),
      prisma.gpsLog.count({ where }),
    ]);
    res.json({ data: logs, total, page, limit });
  } catch (err) {
    req.log.error({ err }, 'list logs failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin management
app.get('/api/admins', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const { role, schoolId } = req.query;
    const where = { role: { in: ['SUPER_ADMIN', 'SCHOOL_ADMIN'] } };
    if (role) where.role = role;
    if (schoolId) where.schoolId = schoolId;
    const [admins, total] = await Promise.all([
      prisma.user.findMany({ where, select: { id: true, name: true, email: true, role: true, schoolId: true, createdAt: true }, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: 'desc' } }),
      prisma.user.count({ where }),
    ]);
    res.json({ data: admins, total, page, limit });
  } catch (err) {
    req.log.error({ err }, 'list admins failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/admins/:id', async (req, res) => {
  try {
    const admin = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true, email: true, role: true, schoolId: true, createdAt: true },
    });
    if (!admin) return res.status(404).json({ error: 'Admin not found' });
    res.json(admin);
  } catch (err) {
    req.log.error({ err }, 'get admin failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admins', validate({ body: S.createAdmin }), async (req, res) => {
  try {
    const { name, email, password, role, schoolId } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    const admin = await prisma.user.create({
      // The super admin chose this password, so the new admin sets their own at first
      // sign-in (the school dashboard asks).
      data: { name, email, password: hashed, role, schoolId, mustResetPassword: true },
      select: { id: true, name: true, email: true, role: true, schoolId: true },
    });
    res.json(admin);
  } catch (err) {
    if (err.code === 'P2002' && err.meta?.target?.includes('email')) {
      return res.status(400).json({ error: 'Email already in use' });
    }
    req.log.error({ err }, 'create admin failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/admins/:id', validate({ body: S.updateAdmin }), async (req, res) => {
  try {
    // Self-elevation guard: role/schoolId changes require SUPER_ADMIN AND are not self-modifications
    // that grant more power than the caller has.
    if (req.body.role || req.body.schoolId !== undefined) {
      if (req.user.role !== 'SUPER_ADMIN') {
        return res.status(403).json({ error: 'Only SUPER_ADMIN may change role or school assignment' });
      }
      if (req.params.id === req.user.id && req.body.role && req.body.role !== req.user.role) {
        return res.status(403).json({ error: 'Cannot change your own role' });
      }
    }
    const data = { ...req.body };
    if (data.password) {
      data.password = await bcrypt.hash(data.password, 10);
      // Someone else chose it: the admin replaces it at next sign-in.
      if (req.params.id !== req.user.id) data.mustResetPassword = true;
    }
    const admin = await prisma.user.update({
      where: { id: req.params.id },
      data,
      select: { id: true, name: true, email: true, role: true, schoolId: true },
    });
    // Role / school / password change → revoke that user's existing tokens (stale claims).
    if (req.body.role || req.body.schoolId !== undefined || req.body.password) {
      invalidateUser(req.params.id);
    }
    res.json(admin);
  } catch (err) {
    if (err.code === 'P2002' && err.meta?.target?.includes('email')) {
      return res.status(400).json({ error: 'Email already in use' });
    }
    req.log.error({ err }, 'update admin failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/admins/:id', async (req, res) => {
  try {
    if (req.params.id === req.user.id) return res.status(403).json({ error: 'Cannot delete yourself' });
    await prisma.user.delete({ where: { id: req.params.id } });
    // Revoke the deleted user's outstanding tokens so they cannot keep acting for up to 24h.
    invalidateUser(req.params.id);
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, 'delete admin failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// The opening password for a newly provisioned PARENT account.
//
// PARENT_DEFAULT_PASSWORD set: every parent gets that same string, which is what makes
// a 300-family import one line on a notice instead of 300 slips. Unset: a unique
// readable password per parent, returned once by the endpoint that created it.
//
// Parents only. Drivers and admins keep unique passwords — a driver account can start
// and end trips, and an admin account can read the whole school.
function parentOpeningPassword() {
  return config.PARENT_DEFAULT_PASSWORD || generateTempPassword();
}

// Readable alphabet: no O/0/I/1, so a temp password can be read out over a phone
// without spelling it letter by letter, and typed off a printed slip without a support
// call. Every account this server provisions uses it — driver creation, student import,
// and the reset flow below. A 32-character hex string is unusable on paper, and an
// onboarding credential nobody can transcribe is the reason people ask for one shared
// password instead.
//
// Declared below its callers but hoisted, so it is reachable from all of them.
const TEMP_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
function generateTempPassword(length = 12) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += TEMP_PASSWORD_ALPHABET[bytes[i] % TEMP_PASSWORD_ALPHABET.length];
  return out;
}

app.get('/api/password-reset-requests',
  authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'),
  async (req, res) => {
    try {
      const status = req.query.status ? String(req.query.status).toUpperCase() : 'PENDING';
      const where = { status };
      if (req.user.role === 'SCHOOL_ADMIN') {
        where.schoolId = req.user.schoolId;
        where.user = { role: { in: SCHOOL_RESETTABLE_ROLES } };
      } else if (req.query.schoolId) where.schoolId = req.query.schoolId;

      const requests = await prisma.passwordResetRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(parseInt(req.query.limit) || 50, 200),
        include: { user: { select: { id: true, name: true, email: true, role: true, phone: true } } },
      });
      res.json(requests);
    } catch (err) {
      req.log.error({ err }, 'list password reset requests failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// Approving mints a temp password and returns it ONCE: it is never stored in
// readable form and cannot be fetched again.
app.post('/api/password-reset-requests/:id/approve',
  authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'),
  async (req, res) => {
    try {
      const request = await prisma.passwordResetRequest.findUnique({
        where: { id: req.params.id },
        include: { user: { select: { id: true, name: true, email: true, schoolId: true, role: true } } },
      });
      if (!request) return res.status(404).json({ error: 'Request not found' });
      if (req.user.role === 'SCHOOL_ADMIN' && request.schoolId !== req.user.schoolId) {
        return res.status(403).json({ error: 'Forbidden: cross-tenant' });
      }
      if (req.user.role === 'SCHOOL_ADMIN' && !schoolCanReset(request.user.role)) {
        return res.status(403).json({ error: "Only a super admin can reset an administrator's password" });
      }
      if (request.status !== 'PENDING') {
        return res.status(400).json({ error: `Request is already ${request.status}` });
      }

      const tempPassword = generateTempPassword();
      const hashed = await bcrypt.hash(tempPassword, 10);
      await prisma.$transaction([
        prisma.user.update({
          where: { id: request.userId },
          data: { password: hashed, mustResetPassword: true },
        }),
        prisma.passwordResetRequest.update({
          where: { id: request.id },
          data: { status: 'APPROVED', resolvedBy: req.user.id, resolvedAt: new Date() },
        }),
      ]);
      // Whoever was signed in as this user is signed out: the password just changed.
      invalidateUser(request.userId);

      req.log.info({ requestId: request.id, by: req.user.id }, 'password reset approved');
      res.json({
        success: true,
        user: { id: request.user.id, name: request.user.name, email: request.user.email },
        tempPassword,
        note: 'Share this with the user directly. It is shown once and they must change it at next sign-in.',
      });
    } catch (err) {
      req.log.error({ err }, 'approve password reset failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

app.post('/api/password-reset-requests/:id/reject',
  authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'),
  async (req, res) => {
    try {
      const request = await prisma.passwordResetRequest.findUnique({
        where: { id: req.params.id },
        include: { user: { select: { role: true } } },
      });
      if (!request) return res.status(404).json({ error: 'Request not found' });
      if (req.user.role === 'SCHOOL_ADMIN' && request.schoolId !== req.user.schoolId) {
        return res.status(403).json({ error: 'Forbidden: cross-tenant' });
      }
      if (req.user.role === 'SCHOOL_ADMIN' && !schoolCanReset(request.user?.role)) {
        return res.status(403).json({ error: "Only a super admin can reset an administrator's password" });
      }
      if (request.status !== 'PENDING') {
        return res.status(400).json({ error: `Request is already ${request.status}` });
      }
      const updated = await prisma.passwordResetRequest.update({
        where: { id: request.id },
        data: { status: 'REJECTED', resolvedBy: req.user.id, resolvedAt: new Date() },
      });
      res.json(updated);
    } catch (err) {
      req.log.error({ err }, 'reject password reset failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── Settings ─────────────────────────────────────────────
app.get('/api/settings', async (_req, res) => {
  try {
    let settings = await prisma.globalSettings.findUnique({ where: { id: 'global' } });
    if (!settings) settings = await prisma.globalSettings.create({ data: { id: 'global' } });
    // alertEmail and offlineAlertMinutes were saveable for months with nothing behind
    // them, so an operator configured "email me when a device goes silent", was told
    // it saved, and was covered by nothing. The console can now grey those fields and
    // say why, instead of accepting input it cannot honour.
    res.json({ ...settings, ...channelStatus() });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Same rule as fcm-token, on the mail side: alertEmail has been saveable for months
// with no mail sender behind it, so an operator configured "email me when a device
// goes silent", was told it saved, and was covered by nothing. Settings now report
// whether the channels they configure can actually deliver.
function channelStatus() {
  return { pushEnabled: isPushConfigured(), emailEnabled: mailer.isConfigured() };
}

app.put('/api/settings', validate({ body: S.globalSettings }), async (req, res) => {
  try {
    const settings = await prisma.globalSettings.upsert({
      where: { id: 'global' },
      update: req.body,
      create: { id: 'global', ...req.body },
    });
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Global search ────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ results: [], schools: [], devices: [], admins: [] });
    const { role, schoolId } = req.user;

    if (role === 'SCHOOL_ADMIN' && schoolId) {
      const [students, drivers, buses, routes] = await Promise.all([
        prisma.student.findMany({ where: { schoolId, name: { contains: q } }, include: { routeMappings: { orderBy: { createdAt: 'asc' }, include: { routeStop: { include: { route: true } } } } }, take: 10 }),
        // select, not include: `include` pulls the whole User row — password hash and
        // all — into memory. Nothing leaks today because the response below is built
        // field by field, but that is one careless `res.json(drivers)` away from being
        // a credential dump, and the next person to touch this will not know that.
        prisma.user.findMany({ where: { schoolId, role: 'DRIVER', name: { contains: q } }, select: { id: true, name: true, driverTrips: { include: { bus: { select: { id: true, licensePlate: true } } } } }, take: 10 }),
        prisma.bus.findMany({ where: { schoolId, licensePlate: { contains: q } }, take: 10 }),
        prisma.route.findMany({ where: { schoolId, name: { contains: q } }, take: 10 }),
      ]);
      const results = [];
      students.forEach((s) => results.push({ id: s.id, type: 'student', name: s.name, detail: `Grade: ${s.grade || 'N/A'} | ${s.routeMappings[0]?.routeStop?.route?.name || 'Unassigned Route'}` }));
      drivers.forEach((d) => results.push({ id: d.id, type: 'driver', name: d.name, detail: d.driverTrips[0] ? `Assigned to Bus: ${d.driverTrips[0].bus?.licensePlate}` : 'Idle / Unassigned' }));
      buses.forEach((b) => results.push({ id: b.id, type: 'bus', name: b.licensePlate, detail: `Capacity: ${b.capacity} | Device: ${b.deviceId}` }));
      routes.forEach((r) => results.push({ id: r.id, type: 'route', name: r.name, detail: `Est Duration: ${r.estimatedDuration || 0} mins` }));
      return res.json({ results });
    }

    if (role === 'SUPER_ADMIN') {
      const [schools, devices, admins] = await Promise.all([
        prisma.school.findMany({ where: { OR: [{ name: { contains: q } }, { city: { contains: q } }, { state: { contains: q } }] }, take: 20 }),
        prisma.bus.findMany({ where: { OR: [{ licensePlate: { contains: q } }, { deviceId: { contains: q } }] }, take: 20, select: { id: true, licensePlate: true, deviceId: true, capacity: true, schoolId: true, createdAt: true, updatedAt: true } }),
        prisma.user.findMany({ where: { role: { in: ['SUPER_ADMIN', 'SCHOOL_ADMIN'] }, OR: [{ name: { contains: q } }, { email: { contains: q } }] }, select: { id: true, name: true, email: true, role: true }, take: 20 }),
      ]);
      return res.json({ schools, devices, admins, results: [] });
    }

    return res.status(403).json({ error: 'Forbidden' });
  } catch (err) {
    req.log.error({ err }, 'search failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Notifications ────────────────────────────────────────
// Every alert used to be titled "Emergency SOS", including admin broadcasts.
const ALERT_TITLES = {
  DRIVER_SOS: 'Emergency SOS',
  HARDWARE_SOS: 'Hardware SOS',
  ADMIN_BROADCAST: 'Broadcast',
  DELAY: 'Delay alert',
};

app.get('/api/notifications', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 200);
    const { id: userId, role, schoolId } = req.user;

    if (role === 'SUPER_ADMIN' || (role === 'SCHOOL_ADMIN' && schoolId)) {
      // An SOS writes an EmergencyAlert row, never a Notification row, so a
      // SCHOOL_ADMIN polling this endpoint used to see nothing at all — alerts were
      // visible to SUPER_ADMIN only. Scope them to the admin's own school.
      const alertWhere = role === 'SCHOOL_ADMIN' ? { schoolId } : {};
      const realAlerts = await prisma.emergencyAlert.findMany({ where: alertWhere, orderBy: { createdAt: 'desc' }, take: limit });
      const formatted = realAlerts.map((a) => ({
        id: a.id, type: a.type || 'DRIVER_SOS', title: ALERT_TITLES[a.type] || 'Emergency SOS',
        message: a.message || 'Driver triggered SOS alert',
        status: a.status, isRead: a.status === 'RESOLVED', createdAt: a.createdAt,
      }));

      const newestFirst = (a, b) => new Date(b.createdAt) - new Date(a.createdAt);
      if (role === 'SCHOOL_ADMIN') {
        // School admins also receive ordinary per-user notifications; show one list.
        const own = await prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: limit });
        return res.json([...formatted, ...own].sort(newestFirst).slice(0, limit));
      }
      if (config.ENABLE_MOCK_DATA) {
        const sim = getSimulatedAlerts();
        return res.json([...formatted, ...sim].sort(newestFirst).slice(0, limit));
      }
      return res.json(formatted);
    }

    let notifications = await prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: limit });
    if (notifications.length === 0 && config.ENABLE_MOCK_DATA) {
      notifications = getMockNotifications(userId);
    }
    res.json(notifications);
  } catch (err) {
    req.log.error({ err }, 'list notifications failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/notifications/mark-read', async (req, res) => {
  try {
    await prisma.notification.updateMany({ where: { userId: req.user.id }, data: { isRead: true } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/notifications/:id/read', async (req, res) => {
  try {
    const { id } = req.params;
    if (id.startsWith('mock-') || id.startsWith('sys-')) return res.json({ success: true, id, isRead: true });
    const notif = await prisma.notification.findUnique({ where: { id } });
    if (!notif) return res.status(404).json({ error: 'Notification not found' });
    if (notif.userId !== req.user.id && req.user.role !== 'SUPER_ADMIN') return res.status(403).json({ error: 'Forbidden' });
    const updated = await prisma.notification.update({ where: { id }, data: { isRead: true } });
    res.json({ success: true, id: updated.id, isRead: updated.isRead });
  } catch (err) {
    req.log.error({ err }, 'mark read failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/notifications/:id/resolve', authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'), async (req, res) => {
  try {
    const { id } = req.params;
    if (id.startsWith('sys-') || id.startsWith('mock-')) return res.json({ success: true, id, status: 'RESOLVED' });
    const alert = await prisma.emergencyAlert.findUnique({ where: { id } });
    if (!alert) return res.status(404).json({ error: 'Alert not found' });
    if (req.user.role === 'SCHOOL_ADMIN' && alert.schoolId !== req.user.schoolId) return res.status(403).json({ error: 'Forbidden' });
    const updated = await prisma.emergencyAlert.update({ where: { id }, data: { status: 'RESOLVED' } });
    res.json({ success: true, id: updated.id, status: updated.status });
  } catch (err) {
    req.log.error({ err }, 'resolve alert failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});
// Global 404 Handler
app.use((req, res, next) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Global Error Handler
app.use((err, req, res, next) => {
  // `req.log` only exists once pino-http has run, and cors + express.json sit ahead
  // of it — a rejected origin or a malformed body reached this handler with no
  // logger attached, so it threw here and buried the real error.
  const log = req?.log || logger;
  log.error({ err }, 'Unhandled application error');

  if (res.headersSent) return next(err);

  // Both of these are the caller's mistake, not a server fault. Returning 500 for
  // them sent frontends hunting for a backend bug that was not there.
  if (err?.message?.startsWith('CORS origin not allowed')) {
    return res.status(403).json({ error: err.message });
  }
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Malformed JSON body' });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }

  res.status(500).json({ error: 'Internal server error' });
});

// pushToUsers is exported for its tests; nothing outside server.js calls it.
module.exports = { app, server, io, prisma, pushToUsers };
