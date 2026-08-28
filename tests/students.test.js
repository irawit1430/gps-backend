const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app, prisma } = require('../server');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    student: { findMany: jest.fn() },
    attendanceLog: { findMany: jest.fn() },
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
    prisma.attendanceLog.findMany.mockResolvedValue([]); // no scans today unless a case says so
  });

  const get = (schoolId) =>
    request(app).get(`/api/schools/${schoolId}/students`).set('Authorization', `Bearer ${token}`);

  it('should return students with no route assigned', async () => {
    prisma.student.findMany.mockResolvedValue([
      {
        id: 1, rfidTag: 'TAG1', name: 'Student 1', grade: '5th', photoUrl: 'url1',
        guardianPhone: null, parent: null, qrCodeImported: false, routeMappings: [],
      },
    ]);

    const res = await get(1);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: 1, rfidTag: 'TAG1', name: 'Student 1', grade: '5th', photoUrl: 'url1',
        guardianPhone: null, parentName: null, parentPhone: null, qrCodeImported: false,
        assignedRoute: 'Unassigned', routeStopName: 'Unassigned',
        boardingStatus: null, lastCheckIn: null,
      },
    ]);
  });

  it('should return students with route and route stop assigned', async () => {
    prisma.student.findMany.mockResolvedValue([
      {
        id: 2, rfidTag: 'TAG2', name: 'Student 2', grade: '6th', photoUrl: 'url2',
        guardianPhone: null, parent: null,
        routeMappings: [{ routeStop: { name: 'Stop A', route: { name: 'Route 1' } } }],
      },
    ]);

    const res = await get(2);

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ assignedRoute: 'Route 1', routeStopName: 'Stop A' });
  });

  // The parent account's number is the one the office dials; guardianPhone is the
  // fallback for families without an account. Shipping only the fallback made the
  // profile modal look like there was no number on file.
  it('carries the parent account contact alongside the guardian fallback', async () => {
    prisma.student.findMany.mockResolvedValue([
      {
        id: 3, rfidTag: 'TAG3', name: 'Student 3', grade: '4th', photoUrl: null,
        guardianPhone: '9990001111',
        parent: { name: 'Asha Devi', phone: '9998887777' },
        routeMappings: [],
      },
    ]);

    const res = await get(1);

    expect(res.body[0]).toMatchObject({
      guardianPhone: '9990001111',
      parentName: 'Asha Devi',
      parentPhone: '9998887777',
    });
  });

  // These two were the literals 'Absent' and '--:--', so every child in every school
  // read as absent forever, whatever the scans said.
  it('reports the latest scan of the day, not a hardcoded Absent', async () => {
    const at = new Date('2026-08-28T07:38:12.000Z');
    prisma.student.findMany.mockResolvedValue([
      { id: 4, rfidTag: 'T4', name: 'S4', grade: null, photoUrl: null, guardianPhone: null, parent: null, routeMappings: [] },
      { id: 5, rfidTag: 'T5', name: 'S5', grade: null, photoUrl: null, guardianPhone: null, parent: null, routeMappings: [] },
    ]);
    prisma.attendanceLog.findMany.mockResolvedValue([
      { studentId: 4, type: 'ALIGHTED', timestamp: new Date('2026-08-28T08:15:00.000Z') },
      { studentId: 4, type: 'BOARDED', timestamp: at }, // older; must not win
    ]);

    const res = await get(1);

    // latest wins for a child who has scans
    expect(res.body[0]).toMatchObject({
      boardingStatus: 'ALIGHTED',
      lastCheckIn: '2026-08-28T08:15:00.000Z',
    });
    // and a child with no scan is unknown, NOT absent
    expect(res.body[1]).toMatchObject({ boardingStatus: null, lastCheckIn: null });
  });

  it('scopes the attendance lookup to this school and to today', async () => {
    prisma.student.findMany.mockResolvedValue([]);
    await get('school-9');

    const where = prisma.attendanceLog.findMany.mock.calls[0][0].where;
    expect(where.student).toEqual({ schoolId: 'school-9' });
    expect(where.timestamp.gte).toBeInstanceOf(Date);
    expect(where.timestamp.gte.getHours()).toBe(0);
  });

  // Pulling `route: true` dragged the whole row — including the OSRM polyline — for
  // every student, to read two names.
  it('does not fetch whole route rows', async () => {
    prisma.student.findMany.mockResolvedValue([]);
    await get(1);

    const include = prisma.student.findMany.mock.calls[0][0].include;
    expect(include.routeMappings.include.routeStop.select.route.select).toEqual({ name: true });
    expect(include.parent.select).toEqual({ name: true, phone: true });
  });

  it('should return 500 when database throws an error', async () => {
    prisma.student.findMany.mockRejectedValue(new Error('Database error'));
    const res = await get(1);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});
