const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    trip: { findFirst: jest.fn() },
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
    prisma.trip.findFirst.mockResolvedValue(null);
    const res = await request(app)
      .get('/api/driver/telemetry-credentials')
      .set('Authorization', `Bearer ${driverToken()}`);
    expect(res.status).toBe(404);
  });

  it('should return deviceId + deviceSecret for the driver active-trip bus', async () => {
    prisma.trip.findFirst.mockResolvedValue({
      id: 't1',
      bus: { deviceId: 'IMEI-123', deviceSecret: 'sekret' },
    });
    const res = await request(app)
      .get('/api/driver/telemetry-credentials')
      .set('Authorization', `Bearer ${driverToken()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deviceId: 'IMEI-123', deviceSecret: 'sekret' });
    // Scoped to the calling driver and only active trips.
    expect(prisma.trip.findFirst).toHaveBeenCalledWith({
      where: { driverId: 'd1', status: { in: ['PLANNED', 'ON_SCHEDULE', 'DELAYED'] } },
      include: { bus: { select: { deviceId: true, deviceSecret: true } } },
      orderBy: { createdAt: 'asc' },
    });
  });
});
