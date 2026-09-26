// The school's view of its own launch: every family's stage (parent-activation) and one
// exception queue of everything waiting on the office (readiness).

const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    user: { findMany: jest.fn() },
    student: { count: jest.fn(), findMany: jest.fn() },
    passwordResetRequest: { count: jest.fn() },
    route: { count: jest.fn() },
    run: { count: jest.fn() },
    emergencyAlert: { count: jest.fn() },
    trip: { findMany: jest.fn() },
    gpsLog: { findFirst: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const { app, prisma } = require('../server');
const systemHealth = require('../systemHealth');

const SECRET = process.env.JWT_SECRET;
const SCHOOL = '11111111-1111-4111-8111-111111111111';
const admin = jwt.sign({ id: 'a1', role: 'SCHOOL_ADMIN', schoolId: SCHOOL }, SECRET);
const otherAdmin = jwt.sign({ id: 'a2', role: 'SCHOOL_ADMIN', schoolId: 'another' }, SECRET);
const get = (path, token = admin) => request(app).get(path).set('Authorization', `Bearer ${token}`);

const day = 86_400_000;
const parents = () => [
  // Activated, alerts reaching an Android phone.
  { id: 'p1', name: 'A', email: 'a@x.com', phone: '1', mustResetPassword: false, lastLoginAt: new Date(), parentStudents: [{ id: 's1', name: 'Asha', grade: '5', guardianPhone: null, _count: { routeMappings: 1 } }],
    pushDevices: [{ platform: 'ANDROID', provider: 'FCM', enabled: true, lastAcceptedAt: new Date(), lastFailure: null, updatedAt: new Date() }] },
  // Activated, iPhone, Apple push not set up on the server.
  { id: 'p2', name: 'B', email: 'b@x.com', phone: null, mustResetPassword: false, lastLoginAt: new Date(), parentStudents: [{ id: 's2', name: 'Bina', grade: '5', guardianPhone: '98', _count: { routeMappings: 0 } }],
    pushDevices: [{ platform: 'IOS', provider: 'APNS', enabled: true, lastAcceptedAt: null, lastFailure: null, updatedAt: new Date() }] },
  // Activated, never allowed notifications.
  { id: 'p3', name: 'C', email: 'c@x.com', mustResetPassword: false, lastLoginAt: new Date(), parentStudents: [], pushDevices: [] },
  // Invited, code unused.
  { id: 'p4', name: 'D', email: 'd@x.com', mustResetPassword: true, inviteSentAt: new Date(Date.now() - day), inviteExpiresAt: new Date(Date.now() + day), inviteChannel: 'WHATSAPP', parentStudents: [], pushDevices: [] },
  // Invite ran out.
  { id: 'p5', name: 'E', email: 'e@x.com', mustResetPassword: true, inviteSentAt: new Date(Date.now() - 9 * day), inviteExpiresAt: new Date(Date.now() - 2 * day), inviteChannel: 'EMAIL', parentStudents: [], pushDevices: [] },
  // Never invited.
  { id: 'p6', name: 'F', email: 'f@x.com', mustResetPassword: true, parentStudents: [], pushDevices: [] },
  // Activated, the only phone's token is refused.
  { id: 'p7', name: 'G', email: 'g@x.com', mustResetPassword: false, lastLoginAt: new Date(), parentStudents: [],
    pushDevices: [{ platform: 'ANDROID', provider: 'FCM', enabled: false, lastAcceptedAt: null, lastFailure: 'INVALID_TOKEN', updatedAt: new Date() }] },
];

beforeEach(() => {
  jest.clearAllMocks();
  systemHealth.reset();
  prisma.user.findMany.mockResolvedValue(parents());
  prisma.student.findMany.mockResolvedValue([{ id: 's9', name: 'Orphan', grade: '3', rfidTag: 'R9', guardianPhone: null }]);
  prisma.student.count.mockResolvedValue(0);
  prisma.passwordResetRequest.count.mockResolvedValue(0);
  prisma.route.count.mockResolvedValue(0);
  prisma.run.count.mockResolvedValue(0);
  prisma.emergencyAlert.count.mockResolvedValue(0);
  prisma.trip.findMany.mockResolvedValue([]);
  prisma.gpsLog.findFirst.mockResolvedValue(null);
});

describe('GET /api/schools/:id/parent-activation', () => {
  it('puts every family at one stage, with whether alerts reach their phone', async () => {
    const res = await get(`/api/schools/${SCHOOL}/parent-activation`);

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.parents.map((p) => [p.id, [p.stage, p.push.state]]));
    expect(byId).toEqual({
      p1: ['ACTIVATED', 'DELIVERING'],
      p2: ['ACTIVATED', 'IPHONE_NOT_SENDING'],
      p3: ['ACTIVATED', 'NONE'],
      p4: ['INVITE_SENT', 'NONE'],
      p5: ['INVITE_EXPIRED', 'NONE'],
      p6: ['NOT_INVITED', 'NONE'],
      p7: ['ACTIVATED', 'FAILING'],
    });
    expect(res.body.totals.stages).toEqual({ ACTIVATED: 4, INVITE_SENT: 1, INVITE_EXPIRED: 1, NOT_INVITED: 1 });
    expect(res.body.totals.push).toEqual({ DELIVERING: 1, IPHONE_NOT_SENDING: 1, NONE: 1, FAILING: 1 });
    expect(res.body.studentsWithoutParent).toHaveLength(1);
    expect(res.body.iphonePushConfigured).toBe(false);
  });

  it('uses the child\'s number when the parent has none, for WhatsApp invites', async () => {
    const res = await get(`/api/schools/${SCHOOL}/parent-activation`);
    expect(res.body.parents.find((p) => p.id === 'p2').phone).toBe('98');
    expect(res.body.parents.find((p) => p.id === 'p2').children[0]).toEqual({ id: 's2', name: 'Bina', grade: '5', hasStop: false });
  });

  it('is only for the school\'s own admins', async () => {
    const res = await get(`/api/schools/${SCHOOL}/parent-activation`, otherAdmin);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/schools/:id/readiness', () => {
  it('lists what is waiting, worst first, and nothing that is fine', async () => {
    prisma.student.count.mockImplementation(({ where }) => {
      if (where.parentId === null) return Promise.resolve(1);
      if (where.routeMappings) return Promise.resolve(3);
      if (where.qrCardPrintedAt === null) return Promise.resolve(40);
      return Promise.resolve(120);
    });
    prisma.emergencyAlert.count.mockResolvedValue(1);
    prisma.trip.findMany.mockImplementation(({ where }) => Promise.resolve(where.bus?.status === 'OFFLINE'
      ? [{ id: 't2', bus: { licensePlate: 'BR01 2222' }, route: { name: 'Route 2' } }]
      : [{ id: 't1', startTime: new Date(Date.now() - 10 * 60_000), bus: { id: 'b1', licensePlate: 'BR01 1111', schoolId: SCHOOL }, route: { name: 'Route 1', schoolId: SCHOOL } }]));

    const res = await get(`/api/schools/${SCHOOL}/readiness`);

    expect(res.status).toBe(200);
    const keys = res.body.items.map((i) => [i.severity, i.key, i.count]);
    expect(keys).toEqual([
      ['critical', 'SOS_ACTIVE', 1],
      ['critical', 'TRIP_UNTRACKED', 1],
      ['critical', 'BUS_DARK', 1],
      ['warning', 'STUDENT_NO_STOP', 3],
      ['warning', 'STUDENT_NO_PARENT', 1],
      ['warning', 'PARENT_NOT_INVITED', 1],
      ['warning', 'INVITE_EXPIRED', 1],
      ['warning', 'PUSH_FAILING', 1],
      ['warning', 'CARD_NOT_PRINTED', 40],
      ['info', 'CARD_NEVER_SCANNED', 120],
      ['info', 'PARENT_NO_PUSH', 1],
      ['info', 'IPHONE_PUSH_OFF', 1],
      ['info', 'APP_LINK_MISSING', 1],
    ]);
    expect(res.body.items[1].detail).toMatch(/BR01 1111 \(Route 1\)/);
    expect(res.body.platform).toEqual({ degraded: false, alarms: [] });
  });

  it('tells the school when the platform itself is down, in its own words', async () => {
    const notify = jest.fn();
    systemHealth.noteFix(Date.now() - 30 * 60_000);
    prisma.trip.findMany.mockResolvedValue([]);
    const trips = { trip: { count: jest.fn().mockResolvedValue(3) } };
    await systemHealth.sweepSystemHealth(trips, { notify, gpsSilenceMinutes: 10, pushWindowMinutes: 0 });

    const res = await get(`/api/schools/${SCHOOL}/readiness`);

    expect(res.body.platform.degraded).toBe(true);
    expect(res.body.platform.alarms[0]).toMatchObject({ check: 'GPS_INTAKE', message: expect.stringMatching(/not receiving bus positions from any school/) });
  });
});
