// A check-in the server refused is still a child who may have travelled. The driver
// sends it to the office; the phone keeps it until the office decides.

const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    accountRequest: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
    trip: { findMany: jest.fn() },
    student: { findMany: jest.fn() },
    user: { findMany: jest.fn() },
    notification: { createMany: jest.fn() },
    attendanceLog: { createMany: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const { app, prisma } = require('../server');

const SECRET = process.env.JWT_SECRET;
const SCHOOL = '11111111-1111-4111-8111-111111111111';
const TRIP = '99999999-9999-4999-8999-999999999999';
const STUDENT = '66666666-6666-4666-8666-666666666666';
const driver = jwt.sign({ id: 'd1', role: 'DRIVER', schoolId: SCHOOL }, SECRET);
const admin = jwt.sign({ id: 'a1', role: 'SCHOOL_ADMIN', schoolId: SCHOOL }, SECRET);
const otherAdmin = jwt.sign({ id: 'a2', role: 'SCHOOL_ADMIN', schoolId: 'another' }, SECRET);

const scan = { studentId: STUDENT, tripId: TRIP, type: 'BOARDED', occurredAt: '2026-09-27T02:12:00.000Z', source: 'SCAN', reason: 'The trip was not running at that time', idempotencyKey: `${TRIP}.${STUDENT}.BOARDED.1` };
const submit = (body = { scans: [scan], clientKey: 'phone-case-0001' }, token = driver) =>
  request(app).post('/api/attendance/review-cases').set('Authorization', `Bearer ${token}`).send(body);

beforeEach(() => {
  jest.clearAllMocks();
  prisma.accountRequest.findFirst.mockResolvedValue(null);
  prisma.trip.findMany.mockResolvedValue([{ id: TRIP, driverId: 'd1', route: { name: 'Route 1', schoolId: SCHOOL } }]);
  prisma.student.findMany.mockResolvedValue([{ id: STUDENT, name: 'Asha', grade: '5B' }]);
  prisma.accountRequest.create.mockImplementation(({ data }) => Promise.resolve({ id: 'case-1', ...data }));
  prisma.user.findMany.mockResolvedValue([{ id: 'a1' }]);
  prisma.notification.createMany.mockResolvedValue({ count: 1 });
});

describe('the driver sends refused check-ins', () => {
  it('opens one case for the school, with every scan, and tells the office', async () => {
    const res = await submit();

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ caseId: 'case-1', status: 'PENDING' });
    const { data } = prisma.accountRequest.create.mock.calls[0][0];
    expect(data).toMatchObject({ userId: 'd1', schoolId: SCHOOL, type: 'ATTENDANCE_REVIEW', status: 'PENDING' });
    const body = JSON.parse(data.message);
    expect(body.scans[0]).toMatchObject({ studentName: 'Asha', routeName: 'Route 1', reason: 'The trip was not running at that time' });
    expect(prisma.notification.createMany.mock.calls[0][0].data[0]).toMatchObject({ userId: 'a1', title: 'Refused check-ins to review' });
  });

  it('a retry after a lost reply finds the same case', async () => {
    prisma.accountRequest.findFirst.mockResolvedValue({ id: 'case-1', status: 'PENDING' });
    const res = await submit();
    expect(res.body).toMatchObject({ caseId: 'case-1', duplicate: true });
    expect(prisma.accountRequest.create).not.toHaveBeenCalled();
  });

  it('only for the driver\'s own trips', async () => {
    prisma.trip.findMany.mockResolvedValue([{ id: TRIP, driverId: 'someone-else', route: { name: 'Route 1', schoolId: SCHOOL } }]);
    const res = await submit();
    expect(res.status).toBe(403);
    expect(prisma.accountRequest.create).not.toHaveBeenCalled();
  });

  it('only from a driver', async () => {
    expect((await submit(undefined, admin)).status).toBe(403);
  });

  it('the phone can ask what became of its cases', async () => {
    prisma.accountRequest.findMany.mockResolvedValue([{ id: 'case-1', status: 'RESOLVED', decisionReason: 'Recorded', updatedAt: new Date() }]);
    const res = await request(app).get('/api/attendance/review-cases?ids=case-1').set('Authorization', `Bearer ${driver}`);
    expect(res.status).toBe(200);
    expect(prisma.accountRequest.findMany.mock.calls[0][0].where).toMatchObject({ type: 'ATTENDANCE_REVIEW', userId: 'd1', id: { in: ['case-1'] } });
  });
});

describe('the office decides', () => {
  const pending = () => ({ id: 'case-1', type: 'ATTENDANCE_REVIEW', status: 'PENDING', schoolId: SCHOOL, userId: 'd1', message: JSON.stringify({ scans: [scan] }) });
  const decide = (body, token = admin) => request(app).patch('/api/attendance/review-cases/case-1').set('Authorization', `Bearer ${token}`).send(body);

  it('lists the school\'s open cases, readable', async () => {
    prisma.accountRequest.findMany.mockResolvedValue([{ ...pending(), createdAt: new Date(), updatedAt: new Date(), user: { name: 'Ravi' } }]);
    const res = await request(app).get(`/api/schools/${SCHOOL}/attendance-review`).set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ id: 'case-1', driverName: 'Ravi', status: 'PENDING', scans: [expect.objectContaining({ studentId: STUDENT })] });
  });

  it('writes the scans into the record as office corrections when asked', async () => {
    prisma.accountRequest.findUnique.mockResolvedValue(pending());
    prisma.attendanceLog.createMany.mockResolvedValue({ count: 1 });
    prisma.accountRequest.update.mockImplementation(({ data }) => Promise.resolve({ ...pending(), ...data }));

    const res = await decide({ status: 'RESOLVED', reason: 'Checked with the driver: she did board', record: true });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'RESOLVED', recorded: 1 });
    const { data, skipDuplicates } = prisma.attendanceLog.createMany.mock.calls[0][0];
    expect(skipDuplicates).toBe(true);
    expect(data[0]).toMatchObject({ studentId: STUDENT, tripId: TRIP, type: 'BOARDED', source: 'MANUAL', recordedBy: 'a1' });
    expect(data[0].timestamp.toISOString()).toBe('2026-09-27T02:12:00.000Z');
  });

  it('can close a case without touching the record', async () => {
    prisma.accountRequest.findUnique.mockResolvedValue(pending());
    prisma.accountRequest.update.mockImplementation(({ data }) => Promise.resolve({ ...pending(), ...data }));
    const res = await decide({ status: 'REJECTED', reason: 'Child was absent today' });
    expect(res.body).toMatchObject({ status: 'REJECTED', recorded: 0 });
    expect(prisma.attendanceLog.createMany).not.toHaveBeenCalled();
  });

  it('decides once', async () => {
    prisma.accountRequest.findUnique.mockResolvedValue({ ...pending(), status: 'RESOLVED' });
    expect((await decide({ status: 'RESOLVED', reason: 'again' })).status).toBe(409);
  });

  it('only for the school\'s own admins', async () => {
    prisma.accountRequest.findUnique.mockResolvedValue(pending());
    expect((await decide({ status: 'RESOLVED', reason: 'x' }, otherAdmin)).status).toBe(403);
  });
});
