const request = require('supertest');
const { app, prisma } = require('../server');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    attendanceLog: { findMany: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const SECRET = process.env.JWT_SECRET;

describe('GET /api/schools/:schoolId/attendance/today', () => {
  let superToken;

  beforeAll(() => {
    superToken = jwt.sign({ id: '1', role: 'SUPER_ADMIN' }, SECRET);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date('2024-05-15T12:00:00Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('should return 401 when no token is provided', async () => {
    const res = await request(app).get('/api/schools/10/attendance/today');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized: missing or invalid token' });
  });

  it('should return 403 when a SCHOOL_ADMIN queries another school', async () => {
    const adminA = jwt.sign({ id: 'a1', role: 'SCHOOL_ADMIN', schoolId: 'school-A' }, SECRET);
    const res = await request(app).get('/api/schools/school-B/attendance/today').set('Authorization', `Bearer ${adminA}`);
    expect(res.status).toBe(403);
  });

  it('should return 200 and attendance logs for the school', async () => {
    const mockLogs = [{ id: '1', student: { id: 's1', name: 'Alice' } }];
    prisma.attendanceLog.findMany.mockResolvedValue(mockLogs);

    const res = await request(app).get('/api/schools/10/attendance/today').set('Authorization', `Bearer ${superToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockLogs);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    expect(prisma.attendanceLog.findMany).toHaveBeenCalledWith({
      where: { student: { schoolId: '10' }, timestamp: { gte: today } },
      include: { student: true, trip: { include: { route: true } } },
    });
  });

  it('should return 500 when database throws an error', async () => {
    prisma.attendanceLog.findMany.mockRejectedValue(new Error('Database error'));
    const res = await request(app).get('/api/schools/10/attendance/today').set('Authorization', `Bearer ${superToken}`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});
