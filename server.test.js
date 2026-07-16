const request = require('supertest');
const { app } = require('./server');

// Mock prisma so we don't hit the actual database

// Mock Prisma client directly
jest.mock('@prisma/client', () => {
  const mPrismaClient = {
    leaveApplication: {
      findMany: jest.fn(),
    },
    $disconnect: jest.fn(),
  };
  return { PrismaClient: jest.fn(() => mPrismaClient) };
});

const { PrismaClient } = require('@prisma/client');
const prismaMock = new PrismaClient();


describe('GET /api/schools/:schoolId/leaves/pending', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should return 200 and a list of pending leaves for the given school', async () => {
    const mockLeaves = [
      { id: '1', studentId: 's1', status: 'PENDING', student: { id: 's1', schoolId: 'school-123' } },
      { id: '2', studentId: 's2', status: 'PENDING', student: { id: 's2', schoolId: 'school-123' } },
    ];

    // Setup the mock to return our test data
    prismaMock.leaveApplication.findMany.mockResolvedValue(mockLeaves);

    const response = await request(app).get('/api/schools/school-123/leaves/pending');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(mockLeaves);
    expect(prismaMock.leaveApplication.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.leaveApplication.findMany).toHaveBeenCalledWith({
      where: { student: { schoolId: 'school-123' }, status: 'PENDING' },
      include: { student: true }
    });
  });

  it('should return 500 when there is a database error', async () => {
    const errorMessage = 'Database connection failed';
    prismaMock.leaveApplication.findMany.mockRejectedValue(new Error(errorMessage));

    const response = await request(app).get('/api/schools/school-123/leaves/pending');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: errorMessage });
    expect(prismaMock.leaveApplication.findMany).toHaveBeenCalledTimes(1);
  });
});
