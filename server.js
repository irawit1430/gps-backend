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

app.get('/healthz', (_req, res) => res.status(200).json({ status: 'ok' }));

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
      { expiresIn: config.JWT_EX_IN || config.JWT_EXPIRES_IN || '24h' }
    );

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
    // A password change ends all existing sessions for this user (including this one).
    // The client must log in again with the new password.
    invalidateUser(user.id);
    logoutToken(req.token);
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    req.log.error({ err }, 'change password failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Logout — revoke the presented token so it can no longer be used.
app.post('/api/auth/logout', authenticate, (req, res) => {
  logoutToken(req.token);
  res.json({ message: 'Logged out' });
});

// Telemetry (HMAC-authenticated, not JWT). Bus is looked up by the HMAC middleware
// and attached as req.bus.
const telemetryCache = require('./telemetryCache');
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
              where: { status: 'ON_SCHEDULE' },
              include: { driver: { select: { name: true } }, route: { select: { name: true } } },
            },
          },
        }));
        if (bus) telemetryCache.set(deviceId, bus);
      }
      if (!bus) return res.status(404).json({ error: 'Bus not found' });

      const activeTrip = bus.trips?.[0];
      const log = await prisma.gpsLog.create({
        data: { busId: bus.id, tripId: activeTrip?.id || null, lat, lng, speed: speed || 0, timestamp: timestamp ? new Date(timestamp) : new Date() },
      });

      const now = Date.now();
      const lastStatusWrite = bus.lastStatusWrite || 0;
      if (bus.status !== 'ONLINE' || now - lastStatusWrite > 5 * 60 * 1000) {
        await prisma.bus.update({
          where: { id: bus.id },
          data: { status: 'ONLINE' },
        });
        bus.status = 'ONLINE';
        bus.lastStatusWrite = now;
        telemetryCache.set(deviceId, bus);
      }

      syncGpsLogToFirebase({
        busId: bus.id,
        licensePlate: bus.licensePlate,
        lat,
        lng,
        speed: speed || 0,
        timestamp: log.timestamp,
      });

      emitToSchool(io, bus.schoolId, 'location_update', {
        busId: bus.id,
        licensePlate: bus.licensePlate,
        capacity: bus.capacity,
        driverName: activeTrip?.driver?.name || 'Unassigned',
        routeName: activeTrip?.route?.name || 'Off-Route',
        lat,
        lng,
        speed,
        timestamp: log.timestamp,
      });

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
        return { ...b, driverName: t?.driver?.name || 'Unassigned', routeName: t?.route?.name || 'Off-Route', isAvailable };
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
        id: true, name: true, email: true, role: true, photoUrl: true,
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
    delete updated.password;
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, 'update parent failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/schools/:schoolId/drivers', requireTenant('schoolId'), async (req, res) => {
  try {
    const drivers = await prisma.user.findMany({
      where: { schoolId: req.params.schoolId, role: 'DRIVER' },
      select: {
        id: true, name: true, email: true, role: true, photoUrl: true,
        notificationSettings: true, schoolId: true, createdAt: true, updatedAt: true,
        driverTrips: {
          where: { status: { in: ['PLANNED', 'ON_SCHEDULE', 'DELAYED'] } },
          include: { bus: true, route: true },
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
      const { name, email } = req.body;
      const tempPassword = crypto.randomBytes(16).toString('hex');
      const hashed = await bcrypt.hash(tempPassword, 10);
      const driver = await prisma.user.create({
        data: { schoolId: req.params.schoolId, name, email, password: hashed, role: 'DRIVER', mustResetPassword: true },
      });
      res.json({ driver: { id: driver.id, name: driver.name, email: driver.email }, tempPassword });
    } catch (err) {
      req.log.error({ err }, 'create driver failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// Trips
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
      
      const activeTrips = await prisma.trip.findMany({
        where: {
          OR: [{ busId: req.body.busId }, { driverId: req.body.driverId }],
          status: { in: ['PLANNED', 'ON_SCHEDULE', 'DELAYED'] },
        }
      });
      if (activeTrips.length > 0) return res.status(400).json({ error: 'Bus or Driver is already assigned to an active trip' });
      const trip = await prisma.trip.create({
        data: { routeId: req.body.routeId, busId: req.body.busId, driverId: req.body.driverId, status: 'PLANNED' },
      });
      res.json(trip);
    } catch (err) {
      req.log.error({ err }, 'create trip failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// Students & attendance

app.put('/api/trips/:tripId',
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
            status: { in: ['PLANNED', 'ON_SCHEDULE', 'DELAYED'] },
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
          ...(routeId && { routeId })
        }
      });
      res.json(updated);
    } catch (err) {
      req.log.error({ err }, 'update trip failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

app.get('/api/schools/:schoolId/students', requireTenant('schoolId'), async (req, res) => {
  try {
    const students = await prisma.student.findMany({
      where: { schoolId: req.params.schoolId },
      include: { routeMappings: { include: { routeStop: { include: { route: true } } } } },
    });
    res.json(
      students.map((s) => {
        const m = s.routeMappings[0];
        return {
          id: s.id,
          rfidTag: s.rfidTag,
          name: s.name,
          grade: s.grade,
          photoUrl: s.photoUrl,
          assignedRoute: m?.routeStop?.route?.name || 'Unassigned',
          routeStopName: m?.routeStop?.name || 'Unassigned',
          boardingStatus: 'Absent',
          lastCheckIn: '--:--',
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

    let { rfidTag, name, grade, parentEmail, parentName } = req.body;
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
        data: { schoolId, rfidTag, name, grade: grade || 'General', parentId },
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
      // Tenant check: the student and route stop must belong to caller's school
      if (req.user.role === 'SCHOOL_ADMIN') {
        const [student, stop] = await Promise.all([
          prisma.student.findUnique({ where: { id: studentId }, select: { schoolId: true } }),
          prisma.routeStop.findUnique({ where: { id: routeStopId }, include: { route: { select: { schoolId: true } } } }),
        ]);
        if (!student || student.schoolId !== req.user.schoolId) return res.status(403).json({ error: 'Forbidden' });
        if (!stop || stop.route.schoolId !== req.user.schoolId) return res.status(403).json({ error: 'Forbidden' });
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
      prisma.trip.count({ where: { route: { schoolId }, status: 'ON_SCHEDULE' } }),
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

app.get('/api/parents/:parentId/students',
  requireSelfOrRoles('parentId', 'SUPER_ADMIN', 'SCHOOL_ADMIN'),
  async (req, res) => {
    try {
      const students = await prisma.student.findMany({
        where: { parentId: req.params.parentId },
        include: {
          routeMappings: {
            include: {
              routeStop: {
                include: {
                  route: {
                    include: {
                      trips: {
                        where: { status: { in: ['PLANNED', 'ON_SCHEDULE', 'DELAYED'] } },
                        include: {
                          driver: { select: { name: true } },
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
      const formatted = students.map((s) => {
        const t = s.routeMappings[0]?.routeStop?.route?.trips[0] || null;
        return {
          id: s.id,
          name: s.name,
          grade: s.grade,
          photoUrl: s.photoUrl,
          routeStopName: s.routeMappings[0]?.routeStop?.name || 'Unassigned',
          driverName: t?.driver?.name || 'Unassigned',
          licensePlate: t?.bus?.licensePlate || 'Unassigned',
        };
      });
      res.json(formatted);
    } catch (err) {
      req.log.error({ err }, 'list parent students failed');
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
        type: 'DRIVER_SOS',
        message: message || 'Driver triggered SOS',
        tripId: tripId || null,
        status: 'ACTIVE',
      },
    });
    syncEmergencyAlertToFirebase(alert);
    emitToSchool(io, alert.schoolId, 'emergency_alert', alert);
    res.json(alert);
  } catch (err) {
    req.log.error({ err }, 'sos failed');
    res.status(500).json({ error: 'Internal server error' });
  }
}
app.post('/api/alerts/sos', validate({ body: S.sos }), sosHandler);
app.post('/api/driver/emergency', validate({ body: S.sos }), sosHandler); // doc-parity alias

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
    delete updated.password;
    res.json(updated);
  } catch (err) {
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
      const trips = await prisma.trip.findMany({
        where: { driverId: req.params.driverId, status: { in: ['PLANNED', 'ON_SCHEDULE', 'DELAYED'] } },
        include: {
          route: {
            include: {
              stops: {
                orderBy: { orderIdx: 'asc' },
                include: { studentMappings: { include: { student: true } } },
              },
            },
          },
          bus: true,
          attendanceLogs: true,
        },
        orderBy: { createdAt: 'asc' },
      });
      res.json(trips);
    } catch (err) {
      req.log.error({ err }, 'list driver trips failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

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
    const data = { status: req.body.status };
    if (req.body.status === 'ON_SCHEDULE') data.startTime = new Date();
    if (req.body.status === 'COMPLETED') data.endTime = new Date();
    const trip = await prisma.trip.update({ where: { id: req.params.tripId }, data });
    res.json(trip);
  } catch (err) {
    req.log.error({ err }, 'update trip failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

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

    const student = await prisma.student.findUnique({ 
      where: { id: req.body.studentId },
      include: { parent: { select: { id: true, notificationSettings: true } } }
    });
    if (!student) return res.status(404).json({ error: 'Student not found' });
    if (student.schoolId !== trip.route.schoolId) return res.status(400).json({ error: 'Student not on this trip route' });

    const log = await prisma.attendanceLog.create({
      data: { studentId: req.body.studentId, tripId: req.body.tripId, type: req.body.type },
    });
    
    if (student.parentId) {
      const typeEnum = req.body.type === 'BOARDED' ? 'BOARDING' : 'ARRIVAL';
      const title = `Student ${req.body.type}`;
      const message = `${student.name} has been marked ${req.body.type}.`;
      
      const notif = await prisma.notification.create({
        data: { userId: student.parentId, title, message, type: typeEnum }
      });
      
      emitToUser(io, student.parentId, 'notification', notif);
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
    prisma.gpsLog.findMany({ where: { bus: { schoolId }, timestamp: { gte: fifteenMinsAgo } }, distinct: ['busId'], select: { busId: true } }),
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
    prisma.gpsLog.findMany({ where: { timestamp: { gte: fifteenMinsAgo } }, distinct: ['busId'], select: { busId: true } }),
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
    
    let orderBy = { createdAt: 'desc' };
    if (req.query.sort) orderBy = { [req.query.sort]: req.query.order === 'asc' ? 'asc' : 'desc' };
    
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
      include: { gpsLogs: { orderBy: { timestamp: 'desc' }, take: 1 }, school: { select: { name: true } } },
    });
    const locations = buses
      .map((b) => ({
        busId: b.id,
        licensePlate: b.licensePlate,
        schoolName: b.school?.name || 'Unassigned',
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
    req.log.error({ err }, 'create device failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/devices/:id', authorizeRoles('SUPER_ADMIN', 'SCHOOL_ADMIN'), validate({ body: S.updateDevice }), async (req, res) => {
  const device = await prisma.bus.findUnique({ where: { id: req.params.id } });
  if (req.user.role === 'SCHOOL_ADMIN' && (!device || device.schoolId !== req.user.schoolId)) return res.status(403).json({ error: 'Forbidden' });
  if (req.user.role === 'SCHOOL_ADMIN') req.body.schoolId = req.user.schoolId;
  try {
    const { deviceSecret, ...safeBody } = req.body || {};
    const device = await prisma.bus.update({ where: { id: req.params.id }, data: safeBody });
    emitToSchool(io, device.schoolId, 'device_status_change', { deviceId: device.id, status: 'ONLINE', message: 'Device updated' });
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
  const device = await prisma.bus.findUnique({ where: { id: req.params.id } });
  if (req.user.role === 'SCHOOL_ADMIN' && (!device || device.schoolId !== req.user.schoolId)) return res.status(403).json({ error: 'Forbidden' });
  try {
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

// ─── Settings ─────────────────────────────────────────────
app.get('/api/settings', async (_req, res) => {
  try {
    let settings = await prisma.globalSettings.findUnique({ where: { id: 'global' } });
    if (!settings) settings = await prisma.globalSettings.create({ data: { id: 'global' } });
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

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
        prisma.user.findMany({ where: { schoolId, role: 'DRIVER', name: { contains: q } }, include: { driverTrips: { include: { bus: true } } }, take: 10 }),
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
app.get('/api/notifications', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 200);
    const { id: userId, role } = req.user;

    if (role === 'SUPER_ADMIN') {
      const realAlerts = await prisma.emergencyAlert.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
      const formatted = realAlerts.map((a) => ({
        id: a.id, type: 'DRIVER_SOS', title: 'Emergency SOS',
        message: a.message || 'Driver triggered SOS alert',
        status: a.status, isRead: a.status === 'RESOLVED', createdAt: a.createdAt,
      }));
      if (config.ENABLE_MOCK_DATA) {
        const sim = getSimulatedAlerts();
        return res.json([...formatted, ...sim].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, limit));
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
  req.log.error({ err }, 'Unhandled application error');
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = { app, server, io, prisma };
