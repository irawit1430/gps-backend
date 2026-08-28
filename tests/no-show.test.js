const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    trip: { findUnique: jest.fn() },
    student: { findUnique: jest.fn() },
    attendanceLog: { findFirst: jest.fn(), create: jest.fn() },
    leaveApplication: { findFirst: jest.fn() },
    notification: { create: jest.fn() },
    user: { findMany: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

jest.mock('../firebase', () => ({
  sendPush: jest.fn().mockResolvedValue({ sent: 0, invalidTokens: [] }),
  isPushConfigured: jest.fn(() => true),
  syncGpsLogToFirebase: jest.fn(),
  syncEmergencyAlertToFirebase: jest.fn(),
  syncStudentToFirebase: jest.fn(),
  flushFirestore: jest.fn(),
  app: null, db: null, messaging: null,
}));

const { app, prisma } = require('../server');
const SECRET = process.env.JWT_SECRET;
const U = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const STUDENT = U(1);
const TRIP = U(2);

const driver = jwt.sign({ id: 'driver-1', role: 'DRIVER' }, SECRET);
const admin = jwt.sign({ id: 'a1', role: 'SCHOOL_ADMIN', schoolId: 'school-1' }, SECRET);

const mark = (who, body) =>
  request(app).post('/api/attendance').set('Authorization', `Bearer ${who}`)
    .send({ studentId: STUDENT, tripId: TRIP, ...body });

describe('POST /api/attendance — no-show and source', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.trip.findUnique.mockResolvedValue({
      id: TRIP, status: 'ON_SCHEDULE', driverId: 'driver-1', route: { schoolId: 'school-1' },
    });
    prisma.student.findUnique.mockResolvedValue({
      id: STUDENT, schoolId: 'school-1', name: 'Asha', parentId: 'p1',
      parent: { id: 'p1', notificationSettings: null },
    });
    prisma.attendanceLog.findFirst.mockResolvedValue(null);
    prisma.attendanceLog.create.mockResolvedValue({ id: 'log-1', type: 'NO_SHOW' });
    prisma.notification.create.mockResolvedValue({ id: 'n1' });
    prisma.leaveApplication.findFirst.mockResolvedValue(null);
  });

  it('records a no-show and tells the parent in words they can act on', async () => {
    const res = await mark(driver, { type: 'NO_SHOW' });

    expect(res.status).toBe(200);
    expect(prisma.attendanceLog.create.mock.calls[0][0].data.type).toBe('NO_SHOW');
    const notif = prisma.notification.create.mock.calls[0][0].data;
    expect(notif.title).toMatch(/did not board/i);
    expect(notif.message).toContain('Asha');
  });

  // Every planned absence would otherwise generate one, and the alert becomes noise
  // inside a week — destroying the only notification a parent can still act on.
  it('refuses a no-show for a child on approved leave', async () => {
    prisma.leaveApplication.findFirst.mockResolvedValue({ id: 'leave-1' });

    const res = await mark(driver, { type: 'NO_SHOW' });

    expect(res.status).toBe(409);
    expect(res.body.onLeave).toBe(true);
    expect(prisma.attendanceLog.create).not.toHaveBeenCalled();
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it('does not consult leave for an ordinary boarding', async () => {
    await mark(driver, { type: 'BOARDED' });
    expect(prisma.leaveApplication.findFirst).not.toHaveBeenCalled();
  });

  // An office correction asserts the same fact a scan does, but the parent stopped
  // worrying hours ago — pushing "your child boarded" at 15:02 manufactures alarm.
  it('records a MANUAL correction without notifying the parent', async () => {
    const res = await mark(admin, { type: 'BOARDED', source: 'MANUAL' });

    expect(res.status).toBe(200);
    expect(prisma.attendanceLog.create.mock.calls[0][0].data.source).toBe('MANUAL');
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  // A driver must not be able to record silently.
  it('ignores MANUAL from a driver and notifies as normal', async () => {
    await mark(driver, { type: 'BOARDED', source: 'MANUAL' });

    expect(prisma.attendanceLog.create.mock.calls[0][0].data.source).toBe('SCAN');
    expect(prisma.notification.create).toHaveBeenCalled();
  });

  it('defaults to SCAN when no source is sent', async () => {
    await mark(driver, { type: 'BOARDED' });
    expect(prisma.attendanceLog.create.mock.calls[0][0].data.source).toBe('SCAN');
  });
});
