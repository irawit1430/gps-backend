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

const config = require('./config');
const logger = require('./logger');
const S = require('./schemas');
const { validate } = require('./middleware/validate');
const { authenticate, authorizeRoles, requireTenant, requireSelfOrRoles, logoutToken, invalidateUser } = require('./middleware/auth');
const { telemetryHmac } = require('./middleware/telemetryHmac');
const { attachSocketAuth, emitToSchool, emitToUser } = require('./middleware/socketAuth');
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
app.use(globalLimiter);

// ─── Public routes (health, login, telemetry) ──────────────
app.get('/', (_req, res) => res.send('Fleet API is running perfectly!'));

// Reports the running process's own clock, not the machine's and not what any
// config file claims. Every "today" boundary in this service is server-local, so a
// timezone that was set in .env — where dotenv assigns process.env.TZ long after Node
// has already fixed its timezone — reads as configured and does nothing. This makes
// that difference visible without shell access.
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

// Login (rate-limited, unauthenticated)
const DUMMY_HASH = '$2a$10$e8wWwFkWyVb0f4pL7pTDe.a9B6gZ7rV5rY6f8rG8g8g8g8g8g8g8g';
app.post('/api/auth/login', loginLimiter, validate({ body: S.login }), async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      await bcrypt.compare(password, DUMMY_HASH);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    const token = jwt.sign(
      { id: user.id, role: user.role, schoolId: user.schoolId },
      config.JWT_SECRET,
      { expiresIn: config.JWT_EXPIRES_IN || '24h' }
    );

    // DEPRECATED: shipping the long-lived HMAC deviceSecret in every login response
    // is a security smell. Clients should migrate to GET /api/driver/telemetry-credentials
    // (fetched only when phone-GPS is needed). These fields will be removed once the
    // driver app has switched over.
    let deviceId, deviceSecret;
    if (user.role === 'DRIVER') {
      const activeTrip = await prisma.trip.findFirst({
        where: { driverId: user.id, status: { in: ['PLANNED', 'ON_SCHEDULE', 'DELAYED'] } },
        include: { bus: true }
      });
      if (activeTrip && activeTrip.bus) {
        deviceId = activeTrip.bus.deviceId;
        deviceSecret = activeTrip.bus.deviceSecret;
      }
    }

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
      deviceId,
      deviceSecret,
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
    // when the account belongs to no school.
    const admins = await prisma.user.findMany({
      where: user.schoolId
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

        emitToSchool(io, bus.schoolId, 'location_update', {
          // location_update is POSITION ONLY, and both ingest paths must agree on that.
          //
          // This event goes to the whole school room, so every parent receives every
          // bus in their school. driverName and routeName used to ride along, which
          // meant every parent held every driver name on their device — and only for
          // phone-GPS buses, because the TM-100 path never sent them. So the fields
          // were present in testing, absent in production, and a privacy leak in
          // between. Identity now comes from GET /api/devices/locations.
          busId: bus.id,
          licensePlate: bus.licensePlate,
          capacity: bus.capacity,
          lat,
          lng,
          speed,
          timestamp: fixAt,
        });
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

// Broad RBAC prefixes
app.use('/api/admin', authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'));
app.use('/api/admins', authorizeRoles('SUPER_ADMIN'));
app.use('/api/settings', authorizeRoles('SUPER_ADMIN'));

// ─── Tenant-scoped: /api/schools/:schoolId/* ──────────────
app.get('/api/schools/:schoolId/buses', requireTenant('schoolId'), async (req, res) => {
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

app.get('/api/schools/:schoolId/leaves', requireTenant('schoolId'), async (req, res) => {
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

app.delete('/api/leaves/:id', authorizeRoles('PARENT', 'SUPER_ADMIN', 'SCHOOL_ADMIN'), async (req, res) => {
  try {
    const leave = await prisma.leaveApplication.findUnique({
      where: { id: req.params.id },
      include: { student: true }
    });
    if (!leave) return res.status(404).json({ error: 'Leave not found' });
    
    // Authorization check
    if (req.user.role === 'PARENT' && leave.student.parentId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden: not your student' });
    }
    if (req.user.role === 'SCHOOL_ADMIN' && leave.student.schoolId !== req.user.schoolId) {
      return res.status(403).json({ error: 'Forbidden: cross-tenant access denied' });
    }
    
    // Only pending leaves can be deleted
    if (leave.status !== 'PENDING') {
      return res.status(400).json({ error: 'Only PENDING leaves can be deleted' });
    }
    
    await prisma.leaveApplication.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, 'delete leave failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Doc-parity alias: /api/schools/:schoolId/leaves/pending
app.get('/api/schools/:schoolId/leaves/pending', requireTenant('schoolId'), async (req, res) => {
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

app.put('/api/leaves/:id/approve', authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'), ownsLeave, async (req, res) => {
  try {
    const leave = await prisma.leaveApplication.update({ where: { id: req.params.id }, data: { status: 'APPROVED' } });
    res.json(leave);
  } catch (err) {
    req.log.error({ err }, 'approve leave failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/leaves/:id/reject', authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'), ownsLeave, async (req, res) => {
  try {
    const leave = await prisma.leaveApplication.update({ where: { id: req.params.id }, data: { status: 'REJECTED' } });
    res.json(leave);
  } catch (err) {
    req.log.error({ err }, 'reject leave failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

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
app.get('/api/schools/:schoolId/routes', requireTenant('schoolId'), async (req, res) => {
  try {
    // ?summary=1 for the screens that only need names.
    //
    // The full shape ships every route's OSRM polyline and every one of its stops. A
    // 12-route school with 40 stops each is a dozen encoded polylines and ~480 stop
    // rows — sent to populate a dropdown. The map editor genuinely needs all of it;
    // Overview and the students page do not, and they call this on every load.
    //
    // Opt-in rather than a new default so the editor keeps working unchanged.
    if (req.query.summary) {
      const routes = await prisma.route.findMany({
        where: { schoolId: req.params.schoolId },
        select: {
          id: true,
          name: true,
          distanceKm: true,
          estimatedDuration: true,
          _count: { select: { stops: true } },
        },
        orderBy: { name: 'asc' },
      });
      return res.json(
        routes.map(({ _count, ...r }) => ({ ...r, stopCount: _count.stops }))
      );
    }

    const routes = await prisma.route.findMany({
      where: { schoolId: req.params.schoolId },
      include: { stops: { orderBy: { orderIdx: 'asc' } }, trips: { take: 1, orderBy: { createdAt: 'desc' } } },
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
    const activeTrips = await prisma.trip.count({
      where: { routeId: req.params.id, status: { in: ['PLANNED', 'ON_SCHEDULE', 'DELAYED'] } },
    });
    if (activeTrips > 0) {
      return res.status(400).json({
        error: `Cannot delete route: ${activeTrips} active trip(s) still assigned. Complete or cancel them first.`,
      });
    }
    await prisma.route.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
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
      res.json({ success: true });
    } catch (err) {
      req.log.error({ err }, 'delete stop failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// Drivers
app.get('/api/schools/:schoolId/parents', requireTenant('schoolId'), async (req, res) => {
  try {
    const parents = await prisma.user.findMany({
      where: { schoolId: req.params.schoolId, role: 'PARENT' },
      select: {
        id: true, name: true, email: true, phone: true, role: true, photoUrl: true,
        createdAt: true, updatedAt: true,
        parentStudents: {
          include: { routeMappings: { include: { routeStop: { include: { route: true } } } } }
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

app.get('/api/schools/:schoolId/drivers', requireTenant('schoolId'), async (req, res) => {
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
      const tempPassword = crypto.randomBytes(16).toString('hex');
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
        },
        include: { route: { select: { schoolId: true, name: true } } },
      });
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

app.get('/api/schools/:schoolId/students', requireTenant('schoolId'), async (req, res) => {
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
          include: { routeStop: { select: { name: true, route: { select: { name: true } } } } },
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
        if (!parent) {
          generatedPassword = crypto.randomBytes(16).toString('hex');
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
        data: { schoolId, rfidTag, name, grade: grade || 'General', guardianPhone: guardianPhone || null, parentId },
      });
      return { student, generatedPassword };
    });

    res.json({
      student: result.student,
      parentCredentials: result.generatedPassword
        ? { email: parentEmail, temporaryPassword: result.generatedPassword }
        : null,
    });
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(400).json({ error: 'RFID Tag is already assigned to another student.' });
    }
    req.log.error({ err }, 'create student failed');
    res.status(500).json({ error: 'Internal server error' });
  }
}

app.post('/api/schools/:schoolId/students', requireTenant('schoolId'), validate({ body: S.createStudent }), studentCreateHandler);
app.post('/api/schools/:schoolId/broadcast', requireTenant('schoolId'), authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'), validate({ body: S.broadcast }), async (req, res) => {
  try {
    // NOTE: EmergencyAlert has no routeId column — only tripId. Passing routeId
    // would throw. senderId records who broadcast it.
    const alert = await prisma.emergencyAlert.create({
      data: {
        schoolId: req.params.schoolId,
        senderId: req.user.id,
        type: 'ADMIN_BROADCAST',
        message: req.body.message,
        tripId: req.body.tripId || null,
      }
    });
    
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
    }

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
          type: notifType
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

    // Still broadcast to the general school room for the admin dashboards
    if (io) emitToSchool(io, req.params.schoolId, 'emergency_alert', alert);

    // recipientCount lets the sending dashboard show "sent to N people" instead of
    // guessing whether anyone was actually targeted.
    res.json({ ...alert, audience, recipientCount: recipients.length });
  } catch (err) {
    req.log.error({ err }, 'broadcast failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/schools/:schoolId/students/bulk', requireTenant('schoolId'), authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'), validate({ body: S.bulkStudents }), async (req, res) => {
  try {
    const students = req.body;
    let createdCount = 0;
    // Temp passwords for parents provisioned by this import, returned once so the
    // admin can hand them out. Never reuse a fixed password here — every account
    // created with a shared literal is a free login for anyone who reads this file.
    const parentCredentials = [];

    // Process in transaction
    await prisma.$transaction(async (tx) => {
      for (const st of students) {
        let parent = null;
        if (st.parentEmail) {
          const existing = await tx.user.findUnique({ where: { email: st.parentEmail } });
          if (existing) {
            parent = existing;
          } else {
            const tempPassword = crypto.randomBytes(16).toString('hex');
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
        await tx.student.create({
          data: {
            schoolId: req.params.schoolId,
            rfidTag: st.rfidTag,
            name: st.name,
            grade: st.grade,
            guardianPhone: st.guardianPhone || null,
            parentId: parent ? parent.id : null,
          }
        });
        createdCount++;
      }
    });
    res.json({ success: true, message: `Created ${createdCount} students successfully.`, parentCredentials });
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(400).json({ error: 'Import aborted: an RFID tag or parent email in this batch is already in use.' });
    }
    req.log.error({ err }, 'bulk student import failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/students', validate({ body: S.createStudent }), studentCreateHandler);

app.put('/api/students/:id', authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'), validate({ body: S.updateStudent }), async (req, res) => {
  try {
    const student = await prisma.student.findUnique({ where: { id: req.params.id } });
    if (!student) return res.status(404).json({ error: 'Student not found' });
    if (req.user.role === 'SCHOOL_ADMIN' && student.schoolId !== req.user.schoolId) return res.status(403).json({ error: 'Forbidden' });
    
    const updated = await prisma.student.update({
      where: { id: req.params.id },
      data: req.body
    });
    res.json(updated);
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(400).json({ error: 'RFID Tag is already assigned to another student.' });
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
    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, 'delete mapping failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/student-route-mappings',
  authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'),
  validate({ body: S.mapping }),
  async (req, res) => {
    try {
      const { studentId, routeStopId } = req.body;
      const stop = await prisma.routeStop.findUnique({
        where: { id: routeStopId },
        select: { routeId: true, route: { select: { schoolId: true } } },
      });

      // Tenant check: the student and route stop must belong to caller's school
      if (req.user.role === 'SCHOOL_ADMIN') {
        const student = await prisma.student.findUnique({ where: { id: studentId }, select: { schoolId: true } });
        if (!student || student.schoolId !== req.user.schoolId) return res.status(403).json({ error: 'Forbidden' });
        // 403 and not 404 on a missing stop: a school admin must not be able to probe
        // which stop ids exist outside their own school.
        if (!stop || stop.route.schoolId !== req.user.schoolId) return res.status(403).json({ error: 'Forbidden' });
      } else if (!stop) {
        return res.status(404).json({ error: 'Route stop not found' });
      }

      // One stop per student per route. The @@unique is (studentId, routeStopId), which
      // only makes re-assigning the SAME stop idempotent — a second stop on the same
      // route slips past it and the student then appears twice on the driver roster.
      const elsewhere = await prisma.studentRouteMapping.findFirst({
        where: { studentId, routeStopId: { not: routeStopId }, routeStop: { routeId: stop.routeId } },
        select: { routeStop: { select: { id: true, name: true } } },
      });
      if (elsewhere) {
        return res.status(409).json({
          error: 'Student is already assigned to another stop on this route',
          stopId: elsewhere.routeStop.id,
          stopName: elsewhere.routeStop.name,
        });
      }
      const mapping = await prisma.studentRouteMapping.upsert({
        where: { studentId_routeStopId: { studentId, routeStopId } },
        update: {},
        create: { studentId, routeStopId },
        include: { student: true, routeStop: { include: { route: true } } },
      });
      res.json(mapping);
    } catch (err) {
      req.log.error({ err }, 'create mapping failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

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

app.get('/api/schools/:schoolId/attendance/today', requireTenant('schoolId'), async (req, res) => {
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
app.get('/api/schools/:schoolId/stats', requireTenant('schoolId'), async (req, res) => {
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

// Arrival time for one stop: RouteStop.expectedArrivalMinutes anchored to the trip's
// actual startTime, or to its scheduledStart while the trip is still PLANNED.
function stopEta(trip, stop) {
  const offset = stop?.expectedArrivalMinutes;
  // Once the trip is moving its real startTime is the truth; before that, the planned
  // departure carries the schedule, which is what makes an ETA visible pre-departure.
  const anchor = trip?.startTime || trip?.scheduledStart;
  if (!anchor || offset === null || offset === undefined) {
    return { stopEtaAt: null, stopEtaMinutes: null, etaBasis: null };
  }
  const at = new Date(new Date(anchor).getTime() + offset * 60_000);
  return {
    stopEtaAt: at.toISOString(),
    stopEtaMinutes: Math.round((at.getTime() - Date.now()) / 60_000),
    etaBasis: trip.startTime ? 'ACTUAL_START' : 'SCHEDULED_START',
  };
}

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
// requireSelfOrRoles has already established they may act for this parent.
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

app.get('/api/parents/:parentId/students',
  requireSelfOrRoles('parentId', 'SUPER_ADMIN', 'SCHOOL_ADMIN'),
  async (req, res) => {
    try {
      const students = await prisma.student.findMany({
        where: { parentId: req.params.parentId },
        include: {
          school: { select: { phone: true, contactPhone: true } },
          routeMappings: {
            include: {
              routeStop: {
                include: {
                  route: {
                    include: {
                      trips: {
                        where: { status: { in: ['PLANNED', 'ON_SCHEDULE', 'DELAYED'] } },
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
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const endOfToday = new Date(startOfToday);
      endOfToday.setHours(23, 59, 59, 999);
      const childIds = students.map((s) => s.id);

      const [todaysLogs, todaysLeave] = await Promise.all([
        childIds.length
          ? prisma.attendanceLog.findMany({
              where: { studentId: { in: childIds }, timestamp: { gte: startOfToday } },
              orderBy: { timestamp: 'desc' },
              select: { studentId: true, type: true, timestamp: true, tripId: true, source: true },
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
              select: { studentId: true },
            })
          : [],
      ]);

      const latestScan = new Map();
      for (const l of todaysLogs) if (!latestScan.has(l.studentId)) latestScan.set(l.studentId, l);
      const onLeaveToday = new Set(todaysLeave.map((l) => l.studentId));

      const formatted = students.map((s) => {
        const stop = s.routeMappings[0]?.routeStop || null;
        const t = stop?.route?.trips[0] || null;
        const scan = latestScan.get(s.id) || null;
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
          // Where the CHILD is, as opposed to where the bus is. null status means no
          // scan today — genuinely unknown, and not the same as absent. The app must
          // render unknown as unknown; that distinction is the whole point.
          attendance: {
            status: scan?.type || null,
            at: scan?.timestamp?.toISOString() || null,
            tripId: scan?.tripId || null,
            source: scan?.source || null,
          },
          // Approved leave covering today. A child on leave who never boards is not a
          // no-show, and must not read as one on any screen.
          onLeave: onLeaveToday.has(s.id),
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
  requireSelfOrRoles('parentId', 'SUPER_ADMIN', 'SCHOOL_ADMIN'),
  async (req, res) => {
    try {
      const student = await loadParentStudent(req, res);
      if (!student) return;

      const mapping = await prisma.studentRouteMapping.findFirst({
        where: { studentId: student.id },
        include: { routeStop: { select: { id: true, routeId: true } } },
      });
      if (!mapping) return res.status(404).json({ error: 'Student is not mapped to a route stop' });

      const trip = await prisma.trip.findFirst({
        where: { routeId: mapping.routeStop.routeId, status: { in: ['PLANNED', 'ON_SCHEDULE', 'DELAYED'] } },
        include: {
          route: {
            include: {
              stops: {
                orderBy: { orderIdx: 'asc' },
                include: { studentMappings: { select: { studentId: true } } },
              },
            },
          },
          bus: { select: { id: true, licensePlate: true } },
          driver: { select: { name: true } },
        },
        orderBy: { createdAt: 'asc' },
      });
      if (!trip) return res.status(404).json({ error: 'No active trip on this route' });

      const logs = await prisma.attendanceLog.findMany({
        where: { tripId: trip.id },
        select: { studentId: true, type: true, timestamp: true },
      });

      const stops = trip.route.stops.map((stop) => {
        const stopStudentIds = new Set(stop.studentMappings.map((m) => m.studentId));
        const boardings = logs.filter((l) => l.type === 'BOARDED' && stopStudentIds.has(l.studentId));
        // No per-stop passage is recorded anywhere, so the first boarding at a stop is
        // the closest honest proxy for "the bus was here".
        const firstBoarding = boardings.reduce(
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
          passedAt: firstBoarding ? new Date(firstBoarding).toISOString() : null,
        };
      });

      res.json({
        id: trip.id,
        status: trip.status,
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
  requireSelfOrRoles('parentId', 'SUPER_ADMIN', 'SCHOOL_ADMIN'),
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
        prisma.studentRouteMapping.findFirst({
          where: { studentId: student.id },
          include: { routeStop: { select: { name: true } } },
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
  requireSelfOrRoles('parentId', 'SUPER_ADMIN', 'SCHOOL_ADMIN'),
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

app.post('/api/leaves', validate({ body: S.leaveApp }), async (req, res) => {
  try {
    // Parents can only create leaves for their own child; admins for any child in tenant
    const student = await prisma.student.findUnique({ where: { id: req.body.studentId } });
    if (!student) return res.status(404).json({ error: 'Student not found' });
    if (req.user.role === 'PARENT' && student.parentId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    if (req.user.role === 'SCHOOL_ADMIN' && student.schoolId !== req.user.schoolId) return res.status(403).json({ error: 'Forbidden' });
    if (!['PARENT', 'SCHOOL_ADMIN', 'SUPER_ADMIN'].includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });

    const leave = await prisma.leaveApplication.create({
      data: {
        studentId: req.body.studentId,
        startDate: new Date(req.body.startDate),
        endDate: new Date(req.body.endDate),
        reason: req.body.reason,
        notes: req.body.notes || null,
        status: 'PENDING',
      },
    });
    res.json(leave);
  } catch (err) {
    req.log.error({ err }, 'create leave failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/parents/:parentId/leaves',
  requireSelfOrRoles('parentId', 'SUPER_ADMIN', 'SCHOOL_ADMIN'),
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
    const isOwnSchool = Boolean(req.user.schoolId) && alert.schoolId === req.user.schoolId;
    const isSender = alert.senderId === req.user.id;
    if (!isSuper && !isOwnSchool && !isSender) return res.status(403).json({ error: 'Forbidden' });

    res.json({ ...alert, alertId: alert.id, acknowledged: alert.status !== 'ACTIVE' });
  } catch (err) {
    req.log.error({ err }, 'get alert failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/alerts/sos', validate({ body: S.sos }), sosHandler);
app.post('/api/driver/emergency', validate({ body: S.sos }), sosHandler); // doc-parity alias

// Phone-GPS telemetry credentials for the authenticated driver's assigned bus.
// Preferred over the (deprecated) login-response deviceSecret: fetch this only when
// starting phone-based tracking, so the HMAC secret is not shipped on every login.
// Returns the secret only to the DRIVER, only for their own active-trip bus.
app.get('/api/driver/telemetry-credentials', async (req, res) => {
  try {
    if (req.user.role !== 'DRIVER') return res.status(403).json({ error: 'Forbidden: drivers only' });
    const activeTrip = await prisma.trip.findFirst({
      where: { driverId: req.user.id, status: { in: ['PLANNED', 'ON_SCHEDULE', 'DELAYED'] } },
      include: { bus: { select: { deviceId: true, deviceSecret: true } } },
      orderBy: { createdAt: 'asc' },
    });
    if (!activeTrip || !activeTrip.bus) {
      return res.status(404).json({ error: 'No active trip with an assigned device' });
    }
    res.json({ deviceId: activeTrip.bus.deviceId, deviceSecret: activeTrip.bus.deviceSecret });
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
    const data = { ...req.body };
    if (data.password) {
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
    
    await prisma.user.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, 'delete driver failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/drivers/:driverId/trips',
  requireSelfOrRoles('driverId', 'SUPER_ADMIN', 'SCHOOL_ADMIN'),
  async (req, res) => {
    try {
      // This is the driver app's polling endpoint — by far the most requested one,
      // so every column it drags along is paid for on every poll. Keep the payload
      // to what docs/frontend/driver-app.md §2 actually documents.
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);

      const trips = await prisma.trip.findMany({
        where: { driverId: req.params.driverId, status: { in: ['PLANNED', 'ON_SCHEDULE', 'DELAYED'] } },
        include: {
          route: {
            include: {
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
            where: { timestamp: { gte: startOfToday } },
            select: { id: true, studentId: true, type: true, timestamp: true },
          },
        },
        orderBy: { createdAt: 'asc' },
      });

      // LeaveApplication hangs off Student, not Trip, so it cannot ride the include
      // above. One extra bounded query covers every student on every returned trip,
      // then fans out — the driver app reads `trip.leaveApplications` to grey out
      // kids who are not coming, so a stop is not held for them.
      const endOfToday = new Date(startOfToday);
      endOfToday.setHours(23, 59, 59, 999);

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
              startDate: { lte: endOfToday },
              endDate: { gte: startOfToday },
            },
            select: { id: true, studentId: true, status: true, startDate: true, endDate: true },
          })
        : [];

      // One entry per student, not one per leave row. A student can hold two APPROVED
      // leaves whose ranges both cover today, and a second entry for the same child is
      // meaningless to render — it only collides keys in the client.
      const leaveByStudent = new Map();
      for (const l of leaves) if (!leaveByStudent.has(l.studentId)) leaveByStudent.set(l.studentId, l);
      trips.forEach((t, i) => {
        t.leaveApplications = studentIdsByTrip[i].map((id) => leaveByStudent.get(id)).filter(Boolean);
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
    // Creation only blocks a *running* conflict, so two PLANNED trips may share a bus
    // or driver. The conflict has to be re-checked here, or both can be started and
    // the bus ends up on two live trips at once.
    if (req.body.status === 'ON_SCHEDULE' || req.body.status === 'DELAYED') {
      const trip = await prisma.trip.findUnique({ where: { id: req.params.tripId } });
      if (!trip) return res.status(404).json({ error: 'Trip not found' });
      const conflict = await prisma.trip.findFirst({
        where: {
          id: { not: req.params.tripId },
          OR: [{ busId: trip.busId }, { driverId: trip.driverId }],
          status: { in: ['ON_SCHEDULE', 'DELAYED'] },
        },
      });
      if (await stillBlocking(conflict, req.log)) {
        return res.status(400).json({ error: 'Bus or driver is already on an active trip' });
      }
    }

    const data = { status: req.body.status };
    if (req.body.status === 'ON_SCHEDULE') {
      data.startTime = new Date();
      // delayMinutes and currentEtaMessage were columns nothing ever wrote. With a
      // scheduledStart to compare against they finally mean something.
      const planned = await prisma.trip.findUnique({
        where: { id: req.params.tripId },
        select: { scheduledStart: true },
      });
      if (planned?.scheduledStart) {
        const late = Math.round((data.startTime - new Date(planned.scheduledStart)) / 60_000);
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
      where: { id: { in: ids }, fcmToken: { not: null } },
      select: { id: true, fcmToken: true },
    });
    if (users.length === 0) return;

    const { invalidTokens } = await sendPush(users.map((u) => u.fcmToken), payload);
    if (invalidTokens?.length) {
      // Uninstalled app / re-registered device: drop the token so it is not retried.
      await prisma.user.updateMany({
        where: { fcmToken: { in: invalidTokens } },
        data: { fcmToken: null },
      });
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
      include: { route: true },
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

    // A child on approved leave is not a no-show. Recording one would tell a family
    // their child failed to board on a day the school had already agreed they would
    // not — and because every planned absence would generate one, the alert becomes
    // noise inside a week and stops being read at all. That would destroy the only
    // notification in this product with a window in which a parent can still act.
    if (req.body.type === 'NO_SHOW') {
      const startOfDay = new Date(occurredAt);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(startOfDay);
      endOfDay.setHours(23, 59, 59, 999);

      const onLeave = await prisma.leaveApplication.findFirst({
        where: {
          studentId: req.body.studentId,
          status: 'APPROVED',
          startDate: { lte: endOfDay },
          endDate: { gte: startOfDay },
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
    // NOTE: this matches on the natural key, not on the key value itself — storing
    // keys needs a column, and prisma/schema.prisma is off-limits without the owner's
    // go-ahead. Two *genuinely* different scans of the same student, same trip, same
    // type inside 10 minutes therefore collapse into one.
    if (req.headers['idempotency-key']) {
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

    const log = await prisma.attendanceLog.create({
      data: {
        studentId: req.body.studentId,
        tripId: req.body.tripId,
        type: req.body.type,
        timestamp: occurredAt,
        source,
      },
    });

    if (student.parentId && source === 'SCAN') {
      const NOTIFY = {
        BOARDED: { type: 'BOARDING', title: 'Boarded the bus', body: (n) => `${n} is on board.` },
        ALIGHTED: { type: 'ARRIVAL', title: 'Off the bus', body: (n) => `${n} has been dropped off.` },
        // The one message in this product a parent can still act on, so it is worded
        // as the fact rather than as a status change, and never softened.
        NO_SHOW: { type: 'SOS', title: 'Did not board', body: (n) => `${n} was not at the stop and did not board.` },
      };
      const spec = NOTIFY[req.body.type] || NOTIFY.BOARDED;
      const typeEnum = spec.type;
      const title = spec.title;
      const message = spec.body(student.name);

      // The parent's toggles were being read and then ignored. `boarding` off means
      // no row and no push for check-in/drop-off; absent means on. A no-show is not a
      // routine boarding update and is not silenced by that toggle.
      if (req.body.type === 'NO_SHOW' || wantsNotification(student.parent?.notificationSettings, 'boarding')) {
        const notif = await prisma.notification.create({
          data: { userId: student.parentId, title, message, type: typeEnum }
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

app.get('/api/schools/:id', async (req, res) => {
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
    if (req.user.role === 'SCHOOL_ADMIN') where.schoolId = req.user.schoolId;
    else if (req.query.schoolId !== undefined) where.schoolId = req.query.schoolId === 'null' ? null : req.query.schoolId;
    if (req.query.assigned === 'false') where.schoolId = null;
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
      data: { name, email, password: hashed, role, schoolId },
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
    if (data.password) data.password = await bcrypt.hash(data.password, 10);
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

// -- Password reset requests (admin side of the forgot-password flow) --
// Readable alphabet: no O/0/I/1, so a temp password can be read out over a phone
// without spelling it letter by letter.
const TEMP_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
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
      if (req.user.role === 'SCHOOL_ADMIN') where.schoolId = req.user.schoolId;
      else if (req.query.schoolId) where.schoolId = req.query.schoolId;

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
        include: { user: { select: { id: true, name: true, email: true, schoolId: true } } },
      });
      if (!request) return res.status(404).json({ error: 'Request not found' });
      if (req.user.role === 'SCHOOL_ADMIN' && request.schoolId !== req.user.schoolId) {
        return res.status(403).json({ error: 'Forbidden: cross-tenant' });
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
      const request = await prisma.passwordResetRequest.findUnique({ where: { id: req.params.id } });
      if (!request) return res.status(404).json({ error: 'Request not found' });
      if (req.user.role === 'SCHOOL_ADMIN' && request.schoolId !== req.user.schoolId) {
        return res.status(403).json({ error: 'Forbidden: cross-tenant' });
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
        prisma.student.findMany({ where: { schoolId, name: { contains: q } }, include: { routeMappings: { include: { routeStop: { include: { route: true } } } } }, take: 10 }),
        prisma.user.findMany({ where: { schoolId, role: 'DRIVER', name: { contains: q } }, include: { driverTrips: { include: { bus: { select: { id: true, licensePlate: true } } } } }, take: 10 }),
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

module.exports = { app, server, io, prisma };
