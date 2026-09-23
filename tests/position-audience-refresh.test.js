// Who may see a bus's live position is cached per trip for five minutes. Nothing ever
// dropped that cache, so a parent taken off a route (or a driver taken off a trip) kept
// receiving the bus for up to five minutes. Roster and crew changes now refresh it.

const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    trip: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    student: { findUnique: jest.fn(), delete: jest.fn() },
    studentRouteMapping: { findUnique: jest.fn(), delete: jest.fn(), findMany: jest.fn() },
    user: { findUnique: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const { app, prisma } = require('../server');
const positionAudience = require('../positionAudience');

const SECRET = process.env.JWT_SECRET;
const admin = `Bearer ${jwt.sign({ id: 'admin-1', role: 'SCHOOL_ADMIN', schoolId: 's1' }, SECRET)}`;
const U = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const TRIP = 'trip-1';
const NEW_DRIVER = U(7);

// The audience query is the trip read with `select`; everything else reads the trip row.
let crew;
beforeEach(() => {
  jest.clearAllMocks();
  positionAudience.clear();
  crew = { driverId: 'driver-1', parents: ['parent-1', 'parent-2'] };
  prisma.trip.findUnique.mockImplementation(async (args) =>
    args.select
      ? {
          driverId: crew.driverId,
          route: { stops: [{ studentMappings: crew.parents.map((parentId) => ({ student: { parentId } })) }] },
        }
      : { id: TRIP, routeId: 'route-1', busId: 'bus-1', driverId: 'driver-1', status: 'ON_SCHEDULE', route: { schoolId: 's1' } }
  );
});

const audience = () => positionAudience.forTrip(prisma, TRIP);

it('the cache really does hold an audience between fixes', async () => {
  expect(await audience()).toEqual(['driver-1', 'parent-1', 'parent-2']);
  crew.parents = ['parent-1'];
  expect(await audience()).toEqual(['driver-1', 'parent-1', 'parent-2']);
});

it('a parent unmapped from the route stops receiving the bus at once', async () => {
  await audience();
  prisma.studentRouteMapping.findUnique.mockResolvedValue({ id: 'm2', student: { schoolId: 's1' } });
  prisma.studentRouteMapping.delete.mockResolvedValue({});
  crew.parents = ['parent-1'];

  const res = await request(app).delete('/api/student-route-mappings/m2').set('Authorization', admin);

  expect(res.status).toBe(204);
  expect(await audience()).toEqual(['driver-1', 'parent-1']);
});

it("a deleted student's parent stops receiving the bus at once", async () => {
  await audience();
  prisma.student.findUnique.mockResolvedValue({ id: 'c2', schoolId: 's1' });
  prisma.student.delete.mockResolvedValue({});
  crew.parents = ['parent-1'];

  const res = await request(app).delete('/api/students/c2').set('Authorization', admin);

  expect(res.status).toBe(204);
  expect(await audience()).toEqual(['driver-1', 'parent-1']);
});

it('a driver taken off the trip stops receiving it at once', async () => {
  await audience();
  prisma.trip.findMany.mockResolvedValue([]);
  prisma.user.findUnique.mockResolvedValue({ id: NEW_DRIVER, role: 'DRIVER', schoolId: 's1' });
  prisma.trip.update.mockResolvedValue({ id: TRIP, status: 'ON_SCHEDULE', driverId: NEW_DRIVER, route: { schoolId: 's1', name: 'R1' } });
  prisma.studentRouteMapping.findMany.mockResolvedValue([]);
  crew.driverId = NEW_DRIVER;

  const res = await request(app).put(`/api/trips/${TRIP}`).set('Authorization', admin).send({ driverId: NEW_DRIVER });

  expect(res.status).toBe(200);
  expect(await audience()).toEqual([NEW_DRIVER, 'parent-1', 'parent-2']);
});
