const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    trip: { findMany: jest.fn() },
    leaveApplication: { findMany: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const { app, prisma } = require('../server');
const SECRET = process.env.JWT_SECRET;

// A trip whose route puts `studentIds` on stops, one student per stop.
const tripWith = (id, studentIds) => ({
  id,
  status: 'PLANNED',
  route: {
    name: `route-${id}`,
    stops: studentIds.map((sid, i) => ({
      name: `stop-${i}`,
      orderIdx: i,
      studentMappings: [{ student: { id: sid, name: sid } }],
    })),
  },
  bus: { id: 'bus-1' },
  attendanceLogs: [],
});

describe('GET /api/drivers/:driverId/trips — leaveApplications', () => {
  let token;

  beforeEach(() => {
    jest.clearAllMocks();
    token = jwt.sign({ id: 'driver-1', role: 'DRIVER' }, SECRET);
  });

  it("attaches today's approved leaves to the trip carrying that student", async () => {
    // s1 sits on two stops of trip-A — it must not be counted twice.
    prisma.trip.findMany.mockResolvedValue([
      tripWith('trip-A', ['s1', 's2', 's1']),
      tripWith('trip-B', ['s3']),
    ]);
    prisma.leaveApplication.findMany.mockResolvedValue([
      { id: 'lv-1', studentId: 's1', status: 'APPROVED', startDate: new Date(), endDate: new Date() },
    ]);

    const res = await request(app)
      .get('/api/drivers/driver-1/trips')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);

    const [tripA, tripB] = res.body;
    expect(tripA.leaveApplications.map((l) => l.id)).toEqual(['lv-1']);
    // s3 has no leave, so trip-B gets an empty array rather than a missing field.
    expect(tripB.leaveApplications).toEqual([]);

    // Deduped student list, APPROVED only, and a range that overlaps today.
    const where = prisma.leaveApplication.findMany.mock.calls[0][0].where;
    expect(where.studentId.in.sort()).toEqual(['s1', 's2', 's3']);
    expect(where.status).toBe('APPROVED');
    expect(where.startDate.lte.getTime()).toBeGreaterThanOrEqual(where.endDate.gte.getTime());
  });

  it('skips the leave query entirely when no trip has students', async () => {
    prisma.trip.findMany.mockResolvedValue([tripWith('trip-A', [])]);

    const res = await request(app)
      .get('/api/drivers/driver-1/trips')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body[0].leaveApplications).toEqual([]);
    expect(prisma.leaveApplication.findMany).not.toHaveBeenCalled();
  });
});

describe('GET /api/drivers/:driverId/trips — one leave entry per student', () => {
  let token;

  beforeEach(() => {
    jest.clearAllMocks();
    token = jwt.sign({ id: 'driver-1', role: 'DRIVER' }, SECRET);
  });

  // Nothing stops a student holding two APPROVED leaves whose ranges both cover today.
  // Returning both put two entries with the same studentId in one array, which collides
  // keys in any client that keys the list by student.
  it('collapses multiple overlapping leaves for one student to a single entry', async () => {
    prisma.trip.findMany.mockResolvedValue([tripWith('trip-A', ['s1'])]);
    prisma.leaveApplication.findMany.mockResolvedValue([
      { id: 'lv-1', studentId: 's1', status: 'APPROVED', startDate: new Date(), endDate: new Date() },
      { id: 'lv-2', studentId: 's1', status: 'APPROVED', startDate: new Date(), endDate: new Date() },
    ]);

    const res = await request(app)
      .get('/api/drivers/driver-1/trips')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const ids = res.body[0].leaveApplications.map((l) => l.studentId);
    expect(ids).toEqual(['s1']);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
