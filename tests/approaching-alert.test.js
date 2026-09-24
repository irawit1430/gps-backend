// Two parent alerts about the bus's timing:
//  - "Approaching your stop" was a switch in the parent app that nothing ever sent.
//  - A driver's "running late" went out as a push titled "Emergency alert" and a red
//    emergency banner, and ignored the app's "Delays" switch.

const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    trip: { findUnique: jest.fn(), findMany: jest.fn() },
    route: { findUnique: jest.fn() },
    studentRouteMapping: { findMany: jest.fn() },
    attendanceLog: { findMany: jest.fn() },
    leaveApplication: { findMany: jest.fn() },
    notification: { create: jest.fn() },
    user: { findMany: jest.fn(), updateMany: jest.fn() },
    pushDevice: { findMany: jest.fn(), updateMany: jest.fn() },
    emergencyAlert: { create: jest.fn(), findMany: jest.fn() },
    incidentAcknowledgement: { findMany: jest.fn() },
    student: { findMany: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});
jest.mock('../firebase', () => ({
  sendPush: jest.fn().mockResolvedValue({ invalidTokens: [], accepted: [], failed: [] }),
  isPushConfigured: jest.fn(() => true),
  syncGpsLogToFirebase: jest.fn(),
  syncEmergencyAlertToFirebase: jest.fn(),
  syncStudentToFirebase: jest.fn(),
  flushFirestore: jest.fn(),
  app: null, db: null, messaging: null,
}));

const { app, prisma } = require('../server');
const liveEta = require('../liveEta');
const { sendPush } = require('../firebase');

const SECRET = process.env.JWT_SECRET;
const bearer = (claims) => `Bearer ${jwt.sign(claims, SECRET)}`;

// Four stops about 1.1 km apart: A 0, B 4, C 8, D 12 minutes into the morning.
const at = (lngOffset) => ({ lat: 12.97, lng: 77.6 + lngOffset });
const route = {
  geometry: null,
  stops: [['A', 0, 0], ['B', 0.01, 4], ['C', 0.02, 8], ['D', 0.03, 12]]
    .map(([id, off, minutes], orderIdx) => ({ id, ...at(off), expectedArrivalMinutes: minutes, orderIdx })),
};
const mapping = (stop, studentId, parentId, settings = null, direction = null) => ({
  routeStopId: stop, studentId, direction, routeStop: { name: `Stop ${stop}` },
  student: { name: `${studentId} Kumar`, parentId, parent: { notificationSettings: settings } },
});

describe('approaching your stop', () => {
  let n = 0, trip;
  const fix = (lngOffset, minutesIn) =>
    liveEta.onFix(prisma, { tripId: trip.id, ...at(lngOffset), at: new Date(Date.now() - (10 - minutesIn) * 60_000) });

  beforeEach(() => {
    jest.clearAllMocks();
    liveEta.clear();
    trip = { id: `t-${++n}`, routeId: 'r1', direction: 'TO_SCHOOL', status: 'ON_SCHEDULE',
      startTime: new Date(Date.now() - 10 * 60_000), scheduledStart: null };
    prisma.trip.findUnique.mockImplementation(async () => trip);
    prisma.route.findUnique.mockResolvedValue(route);
    prisma.attendanceLog.findMany.mockResolvedValue([]);
    prisma.leaveApplication.findMany.mockResolvedValue([]);
    prisma.notification.create.mockImplementation(async ({ data }) => ({ id: `n-${data.userId}`, ...data }));
    prisma.user.findMany.mockImplementation(async ({ where }) => where.id.in.map((id) => ({ id, fcmToken: `tok-${id}`, notificationSettings: null })));
    prisma.pushDevice.findMany.mockResolvedValue([]);
    prisma.studentRouteMapping.findMany.mockImplementation(async ({ where }) =>
      [mapping('B', 'asha', 'p1'), mapping('C', 'ravi', 'p2')].filter((m) => where.routeStopId.in.includes(m.routeStopId)));
  });

  it("tells the families at the stop the bus is 5 minutes from, and nobody further on", async () => {
    await fix(0.005, 2); // halfway to B: B is 2 min away, C is 7

    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    expect(prisma.notification.create.mock.calls[0][0].data).toEqual({
      userId: 'p1', type: 'ARRIVAL', title: 'Bus almost at your stop',
      message: "asha's bus is about 2 min from Stop B.",
      context: { type: 'APPROACHING', tripId: trip.id, stopId: 'B' },
      eventKey: `approaching:${trip.id}:B:p1`,
    });
    expect(sendPush).toHaveBeenCalledWith(['tok-p1'], expect.objectContaining({ title: 'Bus almost at your stop' }));
  });

  it('tells each family once, however many fixes follow', async () => {
    await fix(0.005, 2);
    await fix(0.006, 3);
    await fix(0.012, 5); // past B, now 3 min from C

    const told = prisma.notification.create.mock.calls.map(([{ data }]) => `${data.userId}@${data.context.stopId}`);
    expect(told).toEqual(['p1@B', 'p2@C']);
  });

  it('does not repeat itself after a restart', async () => {
    prisma.notification.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));

    await fix(0.005, 2);

    expect(sendPush).not.toHaveBeenCalled();
  });

  it("respects the parent's switch", async () => {
    prisma.studentRouteMapping.findMany.mockResolvedValue([mapping('B', 'asha', 'p1', { geofenceAlerts: false })]);

    await fix(0.005, 2);

    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it('skips a child already scanned or on leave', async () => {
    prisma.studentRouteMapping.findMany.mockResolvedValue([mapping('B', 'asha', 'p1'), mapping('B', 'dev', 'p3')]);
    prisma.attendanceLog.findMany.mockResolvedValue([{ studentId: 'asha', type: 'NO_SHOW' }]);
    prisma.leaveApplication.findMany.mockResolvedValue([{ studentId: 'dev', direction: null }]);

    await fix(0.005, 2);

    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it('on the way home, tells only families whose child is on the bus', async () => {
    trip.direction = 'FROM_SCHOOL';
    // Homeward the bus starts at D; C is 4 min in, B 9.
    prisma.studentRouteMapping.findMany.mockResolvedValue([mapping('C', 'asha', 'p1'), mapping('C', 'ravi', 'p2')]);
    prisma.attendanceLog.findMany.mockResolvedValue([{ studentId: 'asha', type: 'BOARDED' }]);

    await fix(0.028, 1);

    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    expect(prisma.notification.create.mock.calls[0][0].data).toMatchObject({
      userId: 'p1', title: 'Almost home',
      message: "asha's bus is about 3 min from Stop C. Please be there to meet them.",
    });
  });

  it('asks only for the stop mappings of the leg that is running', async () => {
    trip.direction = 'FROM_SCHOOL';
    await fix(0.028, 1);

    expect(prisma.studentRouteMapping.findMany.mock.calls[0][0].where.OR).toEqual([{ direction: null }, { direction: 'FROM_SCHOOL' }]);
  });
});

describe('a driver reporting a delay', () => {
  const TRIP = '11111111-1111-4111-8111-111111111111';
  const DRIVER = bearer({ id: 'd1', role: 'DRIVER', schoolId: 's1' });

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.trip.findUnique.mockResolvedValue({
      id: TRIP, driverId: 'd1', route: { schoolId: 's1', stops: [{ studentMappings: [{ student: { parentId: 'p1' } }, { student: { parentId: 'p2' } }] }] },
    });
    prisma.emergencyAlert.create.mockImplementation(async ({ data }) => ({ id: 'al-1', ...data }));
    prisma.user.findMany.mockImplementation(async ({ where }) => where.id.in.map((id) => ({
      id, fcmToken: `tok-${id}`, notificationSettings: id === 'p2' ? { delayAlerts: false } : null,
    })));
    prisma.pushDevice.findMany.mockResolvedValue([]);
    prisma.notification.create.mockImplementation(async ({ data }) => ({ id: `n-${data.userId}`, ...data }));
  });

  it("reaches parents as a delay, not an emergency, and only those who want delays", async () => {
    const res = await request(app).post('/api/alerts/sos').set('Authorization', DRIVER)
      .send({ type: 'DELAY', message: '10 min late — traffic', tripId: TRIP });

    expect(res.status).toBe(200);
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    expect(prisma.notification.create.mock.calls[0][0].data).toMatchObject({
      userId: 'p1', type: 'DELAY', title: 'Bus running late', message: '10 min late — traffic',
    });
    const titles = sendPush.mock.calls.map(([, payload]) => payload.title);
    expect(titles).toEqual(['Bus running late']);
  });

  it('still raises a real SOS as an emergency', async () => {
    await request(app).post('/api/alerts/sos').set('Authorization', DRIVER).send({ type: 'DRIVER_SOS', tripId: TRIP });

    expect(sendPush.mock.calls.map(([, payload]) => payload.title)).toEqual(['Emergency alert']);
  });

  it("is left out of the parent's emergency list", async () => {
    prisma.student.findMany.mockResolvedValue([{ id: 'c1', schoolId: 's1', routeMappings: [{ direction: null, routeStop: { routeId: 'r1' } }] }]);
    prisma.trip.findMany.mockResolvedValue([{ id: TRIP, routeId: 'r1', direction: null }]);
    prisma.emergencyAlert.findMany.mockResolvedValue([]);
    prisma.incidentAcknowledgement.findMany.mockResolvedValue([]);

    await request(app).get('/api/parents/p1/alerts').set('Authorization', bearer({ id: 'p1', role: 'PARENT', schoolId: 's1' }));

    expect(prisma.emergencyAlert.findMany.mock.calls[0][0].where.type).toEqual({ not: 'DELAY' });
  });
});
