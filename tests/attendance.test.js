const request = require('supertest');
const { app, prisma } = require('../server');
const jwt = require('jsonwebtoken');

// Mock prisma
jest.mock('@prisma/client', () => {
  const mockPrisma = {
    attendanceLog: {
      findMany: jest.fn(),
    },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

describe('GET /api/schools/:schoolId/attendance/today', () => {
  let validToken;

  beforeAll(() => {
    // Create a valid token for testing routes that need authentication
    validToken = jwt.sign(
      { id: 1, role: 'ADMIN', schoolId: 10 },
      process.env.JWT_SECRET || 'super-secret'
    );
  });

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock the date to ensure consistent testing
    jest.useFakeTimers().setSystemTime(new Date('2024-05-15T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should return 401 when no token is provided', async () => {
    const res = await request(app).get('/api/schools/10/attendance/today');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized: Missing or invalid token' });
  });

  it('should return 200 and a list of attendance logs for the provided school ID', async () => {
    const mockLogs = [
      { id: '1', status: 'PRESENT', student: { id: 's1', name: 'Alice' } },
      { id: '2', status: 'ABSENT', student: { id: 's2', name: 'Bob' } },
    ];

    prisma.attendanceLog.findMany.mockResolvedValue(mockLogs);

    const res = await request(app)
      .get('/api/schools/10/attendance/today')
      .set('Authorization', `Bearer ${validToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockLogs);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    expect(prisma.attendanceLog.findMany).toHaveBeenCalledWith({
      where: {
        student: { schoolId: '10' },
        timestamp: { gte: today }
      },
      include: { student: true, trip: { include: { route: true } } }
    });
  });

  it('should return 500 when database throws an error', async () => {
    prisma.attendanceLog.findMany.mockRejectedValue(new Error('Database error'));

    const res = await request(app)
      .get('/api/schools/10/attendance/today')
      .set('Authorization', `Bearer ${validToken}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});
