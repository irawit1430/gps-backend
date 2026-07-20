const request = require('supertest');
const { app, prisma } = require('../server');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {};
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

describe('Authorization tests', () => {
  it('should return 403 for non SUPER_ADMIN accessing /api/admins', async () => {
    const parentToken = jwt.sign({ id: 2, role: 'PARENT' }, 'test');
    const res = await request(app)
      .get('/api/admins')
      .set('Authorization', `Bearer ${parentToken}`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden: Insufficient privileges' });
  });

  it('should return 403 for non SUPER_ADMIN accessing /api/admin/stats', async () => {
    const parentToken = jwt.sign({ id: 2, role: 'PARENT' }, 'test');
    const res = await request(app)
      .get('/api/admin/stats')
      .set('Authorization', `Bearer ${parentToken}`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden: Insufficient privileges' });
  });
});
