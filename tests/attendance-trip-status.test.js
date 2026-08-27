const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    trip: { findUnique: jest.fn() },
    student: { findUnique: jest.fn() },
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

const driver = jwt.sign({ id: 'driver-1', role: 'DRIVER' }, SECRET);
const admin = jwt.sign({ id: 'a1', role: 'SCHOOL_ADMIN', schoolId: 'school-1' }, SECRET);

const post = (who) =>
  request(app)
    .post('/api/attendance')
    .set('Authorization', `Bearer ${who}`)
    .send({ studentId: STUDENT, tripId: TRIP, type: 'BOARDED' });

const tripInState = (status) => ({
  id: TRIP, status, driverId: 'driver-1', route: { schoolId: 'school-1' },
});

describe('POST /api/attendance — the trip has to be happening', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.student.findUnique.mockResolvedValue({
      id: STUDENT, schoolId: 'school-1', name: 'Asha', parentId: null, parent: null,
    });
    prisma.attendanceLog.findFirst.mockResolvedValue(null);
    prisma.attendanceLog.create.mockResolvedValue({ id: 'log-1', type: 'BOARDED' });
  });

  // The bug as reported: a driver marked a child aboard a trip that was never started.
  // No departure time, no GPS track, and a real "your child boarded" push to a parent
  // about a bus standing still.
  it('refuses a driver marking attendance on a trip that has not started', async () => {
    prisma.trip.findUnique.mockResolvedValue(tripInState('PLANNED'));

    const res = await post(driver);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/start the trip/i);
    expect(prisma.attendanceLog.create).not.toHaveBeenCalled();
  });

  it('refuses an admin on a not-started trip too — nobody has boarded anything', async () => {
    prisma.trip.findUnique.mockResolvedValue(tripInState('PLANNED'));
    expect((await post(admin)).status).toBe(409);
    expect(prisma.attendanceLog.create).not.toHaveBeenCalled();
  });

  it('refuses everyone on a cancelled trip', async () => {
    prisma.trip.findUnique.mockResolvedValue(tripInState('CANCELLED'));
    expect((await post(driver)).status).toBe(409);
    expect((await post(admin)).status).toBe(409);
    expect(prisma.attendanceLog.create).not.toHaveBeenCalled();
  });

  it('accepts a running trip', async () => {
    prisma.trip.findUnique.mockResolvedValue(tripInState('ON_SCHEDULE'));
    expect((await post(driver)).status).toBe(200);
    expect(prisma.attendanceLog.create).toHaveBeenCalled();
  });

  // A late bus is still carrying children.
  it('accepts a delayed trip', async () => {
    prisma.trip.findUnique.mockResolvedValue(tripInState('DELAYED'));
    expect((await post(driver)).status).toBe(200);
  });

  // Once a driver has ended a run, a missed scan is a records question — and records
  // belong to the school, not to the person who already went home.
  it('refuses a driver on a finished trip but allows the office to correct it', async () => {
    prisma.trip.findUnique.mockResolvedValue(tripInState('COMPLETED'));

    const asDriver = await post(driver);
    expect(asDriver.status).toBe(409);
    expect(asDriver.body.error).toMatch(/school office/i);

    expect((await post(admin)).status).toBe(200);
  });
});
