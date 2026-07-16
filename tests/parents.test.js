const request = require('supertest');
const { app, prisma } = require('../server');

jest.mock('@prisma/client', () => {
  const mPrisma = {
    student: {
      findMany: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
    bus: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    gpsLog: {
      create: jest.fn(),
    },
    leaveApplication: {
      findMany: jest.fn(),
      create: jest.fn(),
    },
    emergencyAlert: {
      create: jest.fn(),
    },
    school: {
      count: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
    },
  };
  return {
    PrismaClient: jest.fn(() => mPrisma)
  };
});

describe('GET /api/parents/:parentId/students', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should return a list of students for a valid parentId', async () => {
    const mockStudents = [
      {
        id: 'student-1',
        name: 'John Doe',
        parentId: 'parent-123',
        routeMappings: []
      },
      {
        id: 'student-2',
        name: 'Jane Doe',
        parentId: 'parent-123',
        routeMappings: []
      }
    ];

    prisma.student.findMany.mockResolvedValue(mockStudents);

    const res = await request(app).get('/api/parents/parent-123/students');

    expect(res.statusCode).toEqual(200);
    expect(res.body).toEqual(mockStudents);
    expect(prisma.student.findMany).toHaveBeenCalledWith({
      where: { parentId: 'parent-123' },
      include: { routeMappings: { include: { routeStop: true } } }
    });
  });

  it('should return 500 if database query fails', async () => {
    prisma.student.findMany.mockRejectedValue(new Error('Database connection error'));

    const res = await request(app).get('/api/parents/parent-123/students');

    expect(res.statusCode).toEqual(500);
    expect(res.body).toEqual({ error: 'Database connection error' });
  });
});
