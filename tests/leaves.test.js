const request = require('supertest');
const { app, prisma } = require('../server');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    leaveApplication: {
      update: jest.fn(),
    },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

describe('PUT /api/leaves/:id/approve', () => {
  let token;
  beforeEach(() => {
    jest.clearAllMocks();
    token = jwt.sign({ id: 1, role: 'SCHOOL_ADMIN', schoolId: 10 }, process.env.JWT_SECRET || 'super-secret');
  });

  it('should successfully approve a leave application', async () => {
    const mockLeave = {
      id: '123',
      status: 'APPROVED'
    };
    prisma.leaveApplication.update.mockResolvedValue(mockLeave);

    const res = await request(app)
      .put('/api/leaves/123/approve')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockLeave);
    expect(prisma.leaveApplication.update).toHaveBeenCalledWith({
      where: { id: '123' },
      data: { status: 'APPROVED' }
    });
  });

  it('should return 500 when database throws an error', async () => {
    prisma.leaveApplication.update.mockRejectedValue(new Error('Database error'));

    const res = await request(app)
      .put('/api/leaves/123/approve')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});
