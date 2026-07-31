const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app, prisma } = require('../server');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    student: {
      findMany: jest.fn(),
    },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

describe('GET /api/schools/:schoolId/students', () => {
  let token;

  beforeAll(() => {
    token = jwt.sign({ id: 1, role: 'SUPER_ADMIN' }, process.env.JWT_SECRET || 'super-secret');
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return students with no route assigned', async () => {
    const mockStudents = [
      {
        id: 1,
        rfidTag: 'TAG1',
        name: 'Student 1',
        grade: '5th',
        photoUrl: 'url1',
        routeMappings: []
      }
    ];
    prisma.student.findMany.mockResolvedValue(mockStudents);

    const res = await request(app)
      .get('/api/schools/1/students')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: 1,
        rfidTag: 'TAG1',
        name: 'Student 1',
        grade: '5th',
        photoUrl: 'url1',
        assignedRoute: 'Unassigned',
        routeStopName: 'Unassigned',
        boardingStatus: 'Absent',
        lastCheckIn: '--:--'
      }
    ]);
    expect(prisma.student.findMany).toHaveBeenCalledWith({
      where: { schoolId: '1' },
      include: { routeMappings: { include: { routeStop: { include: { route: true } } } } }
    });
  });

  it('should return students with route and route stop assigned', async () => {
    const mockStudents = [
      {
        id: 2,
        rfidTag: 'TAG2',
        name: 'Student 2',
        grade: '6th',
        photoUrl: 'url2',
        routeMappings: [
          {
            routeStop: {
              name: 'Stop A',
              route: {
                name: 'Route 1'
              }
            }
          }
        ]
      }
    ];
    prisma.student.findMany.mockResolvedValue(mockStudents);

    const res = await request(app)
      .get('/api/schools/2/students')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: 2,
        rfidTag: 'TAG2',
        name: 'Student 2',
        grade: '6th',
        photoUrl: 'url2',
        assignedRoute: 'Route 1',
        routeStopName: 'Stop A',
        boardingStatus: 'Absent',
        lastCheckIn: '--:--'
      }
    ]);
  });

  it('should return 500 when database throws an error', async () => {
    prisma.student.findMany.mockRejectedValue(new Error('Database error'));

    const res = await request(app)
      .get('/api/schools/1/students')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});
