// Two ways a family's data reached the wrong place:
//  - a parent could read where their child's bus was at any hour (PLANNED trips count as
//    "the child's bus", and they are materialised days ahead), overnight included;
//  - after an admin reset a lost phone's password, that phone kept receiving the child's
//    push alerts, because its push registration outlived the sign-out.

const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    user: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    student: { findMany: jest.fn() },
    bus: { findMany: jest.fn() },
    pushDevice: { deleteMany: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const { app, prisma } = require('../server');

const SECRET = process.env.JWT_SECRET;
const bearer = (claims) => `Bearer ${jwt.sign(claims, SECRET)}`;
const ADMIN = bearer({ id: 'admin-1', role: 'SCHOOL_ADMIN', schoolId: 's1' });

beforeEach(() => {
  jest.clearAllMocks();
  prisma.user.update.mockImplementation(async ({ data }) => ({ id: 'x', ...data }));
  prisma.user.updateMany.mockResolvedValue({ count: 1 });
  prisma.pushDevice.deleteMany.mockResolvedValue({ count: 1 });
});

describe("a parent's view of the bus", () => {
  it('covers running trips only', async () => {
    prisma.student.findMany.mockResolvedValue([]);
    prisma.bus.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/devices/locations')
      .set('Authorization', bearer({ id: 'parent-1', role: 'PARENT', schoolId: 's1' }));

    expect(res.status).toBe(200);
    const trips = prisma.student.findMany.mock.calls[0][0]
      .include.routeMappings.include.routeStop.include.route.include.trips;
    expect(trips.where).toEqual({ status: { in: ['ON_SCHEDULE', 'DELAYED'] } });
  });
});

describe('an admin resetting a password', () => {
  let n = 0;
  const reset = (kind, body) => {
    const id = `${kind}-${++n}`;
    prisma.user.findUnique.mockResolvedValue({ id, role: kind === 'parents' ? 'PARENT' : 'DRIVER', schoolId: 's1' });
    return request(app).put(`/api/${kind}/${id}`).set('Authorization', ADMIN).send(body).then((res) => ({ res, id }));
  };

  it.each(['parents', 'drivers'])("stops the old phone's push alerts (%s)", async (kind) => {
    const { res, id } = await reset(kind, { password: 'a-temp-password-1' });

    expect(res.status).toBe(200);
    expect(prisma.pushDevice.deleteMany).toHaveBeenCalledWith({ where: { userId: id } });
    expect(prisma.user.updateMany).toHaveBeenCalledWith({ where: { id }, data: { fcmToken: null } });
  });

  it('leaves push alone for an edit that is not a password reset', async () => {
    const { res } = await reset('parents', { name: 'New Name' });

    expect(res.status).toBe(200);
    expect(prisma.pushDevice.deleteMany).not.toHaveBeenCalled();
  });

  it('still resets the password if forgetting the devices fails', async () => {
    prisma.pushDevice.deleteMany.mockRejectedValue(new Error('db hiccup'));

    const { res } = await reset('parents', { password: 'a-temp-password-1' });

    expect(res.status).toBe(200);
  });
});
