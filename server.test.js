const request = require('supertest');
const { app, prisma } = require('./server');

describe('Leave Application API Tests', () => {
  beforeAll(async () => {
    // Optionally connect to Prisma
    await prisma.$connect();
  });

  afterAll(async () => {
    // Disconnect Prisma
    await prisma.$disconnect();
  });

  it('should return 500 when invalid date string is provided for startDate', async () => {
    const res = await request(app)
      .post('/api/leaves')
      .send({
        studentId: 'student_1',
        startDate: 'abc', // Invalid date
        endDate: '2024-12-31',
        reason: 'Sick',
        notes: 'Testing invalid startDate'
      });

    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
  });

  it('should return 500 when invalid date string is provided for endDate', async () => {
    const res = await request(app)
      .post('/api/leaves')
      .send({
        studentId: 'student_1',
        startDate: '2024-12-01',
        endDate: 'xyz', // Invalid date
        reason: 'Sick',
        notes: 'Testing invalid endDate'
      });

    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
  });
});
