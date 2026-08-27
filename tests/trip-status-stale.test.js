const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    trip: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const { app, prisma } = require('../server');
const SECRET = process.env.JWT_SECRET;
const HOUR = 3600 * 1000;

// SUPER_ADMIN so ownsTrip short-circuits and we exercise only the conflict logic.
const token = () => jwt.sign({ id: '1', role: 'SUPER_ADMIN' }, SECRET);

const start = () =>
  request(app)
    .patch('/api/trips/trip-new/status')
    .set('Authorization', `Bearer ${token()}`)
    .send({ status: 'ON_SCHEDULE' });

describe('PATCH /api/trips/:tripId/status — stale trip lockout', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.trip.findUnique.mockResolvedValue({
      id: 'trip-new', busId: 'bus-1', driverId: 'd1', scheduledStart: null,
    });
    prisma.trip.update.mockResolvedValue({
      id: 'trip-new', status: 'ON_SCHEDULE', route: { schoolId: 's1', name: 'R' },
    });
  });

  it('still blocks when the conflicting trip is genuinely running', async () => {
    prisma.trip.findFirst.mockResolvedValue({
      id: 'trip-live', startTime: new Date(Date.now() - 1 * HOUR), createdAt: new Date(),
    });

    const res = await start();

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/active trip/i);
    expect(prisma.trip.update).not.toHaveBeenCalled();
  });

  // The lockout: nothing else ever sets COMPLETED, so an abandoned trip blocked this
  // bus and driver from every future trip, permanently.
  it('auto-completes an abandoned trip and lets the new one start', async () => {
    const startedAt = new Date(Date.now() - 13 * HOUR);
    prisma.trip.findFirst.mockResolvedValue({ id: 'trip-zombie', startTime: startedAt, createdAt: startedAt });

    const res = await start();

    expect(res.status).toBe(200);

    const completed = prisma.trip.update.mock.calls.find((c) => c[0].where.id === 'trip-zombie');
    expect(completed).toBeDefined();
    expect(completed[0].data.status).toBe('COMPLETED');
    expect(completed[0].data.endTime).toBeInstanceOf(Date);

    // and the trip the driver actually asked for did start
    expect(prisma.trip.update.mock.calls.some((c) => c[0].where.id === 'trip-new')).toBe(true);
  });

  it('falls back to createdAt when the abandoned trip never recorded a startTime', async () => {
    prisma.trip.findFirst.mockResolvedValue({
      id: 'trip-zombie', startTime: null, createdAt: new Date(Date.now() - 20 * HOUR),
    });

    expect((await start()).status).toBe(200);
    expect(prisma.trip.update.mock.calls.some((c) => c[0].where.id === 'trip-zombie')).toBe(true);
  });

  it('does not touch anything when there is no conflict at all', async () => {
    prisma.trip.findFirst.mockResolvedValue(null);

    expect((await start()).status).toBe(200);
    expect(prisma.trip.update).toHaveBeenCalledTimes(1);
    expect(prisma.trip.update.mock.calls[0][0].where.id).toBe('trip-new');
  });
});

// The create path routes through the same guard. Fixing only the start path would
// have left a zombie trip still blocking new trips for that bus and driver.
describe('POST /api/schools/:schoolId/trips — same stale guard', () => {
  const U = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
  const body = { routeId: U(1), busId: U(2), driverId: U(3) };

  const create = () =>
    request(app)
      .post('/api/schools/school-1/trips')
      .set('Authorization', `Bearer ${token()}`)
      .send(body);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.route = { findUnique: jest.fn().mockResolvedValue({ id: U(1), schoolId: 'school-1' }) };
    prisma.bus = { findUnique: jest.fn().mockResolvedValue({ id: U(2), schoolId: 'school-1' }) };
    prisma.user = { findUnique: jest.fn().mockResolvedValue({ id: U(3), role: 'DRIVER', schoolId: 'school-1' }) };
    prisma.trip.create.mockResolvedValue({ id: 'trip-new', route: { schoolId: 'school-1', name: 'R' } });
  });

  it('still refuses when the blocking trip is genuinely running', async () => {
    prisma.trip.findFirst.mockResolvedValue({
      id: 'trip-live', startTime: new Date(Date.now() - 1 * HOUR), createdAt: new Date(),
    });

    const res = await create();

    expect(res.status).toBe(400);
    expect(prisma.trip.create).not.toHaveBeenCalled();
  });

  it('clears an abandoned trip and creates the new one', async () => {
    const startedAt = new Date(Date.now() - 13 * HOUR);
    prisma.trip.findFirst.mockResolvedValue({ id: 'trip-zombie', startTime: startedAt, createdAt: startedAt });

    const res = await create();

    expect(res.status).toBe(200);
    const closed = prisma.trip.update.mock.calls.find((c) => c[0].where.id === 'trip-zombie');
    expect(closed[0].data.status).toBe('COMPLETED');
    expect(prisma.trip.create).toHaveBeenCalled();
  });
});
