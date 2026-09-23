const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(() => ({
    student: { findMany: jest.fn() },
    attendanceLog: { findMany: jest.fn() },
    leaveApplication: { findMany: jest.fn() },
  })),
}));

const { app, prisma } = require('../server');
const token = jwt.sign({ id: 'parent-audit', role: 'PARENT' }, process.env.JWT_SECRET);

// Times relative to now make this suite independent of the date and machine timezone.
// "Now" itself is pinned to midday in the school's zone. Trips here start up to 40
// minutes ago, and the server only considers trips from the school's current day, so
// with the real clock the suite failed every night from 00:00 to 00:40 IST.
const NOW = new Date('2026-09-22T06:30:00Z'); // 12:00 IST
beforeAll(() => {
  // Only the clock: supertest and the server still need real timers.
  jest.useFakeTimers({
    now: NOW,
    doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'],
  });
});
afterAll(() => jest.useRealTimers());
const ago = (minutes) => new Date(NOW.getTime() - minutes * 60_000);
const trip = (overrides = {}) => ({
  id: 'afternoon-trip', routeId: 'route-1', direction: 'FROM_SCHOOL',
  status: 'ON_SCHEDULE', startTime: ago(10), scheduledStart: ago(10),
  createdAt: ago(120), endTime: null, busId: 'bus-1',
  bus: { licensePlate: 'KA01' }, driver: { name: 'Ravi' }, ...overrides,
});
const mapping = (trips, direction = 'FROM_SCHOOL') => ({
  direction,
  routeStop: {
    id: 'home-stop', name: 'Home stop', routeId: 'route-1', lat: 12, lng: 77,
    expectedArrivalMinutes: 20, route: { id: 'route-1', trips },
  },
});
const seedChild = (mappings) => prisma.student.findMany.mockResolvedValue([{
  id: 'child-audit', parentId: 'parent-audit', name: 'Asha',
  school: { timezone: 'Asia/Kolkata' }, routeMappings: mappings,
}]);
const getChild = async () => {
  const response = await request(app).get('/api/parents/parent-audit/students')
    .set('Authorization', `Bearer ${token}`);
  expect(response.status).toBe(200);
  expect(response.body).toHaveLength(1);
  return response.body[0];
};
const scan = (tripId, type, minutesAgo) => ({
  studentId: 'child-audit', tripId, type, timestamp: ago(minutesAgo), source: 'QR',
});

beforeEach(() => {
  jest.resetAllMocks();
  prisma.attendanceLog.findMany.mockResolvedValue([]);
  prisma.leaveApplication.findMany.mockResolvedValue([]);
});

describe('parent journey audit: attendance belongs to the selected journey', () => {
  it('uses the selected-trip scan even when an unrelated trip has a newer scan', async () => {
    seedChild([mapping([trip()])]);
    prisma.attendanceLog.findMany.mockResolvedValue([
      scan('morning-trip', 'ALIGHTED', 1),
      scan('afternoon-trip', 'BOARDED', 5),
    ]);
    const child = await getChild();
    expect(child.tripId).toBe('afternoon-trip');
    expect(child.attendance).toMatchObject({ status: 'BOARDED', tripId: 'afternoon-trip' });
  });

  it('reports unknown attendance when all scans belong to another trip', async () => {
    seedChild([mapping([trip()])]);
    prisma.attendanceLog.findMany.mockResolvedValue([scan('morning-trip', 'ALIGHTED', 1)]);
    const child = await getChild();
    expect(child.attendance).toMatchObject({ status: null, tripId: null, at: null });
  });

  it('does not present a historical scan as a current journey without a selected trip', async () => {
    seedChild([mapping([])]);
    prisma.attendanceLog.findMany.mockResolvedValue([scan('morning-trip', 'BOARDED', 1)]);
    const child = await getChild();
    expect(child.tripId).toBeNull();
    expect(child.attendance.status).toBeNull();
  });
});

describe('parent journey audit: the child must ride the selected direction', () => {
  it('examines every trip instead of assigning the first trip from the opposite leg', async () => {
    const wrongLeg = trip({ id: 'wrong-leg', direction: 'TO_SCHOOL', startTime: ago(1) });
    const correctLeg = trip({ id: 'correct-leg', direction: 'FROM_SCHOOL', startTime: ago(10) });
    seedChild([mapping([wrongLeg, correctLeg])]);
    const child = await getChild();
    expect(child.tripId).toBe('correct-leg');
    expect(child.trip.direction).toBe('FROM_SCHOOL');
  });

  it('returns no selected trip when the only trip is for a leg the child does not ride', async () => {
    seedChild([mapping([trip({ direction: 'TO_SCHOOL' })])]);
    const child = await getChild();
    expect(child.tripId).toBeNull();
    expect(child.trip).toBeNull();
  });

  it('retains both-leg mappings for existing families without a direction restriction', async () => {
    seedChild([mapping([trip()], null)]);
    expect((await getChild()).tripId).toBe('afternoon-trip');
  });
});

describe('parent journey audit: a clock estimate cannot confirm arrival', () => {
  it('marks a past stop estimate as overdue and unconfirmed', async () => {
    seedChild([mapping([trip({ startTime: ago(40) })])]);
    const child = await getChild();
    expect(child.etaKind).toBe('SCHEDULE_PROJECTION');
    expect(child.arrivalConfirmed).toBe(false);
    expect(child.overdue).toBe(true);
    expect(child.etaStatus).toBe('OVERDUE_UNCONFIRMED');
    expect(child.etaConfidence).toBe('SCHEDULE_ONLY');
  });

  it('labels a future estimate as a projection without claiming arrival', async () => {
    seedChild([mapping([trip()])]);
    const child = await getChild();
    expect(child.etaKind).toBe('SCHEDULE_PROJECTION');
    expect(child.arrivalConfirmed).toBe(false);
    expect(child.overdue).toBe(false);
    expect(child.etaConfidence).toBe('SCHEDULE_ONLY');
  });
});
