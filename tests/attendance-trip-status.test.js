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

// The end of a route is where signal dies, so a scan taken offline and flushed after
// the trip ended is the common case, not an edge one. Refusing it loses a boarding
// that really happened — and the driver never finds out, because the queue drops a
// permanent 4xx silently.
describe('POST /api/attendance — late flush from the offline queue', () => {
  const startedAt = new Date('2026-08-28T07:00:00.000Z');
  const endedAt = new Date('2026-08-28T08:21:00.000Z');

  const finishedTrip = {
    id: TRIP, status: 'COMPLETED', driverId: 'driver-1',
    startTime: startedAt, endTime: endedAt, route: { schoolId: 'school-1' },
  };

  const postAt = (who, occurredAt) =>
    request(app)
      .post('/api/attendance')
      .set('Authorization', `Bearer ${who}`)
      .send({ studentId: STUDENT, tripId: TRIP, type: 'BOARDED', occurredAt });

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.student.findUnique.mockResolvedValue({
      id: STUDENT, schoolId: 'school-1', name: 'Asha', parentId: null, parent: null,
    });
    prisma.attendanceLog.findFirst.mockResolvedValue(null);
    prisma.attendanceLog.create.mockResolvedValue({ id: 'log-1', type: 'BOARDED' });
    prisma.trip.findUnique.mockResolvedValue(finishedTrip);
  });

  it('accepts a scan that happened while the trip was running, flushed after it ended', async () => {
    const res = await postAt(driver, '2026-08-28T07:30:00.000Z');

    expect(res.status).toBe(200);
    // and records when it happened, not when it arrived
    expect(prisma.attendanceLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ timestamp: new Date('2026-08-28T07:30:00.000Z') }),
      })
    );
  });

  it('still refuses a scan taken after the trip had already ended', async () => {
    const res = await postAt(driver, '2026-08-28T09:00:00.000Z');
    expect(res.status).toBe(409);
    expect(prisma.attendanceLog.create).not.toHaveBeenCalled();
  });

  it('still refuses a scan taken before the trip departed', async () => {
    expect((await postAt(driver, '2026-08-28T06:30:00.000Z')).status).toBe(409);
  });

  // A phone with a wrong clock must not be able to file boardings into the future.
  it('refuses a scan time in the future', async () => {
    const res = await postAt(driver, new Date(Date.now() + 3600_000).toISOString());
    expect(res.status).toBe(400);
    expect(prisma.attendanceLog.create).not.toHaveBeenCalled();
  });

  it('omitting occurredAt still stamps receipt time, as before', async () => {
    prisma.trip.findUnique.mockResolvedValue(tripInState('ON_SCHEDULE'));
    const res = await post(driver);
    expect(res.status).toBe(200);
    const data = prisma.attendanceLog.create.mock.calls[0][0].data;
    expect(data.timestamp).toBeInstanceOf(Date);
  });
});
