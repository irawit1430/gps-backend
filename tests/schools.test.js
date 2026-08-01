const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrismaClient = {
    student: { count: jest.fn() },
    route: { count: jest.fn() },
    trip: { count: jest.fn() },
    attendanceLog: { count: jest.fn() },
    leaveApplication: { count: jest.fn() }
  };
  return { PrismaClient: jest.fn(() => mockPrismaClient) };
});

const { app, prisma } = require('../server');

describe('GET /api/schools/:schoolId/stats', () => {
  let token;

  beforeAll(() => {
    token = jwt.sign({ id: 1, role: 'SUPER_ADMIN' }, process.env.JWT_SECRET || 'super-secret');
    jest.useFakeTimers().setSystemTime(new Date('2024-01-01T12:00:00Z'));
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return correct school stats', async () => {
    prisma.student.count.mockResolvedValue(100);
    prisma.route.count.mockResolvedValue(10);
    prisma.trip.count.mockResolvedValue(5);
    prisma.attendanceLog.count.mockResolvedValue(80);
    prisma.leaveApplication.count.mockResolvedValue(2);

    const res = await request(app)
      .get('/api/schools/1/stats')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totalStudents: 100,
      totalRoutes: 10,
      activeTrips: 5,
      totalBoarded: 80,
      pendingLeaves: 2
    });

    const expectedDate = new Date('2024-01-01T12:00:00Z');
    expectedDate.setHours(0, 0, 0, 0);

    expect(prisma.student.count).toHaveBeenCalledWith({ where: { schoolId: '1' } });
    expect(prisma.route.count).toHaveBeenCalledWith({ where: { schoolId: '1' } });
    expect(prisma.trip.count).toHaveBeenCalledWith({ where: { route: { schoolId: '1' }, status: "ON_SCHEDULE" } });
    expect(prisma.attendanceLog.count).toHaveBeenCalledWith({ where: { student: { schoolId: '1' }, type: "BOARDED", timestamp: { gte: expectedDate } } });
    expect(prisma.leaveApplication.count).toHaveBeenCalledWith({ where: { student: { schoolId: '1' }, status: "PENDING" } });
  });

  it('should return 500 on database error', async () => {
    // Suppress console.error in tests
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    prisma.student.count.mockRejectedValue(new Error('Database error'));
    prisma.route.count.mockResolvedValue(10);
    prisma.trip.count.mockResolvedValue(5);
    prisma.attendanceLog.count.mockResolvedValue(80);
    prisma.leaveApplication.count.mockResolvedValue(2);

    const res = await request(app)
      .get('/api/schools/1/stats')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });

    consoleSpy.mockRestore();
  });
});
