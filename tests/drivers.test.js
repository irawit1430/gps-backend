const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    user: { findMany: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
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
      { id: 1, name: 'Driver 1', role: 'DRIVER', schoolId: 'school-1' },
      { id: 2, name: 'Driver 2', role: 'DRIVER', schoolId: 'school-1' },
    ];
    prisma.user.findMany.mockResolvedValue(mockDrivers);

    const res = await request(app).get('/api/schools/school-1/drivers').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockDrivers);
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { schoolId: 'school-1', role: 'DRIVER' },
      select: {
        id: true, name: true, email: true, role: true, photoUrl: true,
        notificationSettings: true, schoolId: true, createdAt: true, updatedAt: true,
        driverTrips: { where: { status: { in: ['PLANNED', 'ON_SCHEDULE'] } }, include: { bus: true, route: true } },
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
