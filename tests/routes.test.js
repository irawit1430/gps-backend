const request = require('supertest');
const { app, prisma } = require('../server');
const jwt = require('jsonwebtoken');

// Mock prisma
jest.mock('@prisma/client', () => {
  const mockPrisma = {
    route: {
      update: jest.fn(),
    },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

describe('PUT /api/routes/:id', () => {
  const secret = process.env.JWT_SECRET || 'super-secret';
  const token = jwt.sign({ id: 1, role: 'ADMIN', schoolId: 10 }, secret);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should update route and return 200 on success', async () => {
    const mockRoute = {
      id: 1,
      name: 'Morning Route B',
      estimatedDuration: 45,
      schoolId: 10
    };
    prisma.route.update.mockResolvedValue(mockRoute);

    const res = await request(app)
      .put('/api/routes/1')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Morning Route B', estimatedDuration: 45 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockRoute);
    expect(prisma.route.update).toHaveBeenCalledWith({
      where: { id: '1' },
      data: { name: 'Morning Route B', estimatedDuration: 45 }
    });
  });

  it('should return 500 when database throws an error', async () => {
    prisma.route.update.mockRejectedValue(new Error('Database error'));

    const res = await request(app)
      .put('/api/routes/1')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Morning Route B', estimatedDuration: 45 });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  it('should return 401 if missing auth token', async () => {
    const res = await request(app)
      .put('/api/routes/1')
      .send({ name: 'Morning Route B', estimatedDuration: 45 });

    expect(res.status).toBe(401);
  });
});
