const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    trip: { findMany: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const { app, prisma } = require('../server');
const SECRET = process.env.JWT_SECRET;

describe('GET /api/driver/telemetry-credentials', () => {
  beforeEach(() => jest.clearAllMocks());

  const driverToken = () => jwt.sign({ id: 'd1', role: 'DRIVER', schoolId: 's1' }, SECRET);

  it('should return 401 without a token', async () => {
    const res = await request(app).get('/api/driver/telemetry-credentials');
    expect(res.status).toBe(401);
  });

  it('should return 403 for a non-driver', async () => {
    const admin = jwt.sign({ id: 'a1', role: 'SCHOOL_ADMIN', schoolId: 's1' }, SECRET);
    const res = await request(app)
      .get('/api/driver/telemetry-credentials')
      .set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(403);
  });

  it('should return 404 when the driver has no active trip/device', async () => {
    prisma.trip.findMany.mockResolvedValue([]);
    const res = await request(app)
      .get('/api/driver/telemetry-credentials')
      .set('Authorization', `Bearer ${driverToken()}`);
    expect(res.status).toBe(404);
  });

  it('should return deviceId + deviceSecret for the driver active-trip bus', async () => {
    prisma.trip.findMany.mockResolvedValue([{
      id: 't1',
      status: 'ON_SCHEDULE',
      bus: { deviceId: 'IMEI-123', deviceSecret: 'sekret' },
    }]);
    const res = await request(app)
      .get('/api/driver/telemetry-credentials')
      .set('Authorization', `Bearer ${driverToken()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deviceId: 'IMEI-123', deviceSecret: 'sekret' });
    // Scoped to the calling driver and only active trips.
    expect(prisma.trip.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { driverId: 'd1', status: { in: ['PLANNED', 'ON_SCHEDULE', 'DELAYED'] } },
    }));
  });

  const credsFor = async (trips) => {
    prisma.trip.findMany.mockResolvedValue(trips);
    const res = await request(app)
      .get('/api/driver/telemetry-credentials')
      .set('Authorization', `Bearer ${driverToken()}`);
    expect(res.status).toBe(200);
    return res.body.deviceId;
  };
  const trip = (id, status, bus, extra = {}) => ({
    id, status, bus: { deviceId: bus, deviceSecret: `secret-${bus}` }, ...extra,
  });

  it('signs for the trip being driven, not an older one that was never started', async () => {
    // The bug: a skipped morning run on bus A was created first, so the phone signed as
    // bus A while the driver drove bus B. Bus A moved on the map; bus B vanished.
    const skippedMorning = trip('morning', 'PLANNED', 'BUS-A', {
      createdAt: '2026-09-19T00:00:00Z', scheduledStart: '2026-09-22T01:30:00Z',
    });
    const runningAfternoon = trip('afternoon', 'ON_SCHEDULE', 'BUS-B', {
      createdAt: '2026-09-20T00:00:00Z', startTime: '2026-09-22T09:00:00Z',
    });
    expect(await credsFor([skippedMorning, runningAfternoon])).toBe('BUS-B');
  });

  it('treats a DELAYED trip as running', async () => {
    expect(await credsFor([
      trip('old', 'PLANNED', 'BUS-A', { createdAt: '2026-09-01T00:00:00Z' }),
      trip('late', 'DELAYED', 'BUS-B', { createdAt: '2026-09-20T00:00:00Z' }),
    ])).toBe('BUS-B');
  });

  it('with nothing running, takes the trip due soonest rather than the oldest created', async () => {
    expect(await credsFor([
      trip('tomorrow', 'PLANNED', 'BUS-A', { createdAt: '2026-09-01T00:00:00Z', scheduledStart: '2026-09-23T01:30:00Z' }),
      trip('today', 'PLANNED', 'BUS-B', { createdAt: '2026-09-20T00:00:00Z', scheduledStart: '2026-09-22T09:00:00Z' }),
    ])).toBe('BUS-B');
  });

  it('puts unscheduled trips after scheduled ones, oldest first among themselves', async () => {
    expect(await credsFor([
      trip('adhoc-new', 'PLANNED', 'BUS-C', { createdAt: '2026-09-21T00:00:00Z' }),
      trip('scheduled', 'PLANNED', 'BUS-B', { createdAt: '2026-09-21T06:00:00Z', scheduledStart: '2026-09-22T09:00:00Z' }),
      trip('adhoc-old', 'PLANNED', 'BUS-A', { createdAt: '2026-09-20T00:00:00Z' }),
    ])).toBe('BUS-B');
    expect(await credsFor([
      trip('adhoc-new', 'PLANNED', 'BUS-C', { createdAt: '2026-09-21T00:00:00Z' }),
      trip('adhoc-old', 'PLANNED', 'BUS-A', { createdAt: '2026-09-20T00:00:00Z' }),
    ])).toBe('BUS-A');
  });
});
