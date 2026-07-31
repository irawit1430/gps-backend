const request = require('supertest');
const { app, prisma } = require('../server');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    leaveApplication: {
      findMany: jest.fn(),
    },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

describe('GET /api/schools/:schoolId/leaves', () => {
  const secret = process.env.JWT_SECRET || 'super-secret';
  const token = jwt.sign({ id: 1, role: 'ADMIN', schoolId: 1 }, secret);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 when no token is provided', async () => {
    const res = await request(app)
      .get('/api/schools/1/leaves');

    expect(res.status).toBe(401);
  });

  it('should return all leaves for a school when no status is provided', async () => {
    const mockLeaves = [
      { id: 1, status: 'PENDING', student: { name: 'John Doe', schoolId: '1' } },
      { id: 2, status: 'APPROVED', student: { name: 'Jane Doe', schoolId: '1' } },
    ];
    prisma.leaveApplication.findMany.mockResolvedValue(mockLeaves);

    const res = await request(app)
      .get('/api/schools/1/leaves')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockLeaves);
    expect(prisma.leaveApplication.findMany).toHaveBeenCalledWith({
      where: { student: { schoolId: '1' } },
      include: { student: true },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('should filter leaves by status if provided (excluding "all")', async () => {
    const mockLeaves = [
      { id: 1, status: 'PENDING', student: { name: 'John Doe', schoolId: '1' } },
    ];
    prisma.leaveApplication.findMany.mockResolvedValue(mockLeaves);

    const res = await request(app)
      .get('/api/schools/1/leaves?status=pending')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockLeaves);
    expect(prisma.leaveApplication.findMany).toHaveBeenCalledWith({
      where: { student: { schoolId: '1' }, status: 'PENDING' },
      include: { student: true },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('should return all leaves for a school when status is "all"', async () => {
    const mockLeaves = [
      { id: 1, status: 'PENDING', student: { name: 'John Doe', schoolId: '1' } },
      { id: 2, status: 'APPROVED', student: { name: 'Jane Doe', schoolId: '1' } },
    ];
    prisma.leaveApplication.findMany.mockResolvedValue(mockLeaves);

    const res = await request(app)
      .get('/api/schools/1/leaves?status=all')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockLeaves);
    expect(prisma.leaveApplication.findMany).toHaveBeenCalledWith({
      where: { student: { schoolId: '1' } },
      include: { student: true },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('should return 500 when database throws an error', async () => {
    prisma.leaveApplication.findMany.mockRejectedValue(new Error('Database error'));

    const res = await request(app)
      .get('/api/schools/1/leaves')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});
