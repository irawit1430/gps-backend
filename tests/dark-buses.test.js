// A bus that stops sending GPS mid-trip used to be noticed only by the 15-minute sweep,
// which told nobody. darkBuses.js flags it within minutes and tells the school's
// admins, without raising the alarm for a phone-tracked bus that is simply parked.

const request = require('supertest');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    bus: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    gpsLog: { create: jest.fn() },
    trip: { findMany: jest.fn(), findUnique: jest.fn() },
    user: { findMany: jest.fn() },
    notification: { createMany: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const { app, prisma } = require('../server');
const busPresence = require('../busPresence');
const { isDark, sweepDarkBuses } = require('../darkBuses');

const NOW = Date.parse('2026-09-22T08:00:00Z');
const MIN = 60_000;
const rules = { now: NOW, quietMs: 5 * MIN, movingKph: 5 };

describe('isDark', () => {
  it('counts a quiet hardware tracker, which reports even when parked', () => {
    expect(isDark({ at: NOW - 6 * MIN, speed: 0, source: 'tracker' }, rules)).toBe(true);
  });

  it('counts a phone that went quiet while the bus was moving', () => {
    expect(isDark({ at: NOW - 6 * MIN, speed: 32, source: 'phone' }, rules)).toBe(true);
  });

  it('does not count a phone on a bus standing still: it only sends after moving', () => {
    expect(isDark({ at: NOW - 20 * MIN, speed: 0, source: 'phone' }, rules)).toBe(false);
  });

  it('does not count a bus heard from recently', () => {
    expect(isDark({ at: NOW - 4 * MIN, speed: 40, source: 'tracker' }, rules)).toBe(false);
  });

  it('does not count a bus not heard from since the server started', () => {
    expect(isDark(null, rules)).toBe(false);
  });
});

describe('sweepDarkBuses', () => {
  const io = {};
  let emitToSchool;
  let emitToUser;
  const sweep = (opts = {}) =>
    sweepDarkBuses(prisma, { io, emitToSchool, emitToUser, minutes: 5, movingKph: 5, now: NOW, ...opts });

  const runningTrip = (busId, schoolId = 's1') => ({
    id: `trip-${busId}`,
    bus: { id: busId, licensePlate: `KA-${busId}`, schoolId },
    route: { name: 'Route 7', schoolId },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    busPresence.clear();
    emitToSchool = jest.fn();
    emitToUser = jest.fn();
    prisma.bus.updateMany.mockResolvedValue({ count: 1 });
    prisma.user.findMany.mockResolvedValue([{ id: 'admin-1' }, { id: 'admin-2' }]);
    prisma.notification.createMany.mockResolvedValue({ count: 2 });
  });

  it("tells the school's admins, marks the bus offline, and reports it once", async () => {
    prisma.trip.findMany.mockResolvedValue([runningTrip('b1')]);
    busPresence.noteFix('b1', { speed: 40, source: 'phone' }, NOW - 7 * MIN);

    const flagged = await sweep();

    expect(flagged).toEqual([{ busId: 'b1', tripId: 'trip-b1', schoolId: 's1', quietMinutes: 7 }]);
    expect(prisma.trip.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: { in: ['ON_SCHEDULE', 'DELAYED'] }, bus: { status: 'ONLINE' } },
    }));
    expect(prisma.bus.updateMany).toHaveBeenCalledWith({
      where: { id: 'b1', status: 'ONLINE' }, data: { status: 'OFFLINE' },
    });
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { schoolId: 's1', role: { in: ['SCHOOL_ADMIN', 'SUPER_ADMIN'] } }, select: { id: true },
    });
    const { data, skipDuplicates } = prisma.notification.createMany.mock.calls[0][0];
    expect(skipDuplicates).toBe(true);
    expect(data).toHaveLength(2);
    expect(data[0]).toMatchObject({
      userId: 'admin-1',
      title: 'Bus stopped sending GPS',
      type: 'SYSTEM',
      context: { type: 'BUS_DARK', busId: 'b1', tripId: 'trip-b1' },
      eventKey: `bus-dark:b1:${NOW - 7 * MIN}:admin-1`,
    });
    expect(data[0].message).toMatch(/KA-b1 on Route 7 has sent no GPS for 7 minutes/);
    expect(emitToUser).toHaveBeenCalledWith(io, 'admin-1', 'notification', expect.objectContaining({ title: 'Bus stopped sending GPS' }));
    expect(emitToSchool).toHaveBeenCalledWith(io, 's1', 'device_status_change', expect.objectContaining({ deviceId: 'b1', status: 'OFFLINE' }));
  });

  it('lets the next fix announce the bus again straight away', async () => {
    prisma.trip.findMany.mockResolvedValue([runningTrip('b1')]);
    busPresence.noteFix('b1', { speed: 0, source: 'tracker' }, NOW - 6 * MIN);
    busPresence.evaluate('b1', 'ONLINE'); // it had been reporting

    await sweep();

    expect(busPresence.evaluate('b1', 'OFFLINE')).toEqual({ write: true, cameOnline: true });
  });

  it('says nothing when another pass already marked the bus offline', async () => {
    prisma.trip.findMany.mockResolvedValue([runningTrip('b1')]);
    busPresence.noteFix('b1', { speed: 0, source: 'tracker' }, NOW - 6 * MIN);
    prisma.bus.updateMany.mockResolvedValue({ count: 0 });

    expect(await sweep()).toEqual([]);
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
    expect(emitToSchool).not.toHaveBeenCalled();
  });

  it('leaves a parked phone-tracked bus alone', async () => {
    prisma.trip.findMany.mockResolvedValue([runningTrip('b1')]);
    busPresence.noteFix('b1', { speed: 0, source: 'phone' }, NOW - 30 * MIN);

    expect(await sweep()).toEqual([]);
    expect(prisma.bus.updateMany).not.toHaveBeenCalled();
  });

  it('tells only super-admins about a bus that belongs to no school', async () => {
    prisma.trip.findMany.mockResolvedValue([{ ...runningTrip('b1', null) }]);
    busPresence.noteFix('b1', { speed: 0, source: 'tracker' }, NOW - 6 * MIN);

    await sweep();

    expect(prisma.user.findMany).toHaveBeenCalledWith({ where: { role: 'SUPER_ADMIN' }, select: { id: true } });
  });

  it('does nothing when switched off', async () => {
    expect(await sweep({ minutes: 0 })).toEqual([]);
    expect(prisma.trip.findMany).not.toHaveBeenCalled();
  });
});

describe('phone GPS feeds the sweep', () => {
  it('records the fix as a phone fix, with its speed', async () => {
    busPresence.clear();
    prisma.bus.findUnique.mockResolvedValue({
      id: 'b9', deviceId: 'IMEI-9', licensePlate: 'KA09', capacity: 40, schoolId: 's1', status: 'ONLINE', trips: [],
    });
    prisma.gpsLog.create.mockResolvedValue({});
    prisma.bus.update.mockResolvedValue({});

    const res = await request(app).post('/api/telemetry').send({ deviceId: 'IMEI-9', lat: 12.9, lng: 77.5, speed: 27 });

    expect(res.status).toBe(200);
    expect(busPresence.lastFixOf('b9')).toEqual({ at: expect.any(Number), speed: 27, source: 'phone' });
  });
});
