const request = require('supertest');
const { app, prisma } = require('../server');
const jwt = require('jsonwebtoken');

// Mock prisma
jest.mock('@prisma/client', () => {
  const mockPrisma = {
    route: {
      findMany: jest.fn(),
    },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

describe('GET /api/schools/:schoolId/routes', () => {
  let token;

  beforeEach(() => {
    jest.clearAllMocks();
    // Generate a valid token for testing
    token = jwt.sign({ id: 1, role: 'ADMIN', schoolId: 123 }, process.env.JWT_SECRET || 'super-secret');
  });

  it('should return 401 when no token is provided', async () => {
    const res = await request(app).get('/api/schools/123/routes');
    expect(res.status).toBe(401);
  });

  it('should return 200 and a list of routes when routes are found', async () => {
    const mockRoutes = [
      { id: '1', name: 'Route 1', schoolId: '123' },
      { id: '2', name: 'Route 2', schoolId: '123' }
    ];
    prisma.route.findMany.mockResolvedValue(mockRoutes);

    const res = await request(app)
      .get('/api/schools/123/routes')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockRoutes);
    expect(prisma.route.findMany).toHaveBeenCalledWith({
      where: { schoolId: '123' },
      include: { stops: { orderBy: { orderIdx: 'asc' } }, trips: { take: 1, orderBy: { createdAt: 'desc' } } }
    });
  });

  it('should return 500 when database throws an error', async () => {
    prisma.route.findMany.mockRejectedValue(new Error('Database error'));

    const res = await request(app)
      .get('/api/schools/123/routes')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});
