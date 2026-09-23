// Driver phones used to get the bus's permanent secret and keep it forever. They now get
// a key for one trip and one driver, which the signature check accepts only while that
// trip runs with that driver on it.

const crypto = require('crypto');
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    bus: { findUnique: jest.fn(), update: jest.fn() },
    gpsLog: { create: jest.fn() },
    trip: { findMany: jest.fn(), findUnique: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const config = require('../config');
const logger = require('../logger');
const { app, prisma } = require('../server');
const positionAudience = require('../positionAudience');
const { tripTelemetryKey } = require('../telemetryKeys');

const BUS_SECRET = 'permanent-bus-secret';
const driverToken = (id) => `Bearer ${jwt.sign({ id, role: 'DRIVER', schoolId: 's1' }, process.env.JWT_SECRET)}`;
const fix = { deviceId: 'IMEI-7', lat: 12.9716, lng: 77.5946, speed: 30 };

// Signs exactly as the driver app does (voltava-drive services/api.ts sendTelemetry).
const post = (key, body = fix) => {
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', key).update(`${body.deviceId}.${ts}.${body.lat}.${body.lng}.${body.speed || 0}`).digest('hex');
  return request(app).post('/api/telemetry').set('X-Device-Signature', sig).set('X-Device-Timestamp', String(ts)).send(body);
};

const bus = (trips, deviceSecret = BUS_SECRET) => ({
  id: 'bus-7', deviceId: 'IMEI-7', deviceSecret, licensePlate: 'KA07', capacity: 40, schoolId: 's1', status: 'ONLINE', trips,
});

// What the driver's phone receives at the start of trip-1.
const fetchKey = async (driverId = 'driver-1') => {
  prisma.trip.findMany.mockResolvedValue([{ id: 'trip-1', status: 'ON_SCHEDULE', bus: { id: 'bus-7', deviceId: 'IMEI-7' } }]);
  const res = await request(app).get('/api/driver/telemetry-credentials').set('Authorization', driverToken(driverId));
  expect(res.status).toBe(200);
  return res.body.deviceSecret;
};

let info;
beforeAll(() => { config.TELEMETRY_HMAC_ENFORCE = true; });
afterAll(() => { config.TELEMETRY_HMAC_ENFORCE = false; config.TELEMETRY_ACCEPT_BUS_SECRET = true; });
beforeEach(() => {
  jest.clearAllMocks();
  config.TELEMETRY_ACCEPT_BUS_SECRET = true;
  prisma.gpsLog.create.mockResolvedValue({});
  prisma.bus.update.mockResolvedValue({});
  jest.spyOn(positionAudience, 'emitToRiders').mockResolvedValue();
  info = jest.spyOn(logger, 'info').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("the phone's key", () => {
  it('is not the bus secret, and is different for every trip, driver and bus', async () => {
    const key = await fetchKey();

    expect(key).not.toBe(BUS_SECRET);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set([
      key,
      tripTelemetryKey('bus-7', 'trip-2', 'driver-1'),
      tripTelemetryKey('bus-7', 'trip-1', 'driver-2'),
      tripTelemetryKey('bus-8', 'trip-1', 'driver-1'),
    ]).size).toBe(4);
  });

  it('works while its trip is running with its driver', async () => {
    const key = await fetchKey();
    prisma.bus.findUnique.mockResolvedValue(bus([{ id: 'trip-1', driverId: 'driver-1' }]));

    const res = await post(key);

    expect(res.status).toBe(200);
    expect(prisma.gpsLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ busId: 'bus-7', tripId: 'trip-1' }) });
  });

  it('stops working when the trip ends', async () => {
    const key = await fetchKey();
    prisma.bus.findUnique.mockResolvedValue(bus([]));

    expect((await post(key)).status).toBe(401);
    expect(prisma.gpsLog.create).not.toHaveBeenCalled();
  });

  it('stops working when the trip is handed to another driver', async () => {
    const key = await fetchKey('driver-1');
    prisma.bus.findUnique.mockResolvedValue(bus([{ id: 'trip-1', driverId: 'driver-2' }]));

    expect((await post(key)).status).toBe(401);
  });

  it("does not work for the bus's next trip", async () => {
    const key = await fetchKey();
    prisma.bus.findUnique.mockResolvedValue(bus([{ id: 'trip-2', driverId: 'driver-1' }]));

    expect((await post(key)).status).toBe(401);
  });

  it('works on a bus that was never given a permanent secret', async () => {
    // Phones used to be refused outright on such a bus: there was no secret to hand out.
    const key = await fetchKey();
    prisma.bus.findUnique.mockResolvedValue(bus([{ id: 'trip-1', driverId: 'driver-1' }], null));

    expect((await post(key)).status).toBe(200);
  });
});

describe('the permanent bus secret', () => {
  it('still works by default, so nothing breaks at deploy, and each bus using it is logged', async () => {
    prisma.bus.findUnique.mockResolvedValue(bus([]));

    expect((await post(BUS_SECRET)).status).toBe(200);
    expect(info).toHaveBeenCalledWith(
      { busId: 'bus-7', deviceId: 'IMEI-7' },
      'Telemetry signed with the permanent bus secret (TELEMETRY_ACCEPT_BUS_SECRET)'
    );
  });

  it('stops working once TELEMETRY_ACCEPT_BUS_SECRET is off', async () => {
    config.TELEMETRY_ACCEPT_BUS_SECRET = false;
    prisma.bus.findUnique.mockResolvedValue(bus([{ id: 'trip-1', driverId: 'driver-1' }]));

    expect((await post(BUS_SECRET)).status).toBe(401);
    // A trip key still works.
    expect((await post(await fetchKey())).status).toBe(200);
  });

  it('leaves a bus with no secret and no running trip nothing to check against', async () => {
    prisma.bus.findUnique.mockResolvedValue(bus([], null));

    expect((await post('anything')).status).toBe(403);
  });
});
