const request = require('supertest');
const { app, prisma } = require('../server');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    route: {
      delete: jest.fn(),
      findUnique: jest.fn(),
    },
    trip: {
      count: jest.fn(),
    },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const SECRET = process.env.JWT_SECRET;

describe('DELETE /api/routes/:id', () => {
  beforeEach(() => jest.resetAllMocks());

  const superToken = () => jwt.sign({ id: '1', role: 'SUPER_ADMIN' }, SECRET);

  it('should successfully delete a route (SUPER_ADMIN bypasses ownership)', async () => {
    prisma.trip.count.mockResolvedValue(0);
    prisma.route.delete.mockResolvedValue({ id: '1', name: 'Route 1' });
    const res = await request(app).delete('/api/routes/1').set('Authorization', `Bearer ${superToken()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(prisma.route.delete).toHaveBeenCalledWith({ where: { id: '1' } });
  });

  it('returns 409 instead of attempting deletion when a cancelled trip references the route', async () => {
    prisma.trip.count
      .mockResolvedValueOnce(0) // no PLANNED/ON_SCHEDULE/DELAYED trips
      .mockResolvedValueOnce(1); // one CANCELLED historical trip
    prisma.route.delete.mockRejectedValue({ code: 'P2003' });

    const res = await request(app).delete('/api/routes/1').set('Authorization', `Bearer ${superToken()}`);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'Cannot delete route: 1 trip(s) reference it. Route deletion is blocked to preserve trip history.',
      code: 'ROUTE_HAS_TRIPS',
      tripCount: 1,
      activeTripCount: 0,
    });
    expect(prisma.route.delete).not.toHaveBeenCalled();
  });

  it('returns 409 when a dependent record is created during route deletion', async () => {
    prisma.trip.count.mockResolvedValue(0);
    prisma.route.delete.mockRejectedValue({ code: 'P2003' });

    const res = await request(app).delete('/api/routes/1').set('Authorization', `Bearer ${superToken()}`);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'Cannot delete route because dependent records still reference it.',
      code: 'ROUTE_IN_USE',
    });
  });

  it('should return 500 when database throws an error', async () => {
    prisma.trip.count.mockResolvedValue(0);
    prisma.route.delete.mockRejectedValue(new Error('Database error'));
    const res = await request(app).delete('/api/routes/1').set('Authorization', `Bearer ${superToken()}`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  it('should return 401 when unauthenticated', async () => {
    const res = await request(app).delete('/api/routes/1');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized: missing or invalid token' });
  });

  it('should return 403 for a PARENT (insufficient role)', async () => {
    const parentToken = jwt.sign({ id: 'p1', role: 'PARENT' }, SECRET);
    const res = await request(app).delete('/api/routes/1').set('Authorization', `Bearer ${parentToken}`);
    expect(res.status).toBe(403);
  });

  it('should return 403 when a SCHOOL_ADMIN deletes another school\'s route', async () => {
    prisma.route.findUnique.mockResolvedValue({ id: '1', schoolId: 'school-B' });
    const adminA = jwt.sign({ id: 'a1', role: 'SCHOOL_ADMIN', schoolId: 'school-A' }, SECRET);
    const res = await request(app).delete('/api/routes/1').set('Authorization', `Bearer ${adminA}`);
    expect(res.status).toBe(403);
    expect(prisma.route.delete).not.toHaveBeenCalled();
  });
});
