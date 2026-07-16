const request = require('supertest');
const { app, server, prisma } = require('../server');

describe('Auth Endpoints', () => {
  afterAll(async () => {
    server.close();
    await prisma.$disconnect();
  });

  describe('POST /api/auth/login', () => {
    it('should return 500 and error message when a server error occurs', async () => {
      // Mock the Prisma client to throw an exception
      jest.spyOn(prisma.user, 'findUnique').mockRejectedValue(new Error('Simulated database failure'));

      const res = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'test@example.com',
          password: 'password123'
        });

      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({ error: 'Simulated database failure' });

      // Restore the mock
      prisma.user.findUnique.mockRestore();
    });
  });
});
