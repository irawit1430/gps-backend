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
        guardianPhone: null, parentId: null, parentName: null, parentEmail: null, parentPhone: null, qrCodeImported: false,
        assignedRoute: 'Unassigned', routeStopName: 'Unassigned', stopTime: null,
        boardingStatus: null, lastCheckIn: null,
        // A child with no assignment has no mappings to act on, but the key is always
        // present so the dashboard never has to guard for undefined.
        mappings: [],
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

  // The profile's "Pickup Time" read "Not provided" for every child: nothing sent one.
  // It is the morning departure plus the stop's minutes from the start of the route.
  describe('pickup time', () => {
    const run = (departure, endDate = '2099-12-31') => ({ departure, endDate: new Date(endDate) });
    const withMapping = (mapping) => prisma.student.findMany.mockResolvedValue([{
      id: 6, rfidTag: 'T6', name: 'S6', grade: null, photoUrl: null, guardianPhone: null, parent: null,
      routeMappings: [{ id: 'm6', direction: null, ...mapping }],
    }]);
    const stop = (expectedArrivalMinutes, runs) => ({
      routeStop: { name: 'Stop A', expectedArrivalMinutes, route: { name: 'Route 1', runs } },
    });
    const pickup = async () => (await get(1)).body[0].stopTime;

    it('asks for the morning departures and the stop timing', async () => {
      withMapping(stop(10, []));
      await get(1);

      const { select } = prisma.student.findMany.mock.calls[0][0].include.routeMappings.include.routeStop;
      expect(select.expectedArrivalMinutes).toBe(true);
      expect(select.route.select.runs).toEqual({
        where: { active: true, direction: 'TO_SCHOOL' }, select: { departure: true, endDate: true },
      });
    });

    it('is the departure plus the minutes to the stop', async () => {
      withMapping(stop(10, [run('07:15')]));
      expect(await pickup()).toBe('07:25');
    });

    it('carries past the hour', async () => {
      withMapping(stop(55, [run('07:15')]));
      expect(await pickup()).toBe('08:10');
    });

    it('lists each different morning time once, earliest first', async () => {
      withMapping(stop(10, [run('08:30'), run('07:15'), run('07:15')]));
      expect(await pickup()).toBe('07:25 / 08:40');
    });

    it('ignores a run whose dates are over', async () => {
      withMapping(stop(10, [run('07:15'), run('06:00', '2020-06-30')]));
      expect(await pickup()).toBe('07:25');
    });

    it.each([
      ['a stop with no timing', stop(null, [run('07:15')])],
      ['a route with no morning run', stop(10, [])],
      ['a drop-off-only stop', { ...stop(10, [run('07:15')]), direction: 'FROM_SCHOOL' }],
    ])('is empty for %s', async (_label, mapping) => {
      withMapping(mapping);
      expect(await pickup()).toBeNull();
    });
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
    // The name, and the morning departures for the pickup time: never the polyline.
    expect(Object.keys(include.routeMappings.include.routeStop.select.route.select)).toEqual(['name', 'runs']);
    // Email is the parent's sign-in, which the office needs to help a locked-out parent.
    expect(include.parent.select).toEqual({ name: true, phone: true, email: true });
  });

  it('should return 500 when database throws an error', async () => {
    prisma.student.findMany.mockRejectedValue(new Error('Database error'));
    const res = await get(1);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});
