const request = require('supertest');
const jwt = require('jsonwebtoken');

// Mock prisma before importing app
jest.mock('@prisma/client', () => {
  const mockPrisma = {
    bus: { count: jest.fn() },
    student: { count: jest.fn() },
    route: {
      count: jest.fn(),
      aggregate: jest.fn(),
      findFirst: jest.fn()
    },
    leaveApplication: { count: jest.fn() },
    gpsLog: { findMany: jest.fn() },
    school: { count: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const { app, prisma } = require('../server');

describe('GET /api/admin/stats', () => {
  beforeEach(() => {
    jest.clearAllMocks();

  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('SUPER_ADMIN stats', () => {
    let token;
    beforeAll(() => {
      token = jwt.sign({ id: 'super-admin-1', role: 'SUPER_ADMIN' }, process.env.JWT_SECRET || 'super-secret');
    });

    it('should return global statistics for SUPER_ADMIN', async () => {
      prisma.school.count
        .mockResolvedValueOnce(50) // totalSchools
        .mockResolvedValueOnce(5); // schoolsThisMonth

      prisma.bus.count
        .mockResolvedValueOnce(200) // totalBuses
        .mockResolvedValueOnce(20); // busesThisMonth

      prisma.student.count.mockResolvedValueOnce(5000); // totalStudents

      prisma.gpsLog.findMany.mockResolvedValueOnce([{ busId: 1 }, { busId: 2 }]); // activeLogs

      const res = await request(app)
        .get('/api/admin/stats')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        totalSchools: 50,
        totalBuses: 200,
        offlineDevices: 18, // hardcoded in getSuperAdminStats
        activeDevices: 2,
        stationaryDevices: 180, // 200 - 18 - 2
        totalStudents: 5000,
        schoolsGrowthPercent: Math.round((5 / 45) * 100),
        busesGrowthPercent: Math.round((20 / 180) * 100),
      });

      expect(prisma.school.count).toHaveBeenCalledTimes(2);
      expect(prisma.bus.count).toHaveBeenCalledTimes(2);
      expect(prisma.student.count).toHaveBeenCalledTimes(1);
      expect(prisma.gpsLog.findMany).toHaveBeenCalledTimes(1);
    });

    it('should handle internal server error for SUPER_ADMIN', async () => {
      prisma.school.count.mockRejectedValue(new Error('Database error'));

      const res = await request(app)
        .get('/api/admin/stats')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty('error', 'Internal server error');
    });
  });

  describe('SCHOOL_ADMIN stats', () => {
    let token;
    const schoolId = 'school-123';
    beforeAll(() => {
      token = jwt.sign({ id: 'school-admin-1', role: 'SCHOOL_ADMIN', schoolId }, process.env.JWT_SECRET || 'super-secret');
    });

    it('should return school-specific statistics for SCHOOL_ADMIN', async () => {
      // 1. bus.count total
      prisma.bus.count.mockResolvedValueOnce(50);
      // 2. student.count total
      prisma.student.count.mockResolvedValueOnce(1000);
      // 3. route.count total
      prisma.route.count.mockResolvedValueOnce(10);
      // 4. leaveRequest.count pendingLeaves
      prisma.leaveApplication.count.mockResolvedValueOnce(3);
      // 5. route.count unoptimizedRoutesCount
      prisma.route.count.mockResolvedValueOnce(2);
      // 6. gpsLog.findMany activeBusesLogs
      prisma.gpsLog.findMany.mockResolvedValueOnce([{ busId: 1 }]);
      // 7. bus.count busesThisMonth
      prisma.bus.count.mockResolvedValueOnce(5);
      // 8. student.count studentsThisMonth
      prisma.student.count.mockResolvedValueOnce(100);
      // 9. route.aggregate avgDurationRes
      prisma.route.aggregate.mockResolvedValueOnce({ _avg: { estimatedDuration: 40 } });
      // 10. route.findFirst minRouteRes
      prisma.route.findFirst.mockResolvedValueOnce({ name: 'Short Route', estimatedDuration: 20 });
      // 11. route.count routesWithoutStops
      prisma.route.count.mockResolvedValueOnce(1);

      const res = await request(app)
        .get('/api/admin/stats')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        totalBuses: 50,
        totalStudents: 1000,
        totalRoutes: 10,
        pendingLeaves: 3,
        activeDevices: 1,
        offlineDevices: 49,
        busesGrowthPercent: Math.round((5 / 45) * 100),
        studentsGrowthPercent: Math.round((100 / 900) * 100),
        averageRouteDuration: 40,
        mostEfficientRoute: 'Short Route (20 mins)',
        pendingOptimizations: 2,
      });

      expect(prisma.bus.count).toHaveBeenCalledTimes(2);
      expect(prisma.student.count).toHaveBeenCalledTimes(2);
      expect(prisma.route.count).toHaveBeenCalledTimes(2);
      expect(prisma.leaveApplication.count).toHaveBeenCalledTimes(1);
      expect(prisma.gpsLog.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.route.aggregate).toHaveBeenCalledTimes(1);
      expect(prisma.route.findFirst).toHaveBeenCalledTimes(1);
    });

    it('should use default metrics when bases are zero for SCHOOL_ADMIN', async () => {
      prisma.bus.count.mockResolvedValueOnce(0); // totalBuses
      prisma.student.count.mockResolvedValueOnce(0); // totalStudents
      prisma.route.count.mockResolvedValueOnce(0);
      prisma.leaveApplication.count.mockResolvedValueOnce(0);
      prisma.route.count.mockResolvedValueOnce(0);
      prisma.gpsLog.findMany.mockResolvedValueOnce([]);
      prisma.bus.count.mockResolvedValueOnce(0); // busesThisMonth
      prisma.student.count.mockResolvedValueOnce(0); // studentsThisMonth
      prisma.route.aggregate.mockResolvedValueOnce({ _avg: { estimatedDuration: null } });
      prisma.route.findFirst.mockResolvedValueOnce(null);
      prisma.route.count.mockResolvedValueOnce(0);

      const res = await request(app)
        .get('/api/admin/stats')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        totalBuses: 0,
        totalStudents: 0,
        busesGrowthPercent: 12,
        studentsGrowthPercent: 8,
        averageRouteDuration: 45,
        mostEfficientRoute: 'Morning Route A (35 mins)',
      });
    });
  });
});
