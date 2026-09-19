const request = require('supertest');
const { app, prisma } = require('../server');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    student: { findUnique: jest.fn(), findMany: jest.fn() },
    routeStop: { findUnique: jest.fn() },
    studentRouteMapping: { findFirst: jest.fn(), findMany: jest.fn(), upsert: jest.fn() },
    trip: { findMany: jest.fn(), findFirst: jest.fn() },
    leaveApplication: { findMany: jest.fn() },
    attendanceLog: { findMany: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const SECRET = process.env.JWT_SECRET;
const STUDENT_ID = '33333333-3333-4333-8333-333333333333';
const STOP_ID = '55555555-5555-4555-8555-555555555555';
const admin = () => jwt.sign({ id: 'a1', role: 'SUPER_ADMIN' }, SECRET);
const driver = () => jwt.sign({ id: 'd1', role: 'DRIVER', schoolId: 'school-1' }, SECRET);

beforeEach(() => jest.resetAllMocks());

// A pickup stop and a drop-off stop are two mappings on one route. One per leg is
// allowed; two for the same leg is not; and a mapping with no direction serves both,
// so it collides with everything — the old one-stop-per-route rule, unchanged for
// anyone not using directions.
describe('one stop per student per route per leg', () => {
  beforeEach(() => {
    prisma.student.findUnique.mockResolvedValue({ schoolId: 'school-1' });
    prisma.routeStop.findUnique.mockResolvedValue({ routeId: 'route-1', route: { schoolId: 'school-1' } });
    prisma.studentRouteMapping.upsert.mockResolvedValue({ id: 'm1' });
  });

  const post = (body) =>
    request(app).post('/api/student-route-mappings').set('Authorization', `Bearer ${admin()}`).send(body);

  const conflictQuery = () => prisma.studentRouteMapping.findFirst.mock.calls[0][0].where;

  it('lets a directed stop coexist with the other leg', async () => {
    prisma.studentRouteMapping.findFirst.mockResolvedValue(null);
    const res = await post({ studentId: STUDENT_ID, routeStopId: STOP_ID, direction: 'FROM_SCHOOL' });

    expect(res.status).toBe(200);
    // Only a FROM_SCHOOL or a both-legs mapping can conflict; the morning stop cannot.
    expect(conflictQuery()).toMatchObject({
      OR: [{ direction: null }, { direction: 'FROM_SCHOOL' }],
    });
    expect(prisma.studentRouteMapping.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ direction: 'FROM_SCHOOL' }) })
    );
  });

  it('rejects a second stop for the same leg', async () => {
    prisma.studentRouteMapping.findFirst.mockResolvedValue({
      direction: 'FROM_SCHOOL',
      routeStop: { id: 'other-stop', name: 'Maple Ave' },
    });
    const res = await post({ studentId: STUDENT_ID, routeStopId: STOP_ID, direction: 'FROM_SCHOOL' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Student already has a drop-off stop on this route');
    expect(res.body.conflictingDirection).toBe('FROM_SCHOOL');
    expect(prisma.studentRouteMapping.upsert).not.toHaveBeenCalled();
  });

  // The pre-existing rule, untouched: no direction means both legs.
  it('a both-legs stop still conflicts with any other stop on the route', async () => {
    prisma.studentRouteMapping.findFirst.mockResolvedValue({
      direction: null,
      routeStop: { id: 'other-stop', name: 'Maple Ave' },
    });
    const res = await post({ studentId: STUDENT_ID, routeStopId: STOP_ID });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Student is already assigned to another stop on this route');
    // No direction was sent, so nothing narrows the conflict search.
    expect(conflictQuery().OR).toBeUndefined();
  });

  it('re-posting the same stop with a direction narrows the existing mapping', async () => {
    prisma.studentRouteMapping.findFirst.mockResolvedValue(null);
    await post({ studentId: STUDENT_ID, routeStopId: STOP_ID, direction: 'TO_SCHOOL' });

    expect(prisma.studentRouteMapping.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { direction: 'TO_SCHOOL' } })
    );
  });
});

// The whole point of the column: the driver is handed the children riding THIS leg.
describe('driver roster carries only the children on this leg', () => {
  const mapping = (id, name, direction) => ({
    direction,
    student: { id, name, qrToken: `tok-${id}`, qrCardPrintedAt: new Date() },
  });

  const rosterFor = async (tripDirection) => {
    prisma.trip.findMany.mockResolvedValue([
      {
        id: 't1', direction: tripDirection, driverId: 'd1', status: 'ON_SCHEDULE',
        route: {
          id: 'r1',
          stops: [
            {
              id: 's1', orderIdx: 0, name: 'Oak St',
              studentMappings: [
                mapping('kid-am', 'Morning only', 'TO_SCHOOL'),
                mapping('kid-pm', 'Afternoon only', 'FROM_SCHOOL'),
                mapping('kid-both', 'Both ways', null),
              ],
            },
          ],
        },
        bus: { id: 'b1' },
        attendanceLogs: [],
      },
    ]);
    prisma.leaveApplication.findMany.mockResolvedValue([]);
    const res = await request(app).get('/api/drivers/d1/trips').set('Authorization', `Bearer ${driver()}`);
    expect(res.status).toBe(200);
    return res.body[0].route.stops[0].studentMappings.map((m) => m.student.name);
  };

  it('drops the afternoon-only child from the morning run', async () => {
    expect(await rosterFor('TO_SCHOOL')).toEqual(['Morning only', 'Both ways']);
  });

  it('drops the morning-only child from the afternoon run', async () => {
    expect(await rosterFor('FROM_SCHOOL')).toEqual(['Afternoon only', 'Both ways']);
  });

  // A trip predating the direction column carries everyone, exactly as it used to.
  it('carries everyone when the trip has no direction', async () => {
    expect(await rosterFor(null)).toEqual(['Morning only', 'Afternoon only', 'Both ways']);
  });

  // The leave fan-out reads the roster, so it must see the filtered list.
  it('asks for leaves only for the children actually on this leg', async () => {
    await rosterFor('TO_SCHOOL');
    expect(prisma.leaveApplication.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ studentId: { in: ['kid-am', 'kid-both'] } }),
      })
    );
  });
});

// The stop shown to a parent depends on the leg that is running, not on which mapping
// was saved first.
describe('parent trip labels the stop for the running leg', () => {
  const stop = (id, name) => ({
    id, name, lat: 1, lng: 1, orderIdx: 0, expectedArrivalMinutes: 5, studentMappings: [],
  });

  const tripFor = async (tripDirection) => {
    prisma.student.findUnique.mockResolvedValue({ id: 's1', parentId: 'p1', schoolId: 'school-1' });
    prisma.studentRouteMapping.findMany.mockResolvedValue([
      { direction: 'TO_SCHOOL', routeStop: { id: 'stop-am', routeId: 'r1' } },
      { direction: 'FROM_SCHOOL', routeStop: { id: 'stop-pm', routeId: 'r1' } },
    ]);
    prisma.trip.findFirst.mockResolvedValue({
      id: 't1', routeId: 'r1', direction: tripDirection, status: 'ON_SCHEDULE',
      startTime: new Date(), endTime: null,
      route: { id: 'r1', name: 'Route 1', stops: [stop('stop-am', 'Oak St'), stop('stop-pm', 'Elm St')] },
      bus: { id: 'b1', licensePlate: 'KA01' },
      driver: { name: 'Ravi' },
    });
    prisma.attendanceLog.findMany.mockResolvedValue([]);

    const token = jwt.sign({ id: 'p1', role: 'PARENT' }, SECRET);
    const res = await request(app)
      .get('/api/parents/p1/students/s1/trip')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body.route.stops.find((s) => s.isMyStop)?.id;
  };

  it('marks the pickup stop on the way to school', async () => {
    expect(await tripFor('TO_SCHOOL')).toBe('stop-am');
  });

  it('marks the drop-off stop on the way home', async () => {
    expect(await tripFor('FROM_SCHOOL')).toBe('stop-pm');
  });

  // Both mappings sit on one route, so the trip lookup must consider both.
  it('looks for an active trip across every route the child is mapped to', async () => {
    await tripFor('TO_SCHOOL');
    expect(prisma.trip.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ OR: [
        { routeId: 'r1', direction: 'TO_SCHOOL' },
        { routeId: 'r1', direction: 'FROM_SCHOOL' },
      ] }) })
    );
  });
});
