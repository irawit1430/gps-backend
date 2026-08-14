const request = require('supertest');
const { app, prisma } = require('../server');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    studentRouteMapping: { upsert: jest.fn() },
    student: { findUnique: jest.fn() },
    routeStop: { findUnique: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const SECRET = process.env.JWT_SECRET;
const STUDENT_ID = '11111111-1111-1111-1111-111111111111';
const STOP_ID = '22222222-2222-2222-2222-222222222222';

describe('POST /api/student-route-mappings', () => {
  let token;

  beforeAll(() => {
    token = jwt.sign({ id: '1', role: 'SUPER_ADMIN' }, SECRET);
  });

  beforeEach(() => jest.clearAllMocks());

  it('should return 400 (validation) when body is empty', async () => {
    const res = await request(app).post('/api/student-route-mappings').set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });

  it('should return 400 when studentId is missing', async () => {
    const res = await request(app).post('/api/student-route-mappings').set('Authorization', `Bearer ${token}`).send({ routeStopId: STOP_ID });
    expect(res.status).toBe(400);
  });

  it('should return 400 when ids are not UUIDs', async () => {
    const res = await request(app).post('/api/student-route-mappings').set('Authorization', `Bearer ${token}`).send({ studentId: 1, routeStopId: 2 });
    expect(res.status).toBe(400);
  });

  it('should upsert mapping and return it when both are provided', async () => {
    const mockMapping = { studentId: STUDENT_ID, routeStopId: STOP_ID, id: '10' };
    prisma.studentRouteMapping.upsert.mockResolvedValue(mockMapping);

    const res = await request(app)
      .post('/api/student-route-mappings')
      .set('Authorization', `Bearer ${token}`)
      .send({ studentId: STUDENT_ID, routeStopId: STOP_ID });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockMapping);
    expect(prisma.studentRouteMapping.upsert).toHaveBeenCalledWith({
      where: { studentId_routeStopId: { studentId: STUDENT_ID, routeStopId: STOP_ID } },
      update: {},
      create: { studentId: STUDENT_ID, routeStopId: STOP_ID },
      include: { student: true, routeStop: { include: { route: true } } },
    });
  });

  it('should return 500 when database throws an error', async () => {
    prisma.studentRouteMapping.upsert.mockRejectedValue(new Error('Database error'));
    const res = await request(app)
      .post('/api/student-route-mappings')
      .set('Authorization', `Bearer ${token}`)
      .send({ studentId: STUDENT_ID, routeStopId: STOP_ID });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});
