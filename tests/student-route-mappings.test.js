const request = require('supertest');
const { app, prisma } = require('../server');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    studentRouteMapping: { upsert: jest.fn(), findFirst: jest.fn() },
    student: { findUnique: jest.fn() },
    routeStop: { findUnique: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const SECRET = process.env.JWT_SECRET;
const STUDENT_ID = '11111111-1111-1111-1111-111111111111';
const STOP_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_STOP_ID = '33333333-3333-3333-3333-333333333333';

describe('POST /api/student-route-mappings', () => {
  let token;

  beforeAll(() => {
    token = jwt.sign({ id: '1', role: 'SUPER_ADMIN' }, SECRET);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.student.findUnique.mockResolvedValue({ schoolId: 'school-1' });
    // Stop exists and the student is not already on this route, unless a case says so.
    prisma.routeStop.findUnique.mockResolvedValue({ routeId: 'route-1', route: { schoolId: 'school-1' } });
    prisma.studentRouteMapping.findFirst.mockResolvedValue(null);
  });

  const post = (body, t = token) =>
    request(app).post('/api/student-route-mappings').set('Authorization', `Bearer ${t}`).send(body);

  it('should return 400 (validation) when body is empty', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });

  it('should return 400 when studentId is missing', async () => {
    expect((await post({ routeStopId: STOP_ID })).status).toBe(400);
  });

  it('should return 400 when ids are not UUIDs', async () => {
    expect((await post({ studentId: 1, routeStopId: 2 })).status).toBe(400);
  });

  it('should upsert mapping and return it when both are provided', async () => {
    const mockMapping = { studentId: STUDENT_ID, routeStopId: STOP_ID, id: '10' };
    prisma.studentRouteMapping.upsert.mockResolvedValue(mockMapping);

    const res = await post({ studentId: STUDENT_ID, routeStopId: STOP_ID });

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
    const res = await post({ studentId: STUDENT_ID, routeStopId: STOP_ID });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  // The duplicate-roster bug: (studentId, routeStopId) is unique, so re-assigning the
  // SAME stop is idempotent — but a SECOND stop on the same route used to slip through
  // and the student then rendered twice on the driver's roster.
  it('should return 409 when the student is already on another stop of this route', async () => {
    prisma.studentRouteMapping.findFirst.mockResolvedValue({
      routeStop: { id: OTHER_STOP_ID, name: 'Maple Ave' },
    });

    const res = await post({ studentId: STUDENT_ID, routeStopId: STOP_ID });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'Student is already assigned to another stop on this route',
      stopId: OTHER_STOP_ID,
      stopName: 'Maple Ave',
    });
    expect(prisma.studentRouteMapping.upsert).not.toHaveBeenCalled();
  });

  it('scopes the duplicate check to this route, excluding the stop being assigned', async () => {
    prisma.studentRouteMapping.upsert.mockResolvedValue({ id: '10' });
    await post({ studentId: STUDENT_ID, routeStopId: STOP_ID });

    expect(prisma.studentRouteMapping.findFirst).toHaveBeenCalledWith({
      where: { studentId: STUDENT_ID, routeStopId: { not: STOP_ID }, routeStop: { routeId: 'route-1' } },
      select: { routeStop: { select: { id: true, name: true } } },
    });
  });

  it('re-assigning the exact same stop stays idempotent, not a 409', async () => {
    prisma.studentRouteMapping.upsert.mockResolvedValue({ id: '10', routeStopId: STOP_ID });
    const res = await post({ studentId: STUDENT_ID, routeStopId: STOP_ID });
    expect(res.status).toBe(200);
  });

  it('should return 404 for SUPER_ADMIN when the stop does not exist', async () => {
    prisma.routeStop.findUnique.mockResolvedValue(null);
    const res = await post({ studentId: STUDENT_ID, routeStopId: STOP_ID });
    expect(res.status).toBe(404);
    expect(prisma.studentRouteMapping.upsert).not.toHaveBeenCalled();
  });

  it('should return 403, not 404, for a SCHOOL_ADMIN probing a stop that does not exist', async () => {
    const admin = jwt.sign({ id: 'a1', role: 'SCHOOL_ADMIN', schoolId: 'school-1' }, SECRET);
    prisma.student.findUnique.mockResolvedValue({ schoolId: 'school-1' });
    prisma.routeStop.findUnique.mockResolvedValue(null);

    const res = await post({ studentId: STUDENT_ID, routeStopId: STOP_ID }, admin);
    expect(res.status).toBe(403);
  });

  it("should return 403 for a SCHOOL_ADMIN assigning onto another school's route", async () => {
    const admin = jwt.sign({ id: 'a1', role: 'SCHOOL_ADMIN', schoolId: 'school-1' }, SECRET);
    prisma.student.findUnique.mockResolvedValue({ schoolId: 'school-1' });
    prisma.routeStop.findUnique.mockResolvedValue({ routeId: 'route-9', route: { schoolId: 'school-2' } });

    const res = await post({ studentId: STUDENT_ID, routeStopId: STOP_ID }, admin);
    expect(res.status).toBe(403);
    expect(prisma.studentRouteMapping.upsert).not.toHaveBeenCalled();
  });

  it('rejects a SUPER_ADMIN mapping a student and stop from different schools', async () => {
    prisma.student.findUnique.mockResolvedValue({ schoolId: 'school-1' });
    prisma.routeStop.findUnique.mockResolvedValue({ routeId: 'route-9', route: { schoolId: 'school-2' } });

    const res = await post({ studentId: STUDENT_ID, routeStopId: STOP_ID });

    expect(res.status).toBe(400);
    expect(prisma.studentRouteMapping.upsert).not.toHaveBeenCalled();
  });
});
