const request = require('supertest');
const { app } = require('../server');
const jwt = require('jsonwebtoken');

describe('RBAC Middleware Tests', () => {
  let superAdminToken;
  let driverToken;

  beforeAll(() => {
    process.env.JWT_SECRET = 'super-secret';
    superAdminToken = jwt.sign({ id: 1, role: 'SUPER_ADMIN' }, process.env.JWT_SECRET);
    driverToken = jwt.sign({ id: 2, role: 'DRIVER' }, process.env.JWT_SECRET);
  });

  it('should block DRIVER from accessing /api/admin/stats', async () => {
    const res = await request(app)
      .get('/api/admin/stats')
      .set('Authorization', `Bearer ${driverToken}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden: Insufficient permissions' });
  });

  it('should allow SUPER_ADMIN to attempt accessing /api/admin/stats', async () => {
    // It might return 500 or 200 depending on mock, but NOT 403
    const res = await request(app)
      .get('/api/admin/stats')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
  });
});
