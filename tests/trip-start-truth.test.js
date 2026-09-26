// A trip that started but never sent a position is running untracked: every parent on
// it sees an empty map. The school hears it from the driver's phone at once, or from
// the sweep a few minutes in, whichever notices first, and only once.

const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    trip: { findUnique: jest.fn(), findMany: jest.fn() },
    user: { findMany: jest.fn() },
    notification: { createMany: jest.fn() },
    gpsLog: { findFirst: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const { app, prisma } = require('../server');
const busPresence = require('../busPresence');
const { untrackedTrips, sweepUntrackedTrips } = require('../darkBuses');

const SECRET = process.env.JWT_SECRET;
const SCHOOL = 'school-1';
const TRIP = '55555555-5555-4555-8555-555555555555';
const driver = jwt.sign({ id: 'd1', role: 'DRIVER', schoolId: SCHOOL }, SECRET);
const otherDriver = jwt.sign({ id: 'd2', role: 'DRIVER', schoolId: SCHOOL }, SECRET);

const trip = (over = {}) => ({
  id: TRIP, driverId: 'd1', status: 'ON_SCHEDULE', startTime: new Date(Date.now() - 10 * 60_000),
  bus: { id: 'b1', licensePlate: 'BR01 1111', schoolId: SCHOOL },
  route: { name: 'Route 1', schoolId: SCHOOL },
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  busPresence.clear();
  prisma.user.findMany.mockResolvedValue([{ id: 'a1' }, { id: 'a2' }]);
  prisma.notification.createMany.mockResolvedValue({ count: 2 });
  prisma.gpsLog.findFirst.mockResolvedValue(null);
});

describe('POST /api/trips/:id/tracking-problem', () => {
  const report = (body, token = driver) =>
    request(app).post(`/api/trips/${TRIP}/tracking-problem`).set('Authorization', `Bearer ${token}`).send(body);

  it('tells every admin of the school, keyed so the sweep does not say it again', async () => {
    prisma.trip.findUnique.mockResolvedValue(trip());

    const res = await report({ reason: 'permission', message: 'Location denied' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ delivered: true, admins: 2 });
    const { data, skipDuplicates } = prisma.notification.createMany.mock.calls[0][0];
    expect(skipDuplicates).toBe(true);
    expect(data.map((n) => n.eventKey)).toEqual([`tracking-unverified:${TRIP}:a1`, `tracking-unverified:${TRIP}:a2`]);
    expect(data[0].message).toBe("BR01 1111 on Route 1 is running, but location permission is off on the driver's phone. Parents see no bus on the map. Call the driver.");
  });

  it('is only the trip\'s own driver\'s to send', async () => {
    prisma.trip.findUnique.mockResolvedValue(trip());
    const res = await report({ reason: 'transient' }, otherDriver);
    expect(res.status).toBe(403);
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });
});

describe('untrackedTrips', () => {
  it('finds a running trip with no position since it started', async () => {
    prisma.trip.findMany.mockResolvedValue([trip()]);
    expect((await untrackedTrips(prisma, { minutes: 3 })).map((t) => t.id)).toEqual([TRIP]);
    expect(prisma.trip.findMany.mock.calls[0][0].where.startTime.lt.getTime()).toBeLessThanOrEqual(Date.now() - 3 * 60_000);
  });

  it('leaves it alone once a fix has arrived since the start', async () => {
    prisma.trip.findMany.mockResolvedValue([trip()]);
    busPresence.noteFix('b1', { speed: 20, source: 'phone' }, Date.now() - 60_000);
    expect(await untrackedTrips(prisma, { minutes: 3 })).toEqual([]);
  });

  it('does not count a fix from before the trip started', async () => {
    prisma.trip.findMany.mockResolvedValue([trip()]);
    busPresence.noteFix('b1', { speed: 0, source: 'phone' }, Date.now() - 60 * 60_000);
    expect(await untrackedTrips(prisma, { minutes: 3 })).toHaveLength(1);
  });

  it('checks the stored GPS too, so a restart does not flag a trip that was tracking', async () => {
    prisma.trip.findMany.mockResolvedValue([trip()]);
    prisma.gpsLog.findFirst.mockResolvedValue({ id: 'g1' });
    expect(await untrackedTrips(prisma, { minutes: 3 })).toEqual([]);
  });

  it('is off at 0', async () => {
    expect(await untrackedTrips(prisma, { minutes: 0 })).toEqual([]);
    expect(prisma.trip.findMany).not.toHaveBeenCalled();
  });
});

describe('sweepUntrackedTrips', () => {
  it('reports each trip once however many passes see it', async () => {
    prisma.trip.findMany.mockResolvedValue([trip()]);
    const emitToUser = jest.fn();

    expect(await sweepUntrackedTrips(prisma, { io: {}, emitToUser, minutes: 3 })).toHaveLength(1);
    prisma.notification.createMany.mockResolvedValue({ count: 0 });
    expect(await sweepUntrackedTrips(prisma, { io: {}, emitToUser, minutes: 3 })).toEqual([]);
    expect(emitToUser).toHaveBeenCalledTimes(2);
  });
});
