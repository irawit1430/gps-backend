// The phone GPS signature check (middleware/telemetryHmac.js) is the only guard on
// /api/telemetry. It used to be off unless TELEMETRY_HMAC_ENFORCE was set, even in
// production, and when on it matched only ON_SCHEDULE trips, so a DELAYED bus's GPS
// was filed under no trip and its parents stopped seeing it move.

const crypto = require('crypto');
const request = require('supertest');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    bus: { findUnique: jest.fn(), update: jest.fn() },
    gpsLog: { create: jest.fn() },
    studentRouteMapping: { findMany: jest.fn() },
    trip: { findUnique: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const config = require('../config');
const { app, prisma } = require('../server');
const positionAudience = require('../positionAudience');

const SECRET = 'bus-secret-hex';
const now = () => Math.floor(Date.now() / 1000);

// Exactly what the driver app does (voltava-drive services/api.ts sendTelemetry).
const signLikeTheApp = (secret, { deviceId, lat, lng, speed }, ts = now()) => ({
  ts,
  signature: crypto.createHmac('sha256', secret).update(`${deviceId}.${ts}.${lat}.${lng}.${speed || 0}`).digest('hex'),
});

const post = (body, { secret = SECRET, ts } = {}) => {
  const { ts: stamp, signature } = signLikeTheApp(secret, body, ts);
  return request(app)
    .post('/api/telemetry')
    .set('X-Device-Signature', signature)
    .set('X-Device-Timestamp', String(stamp))
    .send(body);
};

const busWith = (trips) => ({
  id: 'bus-1', deviceId: 'IMEI-1', deviceSecret: SECRET, licensePlate: 'KA01', capacity: 40,
  schoolId: 's1', status: 'ONLINE', trips,
});

describe('resolving TELEMETRY_HMAC_ENFORCE', () => {
  const resolve = (env) => {
    const saved = { ...process.env };
    let value;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      Object.assign(process.env, env);
      if (env.TELEMETRY_HMAC_ENFORCE === undefined) delete process.env.TELEMETRY_HMAC_ENFORCE;
      jest.isolateModules(() => { value = require('../config').TELEMETRY_HMAC_ENFORCE; });
      return { value, warned: warn.mock.calls.some(([m]) => /TELEMETRY_HMAC_ENFORCE is off/.test(m)) };
    } finally {
      process.env = saved;
      warn.mockRestore();
    }
  };

  it('is on in production when nobody set it', () => {
    expect(resolve({ NODE_ENV: 'production', TELEMETRY_HMAC_ENFORCE: undefined })).toEqual({ value: true, warned: false });
  });

  it('can still be switched off in production, with a warning at boot', () => {
    expect(resolve({ NODE_ENV: 'production', TELEMETRY_HMAC_ENFORCE: '0' })).toEqual({ value: false, warned: true });
  });

  it('stays off by default outside production', () => {
    expect(resolve({ NODE_ENV: 'development', TELEMETRY_HMAC_ENFORCE: undefined }).value).toBe(false);
  });

  it('honours an explicit 1 anywhere', () => {
    expect(resolve({ NODE_ENV: 'development', TELEMETRY_HMAC_ENFORCE: '1' }).value).toBe(true);
    expect(resolve({ NODE_ENV: 'production', TELEMETRY_HMAC_ENFORCE: 'true' }).value).toBe(true);
  });
});

describe('POST /api/telemetry with the signature check on', () => {
  let emitToRiders;
  beforeAll(() => { config.TELEMETRY_HMAC_ENFORCE = true; });
  afterAll(() => { config.TELEMETRY_HMAC_ENFORCE = false; });
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.gpsLog.create.mockResolvedValue({});
    prisma.bus.update.mockResolvedValue({});
    emitToRiders = jest.spyOn(positionAudience, 'emitToRiders').mockResolvedValue();
  });
  afterEach(() => emitToRiders.mockRestore());

  const fix = { deviceId: 'IMEI-1', lat: 12.9716, lng: 77.5946, speed: 32 };

  it("files a late bus's GPS under its trip and sends it to that trip's parents", async () => {
    prisma.bus.findUnique.mockResolvedValue(busWith([{ id: 'late-trip' }]));

    const res = await post(fix);

    expect(res.status).toBe(200);
    expect(prisma.bus.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      include: { trips: { where: { status: { in: ['ON_SCHEDULE', 'DELAYED'] } }, select: { id: true, driverId: true } } },
    }));
    expect(prisma.gpsLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ busId: 'bus-1', tripId: 'late-trip' }),
    });
    expect(emitToRiders).toHaveBeenCalledWith(
      expect.anything(), prisma, 'late-trip', 'location_update', expect.anything(), expect.anything()
    );
  });

  it('accepts a fix signed the way the driver app signs it, with or without speed', async () => {
    prisma.bus.findUnique.mockResolvedValue(busWith([]));

    expect((await post(fix)).status).toBe(200);
    expect((await post({ deviceId: 'IMEI-1', lat: 12.5, lng: 77.25 })).status).toBe(200);
  });

  it('refuses a fix signed with the wrong secret', async () => {
    prisma.bus.findUnique.mockResolvedValue(busWith([]));

    const res = await post(fix, { secret: 'someone-elses-secret' });

    expect(res.status).toBe(401);
    expect(prisma.gpsLog.create).not.toHaveBeenCalled();
  });

  it('refuses an unsigned fix', async () => {
    const res = await request(app).post('/api/telemetry').send(fix);

    expect(res.status).toBe(401);
    expect(prisma.bus.findUnique).not.toHaveBeenCalled();
  });

  it('refuses a replayed fix from outside the clock window', async () => {
    prisma.bus.findUnique.mockResolvedValue(busWith([]));

    expect((await post(fix, { ts: now() - 3600 })).status).toBe(401);
  });
});
