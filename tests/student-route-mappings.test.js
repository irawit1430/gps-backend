const request = require('supertest');
const { app, prisma } = require('../server');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    studentRouteMapping: {
      upsert: jest.fn(),
    },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

describe('POST /api/student-route-mappings', () => {
  let token;

  beforeAll(() => {
    // Generate a valid token for authentication middleware
    token = jwt.sign({ id: 1, role: 'SUPER_ADMIN', schoolId: 10 }, process.env.JWT_SECRET || 'super-secret');
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 400 when studentId or routeStopId is missing', async () => {
    const res = await request(app)
      .post('/api/student-route-mappings')
      .set('Authorization', `Bearer ${token}`)
      .send({}); // Send empty body

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'studentId and routeStopId are required' });
  });

  it('should return 400 when studentId is missing', async () => {
    const res = await request(app)
      .post('/api/student-route-mappings')
      .set('Authorization', `Bearer ${token}`)
      .send({ routeStopId: 1 });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'studentId and routeStopId are required' });
  });

  it('should return 400 when routeStopId is missing', async () => {
    const res = await request(app)
      .post('/api/student-route-mappings')
      .set('Authorization', `Bearer ${token}`)
      .send({ studentId: 1 });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'studentId and routeStopId are required' });
  });

  it('should upsert mapping and return it when both are provided', async () => {
    const mockMapping = { studentId: 1, routeStopId: 2, id: 10 };
    prisma.studentRouteMapping.upsert.mockResolvedValue(mockMapping);

    const res = await request(app)
      .post('/api/student-route-mappings')
      .set('Authorization', `Bearer ${token}`)
      .send({ studentId: 1, routeStopId: 2 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockMapping);
    expect(prisma.studentRouteMapping.upsert).toHaveBeenCalledWith({
      where: { studentId_routeStopId: { studentId: 1, routeStopId: 2 } },
      update: { routeStopId: 2 },
      create: { studentId: 1, routeStopId: 2 },
      include: { student: true, routeStop: { include: { route: true } } }
    });
  });

  it('should return 500 when database throws an error', async () => {
    prisma.studentRouteMapping.upsert.mockRejectedValue(new Error('Database error'));

    const res = await request(app)
      .post('/api/student-route-mappings')
      .set('Authorization', `Bearer ${token}`)
      .send({ studentId: 1, routeStopId: 2 });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});
