const request = require('supertest');
const { app, prisma } = require('../server');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    leaveApplication: {
      update: jest.fn(),
      findUnique: jest.fn(),
    },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const SECRET = process.env.JWT_SECRET;

describe('PUT /api/leaves/:id/approve', () => {
  let superToken;
  beforeEach(() => {
    jest.clearAllMocks();
    superToken = jwt.sign({ id: '1', role: 'SUPER_ADMIN' }, SECRET);
  });

  it('should approve a leave (SUPER_ADMIN bypasses ownership)', async () => {
    const mockLeave = { id: '123', status: 'APPROVED' };
    prisma.leaveApplication.update.mockResolvedValue(mockLeave);

    const res = await request(app).put('/api/leaves/123/approve').set('Authorization', `Bearer ${superToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockLeave);
    expect(prisma.leaveApplication.update).toHaveBeenCalledWith({ where: { id: '123' }, data: { status: 'APPROVED' } });
  });

  it('should return 500 when database throws an error', async () => {
    prisma.leaveApplication.update.mockRejectedValue(new Error('Database error'));
    const res = await request(app).put('/api/leaves/123/approve').set('Authorization', `Bearer ${superToken}`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  it('should return 403 when SCHOOL_ADMIN approves another school\'s leave', async () => {
    prisma.leaveApplication.findUnique.mockResolvedValue({ id: '123', student: { schoolId: 'school-B' } });
    const adminA = jwt.sign({ id: 'a1', role: 'SCHOOL_ADMIN', schoolId: 'school-A' }, SECRET);
    const res = await request(app).put('/api/leaves/123/approve').set('Authorization', `Bearer ${adminA}`);
    expect(res.status).toBe(403);
    expect(prisma.leaveApplication.update).not.toHaveBeenCalled();
  });

  it('should return 403 for a PARENT', async () => {
    const parent = jwt.sign({ id: 'p1', role: 'PARENT' }, SECRET);
    const res = await request(app).put('/api/leaves/123/approve').set('Authorization', `Bearer ${parent}`);
    expect(res.status).toBe(403);
  });
});
