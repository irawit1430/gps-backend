const request = require('supertest');
const { app, prisma } = require('../server');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    route: { findUnique: jest.fn() },
    bus: { findUnique: jest.fn() },
    user: { findUnique: jest.fn(), findMany: jest.fn() },
    run: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    trip: { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    leaveApplication: { findMany: jest.fn() },
    student: { findUnique: jest.fn() },
    attendanceLog: { findFirst: jest.fn(), create: jest.fn() },
    notification: { create: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const SECRET = process.env.JWT_SECRET;
const admin = () => jwt.sign({ id: 'a1', role: 'SCHOOL_ADMIN', schoolId: 'school-1' }, SECRET);
const driver = () => jwt.sign({ id: 'd1', role: 'DRIVER', schoolId: 'school-1' }, SECRET);

const stop = (id, orderIdx, name) => ({
  id, orderIdx, name, lat: 1, lng: 1, expectedArrivalMinutes: orderIdx * 5,
  studentMappings: [],
});

beforeEach(() => jest.resetAllMocks());

// The driver app walks the stop list top-down. Pickup order is the stored order, so a
// homebound trip handed that list sends the bus to the houses before the school.
describe('driver roster stop order follows trip direction', () => {
  const rosterFor = async (direction) => {
    prisma.trip.findMany.mockResolvedValue([
      {
        id: 't1', direction, driverId: 'd1', status: 'ON_SCHEDULE',
        route: { id: 'r1', stops: [stop('s1', 0, 'School'), stop('s2', 1, 'Oak St'), stop('s3', 2, 'Elm St')] },
        bus: { id: 'b1' },
        attendanceLogs: [],
      },
    ]);
    prisma.leaveApplication.findMany.mockResolvedValue([]);
    const res = await request(app).get('/api/drivers/d1/trips').set('Authorization', `Bearer ${driver()}`);
    expect(res.status).toBe(200);
    return res.body[0].route.stops.map((s) => s.name);
  };

  it('keeps pickup order on the way to school', async () => {
    expect(await rosterFor('TO_SCHOOL')).toEqual(['School', 'Oak St', 'Elm St']);
  });

  it('reverses the sequence on the way home', async () => {
    expect(await rosterFor('FROM_SCHOOL')).toEqual(['Elm St', 'Oak St', 'School']);
  });

  // Every trip created before direction existed has none; those must not be reordered.
  it('leaves a trip with no direction in pickup order', async () => {
    expect(await rosterFor(null)).toEqual(['School', 'Oak St', 'Elm St']);
  });
});

// The flag the exception reach-forward guard reads, which nothing ever wrote.
describe('hand-editing a trip marks it overridden', () => {
  it('sets isOverridden so a run exception cannot overwrite the edit', async () => {
    prisma.trip.findUnique.mockResolvedValue({
      id: 't1', busId: 'b1', driverId: 'd1', routeId: 'r1',
      route: { id: 'r1', schoolId: 'school-1' },
    });
    prisma.trip.findMany.mockResolvedValue([]);
    prisma.trip.update.mockResolvedValue({ id: 't1', route: { schoolId: 'school-1' } });

    const res = await request(app)
      .put('/api/trips/t1')
      .set('Authorization', `Bearer ${admin()}`)
      .send({ direction: 'FROM_SCHOOL' });

    expect(res.status).toBe(200);
    expect(prisma.trip.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ direction: 'FROM_SCHOOL', isOverridden: true }),
      })
    );
  });
});

// ALIGHTED means "arrived at school" one way and "dropped off at home" the other.
describe('parent wording follows trip direction', () => {
  const scanOn = async (direction) => {
    prisma.trip.findUnique.mockResolvedValue({
      id: 't1', direction, driverId: 'd1', status: 'ON_SCHEDULE',
      startTime: new Date(Date.now() - 600_000), endTime: null,
      route: { schoolId: 'school-1' },
    });
    prisma.student.findUnique.mockResolvedValue({
      id: 's1', name: 'Asha', schoolId: 'school-1',
      parentId: 'p1', parent: { id: 'p1', notificationSettings: null },
    });
    prisma.attendanceLog.create.mockResolvedValue({ id: 'log-1' });
    prisma.notification.create.mockImplementation(({ data }) => Promise.resolve({ id: 'n1', ...data }));

    const res = await request(app)
      .post('/api/attendance')
      .set('Authorization', `Bearer ${driver()}`)
      .send({
        studentId: '33333333-3333-4333-8333-333333333333',
        tripId: '44444444-4444-4444-8444-444444444444',
        type: 'ALIGHTED',
      });
    expect(res.status).toBe(200);
    return prisma.notification.create.mock.calls[0][0].data;
  };

  it('says arrived at school on the inbound trip', async () => {
    const n = await scanOn('TO_SCHOOL');
    expect(n.message).toBe('Asha has arrived at school.');
    expect(n.type).toBe('ARRIVAL'); // unchanged: the parent toggles key off this
  });

  it('says dropped off on the homebound trip', async () => {
    expect((await scanOn('FROM_SCHOOL')).message).toBe('Asha has been dropped off.');
  });

  it('stays neutral when the trip has no direction', async () => {
    expect((await scanOn(null)).message).toBe('Asha has been dropped off.');
  });
});
