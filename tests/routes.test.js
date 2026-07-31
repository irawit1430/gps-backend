const request = require('supertest');
const { app, prisma } = require('../server');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    route: {
      delete: jest.fn(),
    },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

describe('DELETE /api/routes/:id', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = 'test-secret';
  });

  const generateToken = () => {
    return jwt.sign({ id: 1, role: 'SUPER_ADMIN' }, process.env.JWT_SECRET);
  };

  it('should successfully delete a route and return success', async () => {
    prisma.route.delete.mockResolvedValue({ id: 1, name: 'Route 1' });

    const token = generateToken();
    const res = await request(app)
      .delete('/api/routes/1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(prisma.route.delete).toHaveBeenCalledWith({ where: { id: '1' } });
  });

  it('should return 500 when database throws an error', async () => {
    prisma.route.delete.mockRejectedValue(new Error('Database error'));

    const token = generateToken();
    const res = await request(app)
      .delete('/api/routes/1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(prisma.route.delete).toHaveBeenCalledWith({ where: { id: '1' } });
  });

  it('should return 401 when unauthenticated', async () => {
    const res = await request(app)
      .delete('/api/routes/1');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized: Missing or invalid token' });
  });
});
