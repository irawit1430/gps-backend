// A driver used to be able to record any child in the school as boarded on their trip:
// the only check was "same school". That is a "your child boarded" push to a family
// whose child was never on that bus. Drivers are now held to the trip's roster; the
// office can still record an exception.

const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    trip: { findUnique: jest.fn() },
    student: { findUnique: jest.fn() },
    studentRouteMapping: { findFirst: jest.fn() },
    routeStop: { findFirst: jest.fn() },
    attendanceLog: { findFirst: jest.fn(), create: jest.fn() },
    notification: { create: jest.fn() },
    user: { findMany: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const { app, prisma } = require('../server');

const SECRET = process.env.JWT_SECRET;
const U = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const STUDENT = U(1);
const TRIP = U(2);
const STOP = U(3);

const driver = jwt.sign({ id: 'driver-1', role: 'DRIVER', schoolId: 'school-1' }, SECRET);
const admin = jwt.sign({ id: 'admin-1', role: 'SCHOOL_ADMIN', schoolId: 'school-1' }, SECRET);

const running = (direction) => ({
  id: TRIP, routeId: 'route-1', direction, status: 'ON_SCHEDULE', driverId: 'driver-1',
  startTime: new Date(Date.now() - 60_000), endTime: null, route: { schoolId: 'school-1' },
});

const mark = (who, extra = {}) =>
  request(app).post('/api/attendance').set('Authorization', `Bearer ${who}`)
    .send({ studentId: STUDENT, tripId: TRIP, type: 'BOARDED', ...extra });

beforeEach(() => {
  jest.clearAllMocks();
  prisma.trip.findUnique.mockResolvedValue(running('TO_SCHOOL'));
  prisma.student.findUnique.mockResolvedValue({ id: STUDENT, schoolId: 'school-1', parentId: null, parent: null });
  prisma.attendanceLog.findFirst.mockResolvedValue(null);
  prisma.attendanceLog.create.mockImplementation(async ({ data }) => ({ id: 'log-1', ...data }));
});

describe("a driver records only children on the trip's roster", () => {
  it('refuses a child from the same school who is not on this route', async () => {
    prisma.studentRouteMapping.findFirst.mockResolvedValue(null);

    const res = await mark(driver);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not on this trip's route/);
    expect(prisma.attendanceLog.create).not.toHaveBeenCalled();
  });

  it('records a child on the route', async () => {
    prisma.studentRouteMapping.findFirst.mockResolvedValue({ id: 'mapping-1' });

    const res = await mark(driver);

    expect(res.status).toBe(200);
    expect(prisma.attendanceLog.create).toHaveBeenCalled();
  });

  it("looks only at mappings that ride this trip's leg", async () => {
    prisma.studentRouteMapping.findFirst.mockResolvedValue({ id: 'mapping-1' });

    await mark(driver);

    expect(prisma.studentRouteMapping.findFirst).toHaveBeenCalledWith({
      where: {
        studentId: STUDENT,
        routeStop: { routeId: 'route-1' },
        OR: [{ direction: null }, { direction: 'TO_SCHOOL' }],
      },
      select: { id: true },
    });
  });

  it('takes every mapping on a trip with no direction, as the roster does', async () => {
    prisma.trip.findUnique.mockResolvedValue(running(null));
    prisma.studentRouteMapping.findFirst.mockResolvedValue({ id: 'mapping-1' });

    await mark(driver);

    expect(prisma.studentRouteMapping.findFirst.mock.calls[0][0].where).toEqual({
      studentId: STUDENT,
      routeStop: { routeId: 'route-1' },
    });
  });

  it('lets the school office record a child who took another bus', async () => {
    prisma.studentRouteMapping.findFirst.mockResolvedValue(null);

    const res = await mark(admin);

    expect(res.status).toBe(200);
    expect(prisma.studentRouteMapping.findFirst).not.toHaveBeenCalled();
  });
});

describe('the stop check follows the same leg rule', () => {
  it('accepts a directional stop on a trip with no direction', async () => {
    // The roster shows this child on a direction-less trip, so the stop scan must be
    // accepted too. It used to require a both-legs mapping and answered 400.
    prisma.trip.findUnique.mockResolvedValue(running(null));
    prisma.studentRouteMapping.findFirst.mockResolvedValue({ id: 'mapping-1' });
    prisma.routeStop.findFirst.mockResolvedValue({ id: STOP, name: 'Oak St', lat: 12, lng: 77 });

    const res = await mark(driver, { stopId: STOP });

    expect(res.status).toBe(200);
    expect(prisma.routeStop.findFirst.mock.calls[0][0].where).toEqual({
      id: STOP,
      routeId: 'route-1',
      studentMappings: { some: { studentId: STUDENT } },
    });
  });
});
