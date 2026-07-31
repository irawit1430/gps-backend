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

describe('PUT /api/leaves/:id/reject', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const validToken = jwt.sign({ id: 1, role: 'ADMIN', schoolId: 10 }, process.env.JWT_SECRET || 'super-secret');

  it('should return 401 without authorization', async () => {
    const res = await request(app)
      .put('/api/leaves/123/reject');
    expect(res.status).toBe(401);
  });

  it('should successfully update leave status to REJECTED', async () => {
    const mockLeave = {
      id: '123',
      status: 'REJECTED'
    };
    prisma.leaveApplication.update.mockResolvedValue(mockLeave);

    const res = await request(app)
      .put('/api/leaves/123/reject')
      .set('Authorization', `Bearer ${validToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockLeave);
    expect(prisma.leaveApplication.update).toHaveBeenCalledWith({
      where: { id: '123' },
      data: { status: 'REJECTED' }
    });
  });

  it('should return 500 when database throws an error', async () => {
    prisma.leaveApplication.update.mockRejectedValue(new Error('Database error'));

    const res = await request(app)
      .put('/api/leaves/123/reject')
      .set('Authorization', `Bearer ${validToken}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});
