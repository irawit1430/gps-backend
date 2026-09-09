const request = require('supertest');
const { app, prisma } = require('../server');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    route: { findUnique: jest.fn() },
    bus: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    run: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const SECRET = process.env.JWT_SECRET;
const admin = () => jwt.sign({ id: 'a1', role: 'SCHOOL_ADMIN', schoolId: 'school-1' }, SECRET);

beforeEach(() => jest.resetAllMocks());

// Trip creation has always checked this; run creation spread the request body straight
// into the row and checked neither, so a school admin could attach another school's bus
// or any non-driver user to a run — and the materialiser then turns that into a real
// trip every morning, unattended.
describe('a run cannot borrow crew from another school', () => {
  beforeEach(() => {
    prisma.route.findUnique.mockResolvedValue({ schoolId: 'school-1' });
    prisma.run.create.mockResolvedValue({ id: 'run-1', startDate: new Date(), endDate: new Date() });
  });

  const body = (over = {}) => ({
    name: 'Morning pickup', direction: 'TO_SCHOOL', departure: '07:15',
    startDate: '2026-09-01', endDate: '2027-03-31',
    mon: true, ...over,
  });

  const post = (b) =>
    request(app).post('/api/routes/r1/runs').set('Authorization', `Bearer ${admin()}`).send(b);

  it('rejects a bus belonging to another school', async () => {
    prisma.bus.findUnique.mockResolvedValue({ schoolId: 'school-2' });
    const res = await post(body({ busId: '11111111-1111-4111-8111-111111111111' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Bus not in this school');
    expect(prisma.run.create).not.toHaveBeenCalled();
  });

  it('rejects a user who is not a driver', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'PARENT', schoolId: 'school-1' });
    const res = await post(body({ driverId: '22222222-2222-4222-8222-222222222222' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Driver not in this school');
    expect(prisma.run.create).not.toHaveBeenCalled();
  });

  // Unassigned buses are shared fleet, same as POST /api/schools/:schoolId/trips.
  it('accepts an unassigned bus and an in-school driver', async () => {
    prisma.bus.findUnique.mockResolvedValue({ schoolId: null });
    prisma.user.findUnique.mockResolvedValue({ role: 'DRIVER', schoolId: 'school-1' });
    const res = await post(body({
      busId: '11111111-1111-4111-8111-111111111111',
      driverId: '22222222-2222-4222-8222-222222222222',
    }));
    expect(res.status).toBe(200);
    expect(prisma.run.create).toHaveBeenCalled();
  });

  // A run saved before its crew is known is legitimate; the materialiser warns on those.
  it('accepts a run with no crew yet', async () => {
    const res = await post(body());
    expect(res.status).toBe(200);
  });

  it('checks the same thing when crew is reassigned on an existing run', async () => {
    prisma.run.findUnique.mockResolvedValue({ id: 'run-1', route: { schoolId: 'school-1' } });
    prisma.bus.findUnique.mockResolvedValue({ schoolId: 'school-2' });

    const res = await request(app)
      .put('/api/runs/run-1')
      .set('Authorization', `Bearer ${admin()}`)
      .send({ busId: '11111111-1111-4111-8111-111111111111' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Bus not in this school');
    expect(prisma.run.update).not.toHaveBeenCalled();
  });
});
