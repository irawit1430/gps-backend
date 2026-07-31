const request = require('supertest');
const { app, prisma } = require('../server');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    route: {
      create: jest.fn(),
    },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

describe('POST /api/schools/:schoolId/routes', () => {
  const schoolId = '10';
  const validToken = jwt.sign(
    { id: 1, role: 'ADMIN', schoolId: parseInt(schoolId, 10) },
    process.env.JWT_SECRET || 'super-secret'
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 for unauthenticated requests', async () => {
    const res = await request(app)
      .post(`/api/schools/${schoolId}/routes`)
      .send({ name: 'Morning Route A', estimatedDuration: 45 });

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
  });

  it('should create a route and return 200 on success', async () => {
    const mockRoute = {
      id: 1,
      schoolId: parseInt(schoolId, 10),
      name: 'Morning Route A',
      estimatedDuration: 45,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    prisma.route.create.mockResolvedValue(mockRoute);

    const res = await request(app)
      .post(`/api/schools/${schoolId}/routes`)
      .set('Authorization', `Bearer ${validToken}`)
      .send({ name: 'Morning Route A', estimatedDuration: 45 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockRoute);
    expect(prisma.route.create).toHaveBeenCalledWith({
      data: {
        schoolId: schoolId,
        name: 'Morning Route A',
        estimatedDuration: 45
      }
    });
  });

  it('should return 500 when database throws an error', async () => {
    prisma.route.create.mockRejectedValue(new Error('Database error'));

    // Suppress console.error in tests for expected errors
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app)
      .post(`/api/schools/${schoolId}/routes`)
      .set('Authorization', `Bearer ${validToken}`)
      .send({ name: 'Morning Route A', estimatedDuration: 45 });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });

    consoleSpy.mockRestore();
  });
});
