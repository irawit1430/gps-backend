// How long a bus waits at each stop is now the school's own setting, and its admin can
// change it. Only the super admin could edit a school before.

const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = { school: { update: jest.fn() } };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const { app, prisma } = require('../server');

const bearer = (claims) => `Bearer ${jwt.sign(claims, process.env.JWT_SECRET)}`;
const patch = (auth, body, school = 's1') =>
  request(app).patch(`/api/schools/${school}/transport`).set('Authorization', auth).send(body);
const ADMIN = bearer({ id: 'a1', role: 'SCHOOL_ADMIN', schoolId: 's1' });

beforeEach(() => {
  jest.clearAllMocks();
  prisma.school.update.mockImplementation(async ({ where, data }) => ({ id: where.id, ...data }));
});

it("lets the school's admin set the waiting time", async () => {
  const res = await patch(ADMIN, { stopDwellMinutes: 2.5 });

  expect(res.status).toBe(200);
  expect(prisma.school.update).toHaveBeenCalledWith({
    where: { id: 's1' }, data: { stopDwellMinutes: 2.5 }, select: { id: true, stopDwellMinutes: true },
  });
  expect(res.body).toMatchObject({ stopDwellMinutes: 2.5, defaultStopDwellMinutes: 1 });
});

it('goes back to the default with null', async () => {
  expect((await patch(ADMIN, { stopDwellMinutes: null })).status).toBe(200);
  expect(prisma.school.update.mock.calls[0][0].data).toEqual({ stopDwellMinutes: null });
});

it('refuses another school, a parent and a driver', async () => {
  expect((await patch(ADMIN, { stopDwellMinutes: 2 }, 's2')).status).toBe(403);
  expect((await patch(bearer({ id: 'p', role: 'PARENT', schoolId: 's1' }), { stopDwellMinutes: 2 })).status).toBe(403);
  expect((await patch(bearer({ id: 'd', role: 'DRIVER', schoolId: 's1' }), { stopDwellMinutes: 2 })).status).toBe(403);
  expect(prisma.school.update).not.toHaveBeenCalled();
});

it('takes nothing else, and nothing silly', async () => {
  expect((await patch(ADMIN, { stopDwellMinutes: 30 })).status).toBe(400);
  expect((await patch(ADMIN, { stopDwellMinutes: -1 })).status).toBe(400);
  expect((await patch(ADMIN, { stopDwellMinutes: 1, name: 'Renamed' })).status).toBe(400);
  expect(prisma.school.update).not.toHaveBeenCalled();
});
