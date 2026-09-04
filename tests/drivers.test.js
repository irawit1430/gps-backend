const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    user: { findMany: jest.fn(), findUnique: jest.fn(), delete: jest.fn() },
    run: { findMany: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

describe('DELETE /api/drivers/:id revokes sessions', () => {
  it('rejects the deleted driver\'s existing JWT', async () => {
    const driverId = 'deleted-driver';
    const driverToken = jwt.sign({ id: driverId, role: 'DRIVER', schoolId: 'school-1' }, SECRET);
    const superToken = jwt.sign({ id: 'super-1', role: 'SUPER_ADMIN' }, SECRET);
    prisma.user.findUnique.mockResolvedValue({ id: driverId, role: 'DRIVER', schoolId: 'school-1' });
    prisma.run.findMany.mockResolvedValue([]);
    prisma.user.delete.mockResolvedValue({ id: driverId });

    const deleted = await request(app)
      .delete(`/api/drivers/${driverId}`)
      .set('Authorization', `Bearer ${superToken}`);
    expect(deleted.status).toBe(204);

    const reused = await request(app)
      .get('/api/users/me')
      .set('Authorization', `Bearer ${driverToken}`);
    expect(reused.status).toBe(401);
  });
});

const { app, prisma } = require('../server');
const SECRET = process.env.JWT_SECRET;

describe('GET /api/schools/:schoolId/drivers', () => {
  let token;

  beforeAll(() => {
    // SCHOOL_ADMIN of school-1 accessing its own drivers
    token = jwt.sign({ id: '1', role: 'SCHOOL_ADMIN', schoolId: 'school-1' }, SECRET);
  });

  beforeEach(() => jest.clearAllMocks());

  it('should return 401 if unauthorized', async () => {
    const res = await request(app).get('/api/schools/school-1/drivers');
    expect(res.status).toBe(401);
  });

  it('should return 403 for cross-tenant access', async () => {
    const res = await request(app).get('/api/schools/school-2/drivers').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('should return 200 and a list of drivers when authorized', async () => {
    const mockDrivers = [
      { id: 1, name: 'Driver 1', role: 'DRIVER', schoolId: 'school-1', driverTrips: [] },
      { id: 2, name: 'Driver 2', role: 'DRIVER', schoolId: 'school-1', driverTrips: [] },
    ];
    prisma.user.findMany.mockResolvedValue(mockDrivers);

    const res = await request(app).get('/api/schools/school-1/drivers').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    // Handler adds isAvailable = (no active/planned trips)
    expect(res.body).toEqual(mockDrivers.map((d) => ({ ...d, isAvailable: true })));
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { schoolId: 'school-1', role: 'DRIVER' },
      select: {
        id: true, name: true, email: true, phone: true, role: true, photoUrl: true,
        notificationSettings: true, schoolId: true, createdAt: true, updatedAt: true,
        driverTrips: {
          where: { status: { in: ['PLANNED', 'ON_SCHEDULE', 'DELAYED'] } },
          // bus is field-selected so the HMAC deviceSecret never leaves the server
          include: {
            bus: { select: { id: true, licensePlate: true, capacity: true, deviceId: true, status: true } },
            route: true,
          },
        },
      },
    });
  });

  it('should return 500 when database throws an error', async () => {
    prisma.user.findMany.mockRejectedValue(new Error('Database error'));
    const res = await request(app).get('/api/schools/school-1/drivers').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});
