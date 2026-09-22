// The driver app files a timed walk-around before every trip. There was no route and no
// table for it, so each one was a 404 the app swallowed and nothing was ever kept.

const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    trip: { findUnique: jest.fn() },
    preTripCheck: { upsert: jest.fn(), findUnique: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const { app, prisma } = require('../server');

const SECRET = process.env.JWT_SECRET;
const bearer = (claims) => `Bearer ${jwt.sign(claims, SECRET)}`;
const DRIVER = bearer({ id: 'driver-1', role: 'DRIVER', schoolId: 's1' });
const OTHER_DRIVER = bearer({ id: 'driver-2', role: 'DRIVER', schoolId: 's1' });
const ADMIN = bearer({ id: 'admin-1', role: 'SCHOOL_ADMIN', schoolId: 's1' });
const OTHER_ADMIN = bearer({ id: 'admin-2', role: 'SCHOOL_ADMIN', schoolId: 's2' });
const PARENT = bearer({ id: 'parent-1', role: 'PARENT', schoolId: 's1' });

const IDS = ['tyres', 'brakes', 'lights', 'mirrors', 'firstaid', 'doors'];
const items = (ids = IDS) => ids.map((id, i) => ({ id, ok: true, checkedAt: `2026-09-22T06:5${i}:00.000Z` }));

// ownsTrip reads the trip with its route; the handler reads status and any existing check.
const givenTrip = ({ status = 'PLANNED', existing = null } = {}) => {
  prisma.trip.findUnique.mockImplementation(async ({ include }) =>
    include
      ? { id: 'trip-1', driverId: 'driver-1', status, route: { schoolId: 's1' } }
      : { status, preTripCheck: existing }
  );
};

const file = (auth, body) =>
  request(app).post('/api/trips/trip-1/pre-trip-check').set('Authorization', auth).send(body);

beforeEach(() => {
  jest.clearAllMocks();
  prisma.preTripCheck.upsert.mockImplementation(async ({ create }) => ({ id: 'check-1', ...create }));
});

describe('POST /api/trips/:tripId/pre-trip-check', () => {
  it("keeps the driver's walk-around for the trip", async () => {
    givenTrip();

    const res = await file(DRIVER, { items: items(), note: '  Left mirror loose, tightened  ' });

    expect(res.status).toBe(200);
    expect(prisma.preTripCheck.upsert).toHaveBeenCalledTimes(1);
    const { where, create, update } = prisma.preTripCheck.upsert.mock.calls[0][0];
    expect(where).toEqual({ tripId: 'trip-1' });
    expect(create).toEqual({
      tripId: 'trip-1',
      driverId: 'driver-1',
      items: items(),
      note: 'Left mirror loose, tightened',
      submittedAt: expect.any(Date),
    });
    expect(update).toEqual({
      driverId: 'driver-1',
      items: items(),
      note: 'Left mirror loose, tightened',
      submittedAt: expect.any(Date),
    });
    expect(res.body.items).toHaveLength(6);
  });

  it('accepts exactly what the driver app sends today (no note)', async () => {
    givenTrip();

    const res = await file(DRIVER, { items: items() });

    expect(res.status).toBe(200);
    expect(prisma.preTripCheck.upsert.mock.calls[0][0].create.note).toBeNull();
  });

  it('replaces an earlier walk-around while the trip has not left', async () => {
    givenTrip({ status: 'PLANNED', existing: { id: 'check-0' } });

    expect((await file(DRIVER, { items: items() })).status).toBe(200);
    expect(prisma.preTripCheck.upsert).toHaveBeenCalled();
  });

  it('keeps the one filed before departure once the trip is running', async () => {
    givenTrip({ status: 'ON_SCHEDULE', existing: { id: 'check-0' } });

    const res = await file(DRIVER, { items: items() });

    expect(res.status).toBe(409);
    expect(prisma.preTripCheck.upsert).not.toHaveBeenCalled();
  });

  it('still keeps a late one if none was filed before departure', async () => {
    givenTrip({ status: 'DELAYED' });

    expect((await file(DRIVER, { items: items() })).status).toBe(200);
  });

  it.each(['COMPLETED', 'CANCELLED'])('refuses one for a %s trip', async (status) => {
    givenTrip({ status });

    const res = await file(DRIVER, { items: items() });

    expect(res.status).toBe(409);
    expect(prisma.preTripCheck.upsert).not.toHaveBeenCalled();
  });

  it("refuses another driver's trip", async () => {
    givenTrip();

    expect((await file(OTHER_DRIVER, { items: items() })).status).toBe(403);
    expect(prisma.preTripCheck.upsert).not.toHaveBeenCalled();
  });

  it('refuses the school: it is the driver who walked round the bus', async () => {
    givenTrip();

    expect((await file(ADMIN, { items: items() })).status).toBe(403);
    expect(prisma.preTripCheck.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing check', { items: items(IDS.slice(1)) }],
    ['a check twice', { items: items(['tyres', 'tyres', 'lights', 'mirrors', 'firstaid', 'doors']) }],
    ['an unknown check', { items: items(['tyres', 'brakes', 'lights', 'mirrors', 'firstaid', 'wipers']) }],
    ['an untimed check', { items: items().map((i, n) => (n === 0 ? { ...i, checkedAt: 'this morning' } : i)) }],
    ['no items at all', {}],
  ])('rejects %s', async (_label, body) => {
    givenTrip();

    expect((await file(DRIVER, body)).status).toBe(400);
    expect(prisma.preTripCheck.upsert).not.toHaveBeenCalled();
  });
});

describe('GET /api/trips/:tripId/pre-trip-check', () => {
  const read = (auth) => request(app).get('/api/trips/trip-1/pre-trip-check').set('Authorization', auth);
  const record = { id: 'check-1', tripId: 'trip-1', driverId: 'driver-1', items: items(), note: null };

  it("shows the school the driver's walk-around", async () => {
    givenTrip();
    prisma.preTripCheck.findUnique.mockResolvedValue(record);

    const res = await read(ADMIN);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ tripId: 'trip-1', driverId: 'driver-1' });
    expect(prisma.preTripCheck.findUnique).toHaveBeenCalledWith({ where: { tripId: 'trip-1' } });
  });

  it('says so when none was filed', async () => {
    givenTrip();
    prisma.preTripCheck.findUnique.mockResolvedValue(null);

    expect((await read(ADMIN)).status).toBe(404);
  });

  it.each([
    ['another school', OTHER_ADMIN],
    ['a parent', PARENT],
  ])('is not shown to %s', async (_label, auth) => {
    givenTrip();
    prisma.preTripCheck.findUnique.mockResolvedValue(record);

    expect((await read(auth)).status).toBe(403);
    expect(prisma.preTripCheck.findUnique).not.toHaveBeenCalled();
  });
});
