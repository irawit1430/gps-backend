// A trip goes live only once its bus's GPS reaches the school, or the driver says why
// it cannot. The driver app asks tracking-check first; the server can enforce it too.

const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    trip: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    gpsLog: { findFirst: jest.fn() },
    user: { findMany: jest.fn() },
    notification: { createMany: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const { app, prisma } = require('../server');
const config = require('../config');
const busPresence = require('../busPresence');

const SECRET = process.env.JWT_SECRET;
const TRIP = '88888888-8888-4888-8888-888888888888';
const driver = jwt.sign({ id: 'd1', role: 'DRIVER', schoolId: 's1' }, SECRET);

const planned = { id: TRIP, status: 'PLANNED', busId: 'b1', driverId: 'd1', scheduledStart: null, startTime: null, route: { schoolId: 's1' } };

beforeEach(() => {
  jest.clearAllMocks();
  busPresence.clear();
  config.TRIP_START_REQUIRES_GPS = false;
  prisma.trip.findUnique.mockImplementation(({ select }) => Promise.resolve(select?.bus
    ? { id: TRIP, bus: { id: 'b1', licensePlate: 'BR01 1111' }, route: { name: 'Route 1', schoolId: 's1' } }
    : planned));
  prisma.trip.findFirst.mockResolvedValue(null);
  prisma.trip.update.mockImplementation(({ data }) => Promise.resolve({ ...planned, ...data, route: { schoolId: 's1', name: 'Route 1' } }));
  prisma.gpsLog.findFirst.mockResolvedValue(null);
  prisma.user.findMany.mockResolvedValue([{ id: 'a1' }]);
  prisma.notification.createMany.mockResolvedValue({ count: 1 });
});
afterAll(() => { config.TRIP_START_REQUIRES_GPS = false; });

const start = (body) => request(app).patch(`/api/trips/${TRIP}/status`).set('Authorization', `Bearer ${driver}`).send({ status: 'ON_SCHEDULE', ...body });
const check = () => request(app).get(`/api/trips/${TRIP}/tracking-check`).set('Authorization', `Bearer ${driver}`);

describe('tracking-check', () => {
  it('says not yet when nothing has come in', async () => {
    const res = await check();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ verified: false, source: null });
  });

  it('counts a fresh fix from the phone', async () => {
    busPresence.noteFix('b1', { speed: 0, source: 'phone' });
    expect((await check()).body).toMatchObject({ verified: true, source: 'phone' });
  });

  it('counts a healthy tracker on its own: the phone is then only a fallback', async () => {
    busPresence.noteFix('b1', { speed: 0, source: 'tracker' });
    expect((await check()).body).toMatchObject({ verified: true, source: 'tracker' });
  });

  it('does not count a fix older than TRIP_START_FIX_SECONDS', async () => {
    busPresence.noteFix('b1', { speed: 0, source: 'phone' }, Date.now() - (config.TRIP_START_FIX_SECONDS + 5) * 1000);
    expect((await check()).body.verified).toBe(false);
  });

  it('finds a stored fix after a restart', async () => {
    prisma.gpsLog.findFirst.mockResolvedValue({ timestamp: new Date() });
    expect((await check()).body).toMatchObject({ verified: true, source: 'stored' });
  });
});

describe('starting the trip', () => {
  it('refuses with no GPS when the server enforces it', async () => {
    config.TRIP_START_REQUIRES_GPS = true;
    const res = await start();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('GPS_NOT_VERIFIED');
    expect(prisma.trip.update).not.toHaveBeenCalled();
  });

  it('starts once GPS has come in', async () => {
    config.TRIP_START_REQUIRES_GPS = true;
    busPresence.noteFix('b1', { speed: 0, source: 'phone' });
    const res = await start();
    expect(res.status).toBe(200);
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });

  it('starts without GPS only with a reason, and tells the school at once', async () => {
    config.TRIP_START_REQUIRES_GPS = true;
    const res = await start({ gpsOverrideReason: 'Phone GPS not working' });

    expect(res.status).toBe(200);
    const { data } = prisma.notification.createMany.mock.calls[0][0];
    expect(data[0]).toMatchObject({ userId: 'a1', title: 'Trip started without GPS', eventKey: `tracking-unverified:${TRIP}:a1` });
    expect(data[0].message).toContain('"Phone GPS not working"');
  });

  it('lets an older app start as before while enforcement is off (the sweep still catches it)', async () => {
    const res = await start();
    expect(res.status).toBe(200);
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });

  it('refuses a reason too short to mean anything', async () => {
    const res = await start({ gpsOverrideReason: 'x' });
    expect(res.status).toBe(400);
  });
});
