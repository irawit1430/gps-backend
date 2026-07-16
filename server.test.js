const request = require('supertest');
const { app, prisma } = require('./server'); // I will need to refactor server.js slightly to export app and prisma

describe('SOS Endpoint', () => {
  it('should return 500 when database fails', async () => {
    // Mock the Prisma client
    jest.spyOn(prisma.emergencyAlert, 'create').mockRejectedValue(new Error('Database connection failed'));

    const response = await request(app)
      .post('/api/alerts/sos')
      .send({
        schoolId: '123',
        senderId: '456',
        message: 'Test SOS',
        tripId: '789'
      });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Database connection failed' });

    // Restore the mock
    prisma.emergencyAlert.create.mockRestore();
  });
});
