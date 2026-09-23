// How the school office helps a locked-out parent. The dashboard had no working way to
// do it: the parent's email was never sent to it, and its only reset button waited on a
// notification shape the server never produced.

const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    user: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    student: { findMany: jest.fn() },
    passwordResetRequest: { findFirst: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
    notification: { createMany: jest.fn() },
    pushDevice: { deleteMany: jest.fn() },
    attendanceLog: { findMany: jest.fn() },
    $transaction: jest.fn(async (ops) => Promise.all(ops)),
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const { app, prisma } = require('../server');

const SECRET = process.env.JWT_SECRET;
const bearer = (claims) => `Bearer ${jwt.sign(claims, SECRET)}`;
const ADMIN = bearer({ id: 'admin-1', role: 'SCHOOL_ADMIN', schoolId: 's1' });
const OTHER_ADMIN = bearer({ id: 'admin-2', role: 'SCHOOL_ADMIN', schoolId: 's2' });

beforeEach(() => {
  jest.clearAllMocks();
  prisma.user.update.mockResolvedValue({});
  prisma.user.updateMany.mockResolvedValue({ count: 1 });
  prisma.passwordResetRequest.updateMany.mockResolvedValue({ count: 1 });
  prisma.pushDevice.deleteMany.mockResolvedValue({ count: 0 });
});

describe('POST /api/parents/:parentId/reset-password', () => {
  let n = 0;
  const reset = (auth) => {
    const id = `parent-${++n}`;
    prisma.user.findUnique.mockResolvedValue({ id, role: 'PARENT', schoolId: 's1', name: 'Priya', email: 'priya@example.com' });
    return request(app).post(`/api/parents/${id}/reset-password`).set('Authorization', auth).then((res) => ({ res, id }));
  };

  it('makes a temporary password, shows it once, and makes the parent choose their own', async () => {
    const { res, id } = await reset(ADMIN);

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ id, name: 'Priya', email: 'priya@example.com' });
    expect(res.body.tempPassword).toMatch(/^.{12}$/);
    const { data } = prisma.user.update.mock.calls[0][0];
    expect(data.mustResetPassword).toBe(true);
    expect(await bcrypt.compare(res.body.tempPassword, data.password)).toBe(true);
  });

  it("closes the parent's waiting forgot-password request and forgets the old phone's push", async () => {
    const { id } = await reset(ADMIN);

    expect(prisma.passwordResetRequest.updateMany).toHaveBeenCalledWith({
      where: { userId: id, status: 'PENDING' },
      data: { status: 'APPROVED', resolvedBy: 'admin-1', resolvedAt: expect.any(Date) },
    });
    expect(prisma.pushDevice.deleteMany).toHaveBeenCalledWith({ where: { userId: id } });
  });

  it("refuses another school's admin", async () => {
    const { res } = await reset(OTHER_ADMIN);

    expect(res.status).toBe(403);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('only resets parent accounts', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'sa-9', role: 'SCHOOL_ADMIN', schoolId: 's1' });

    const res = await request(app).post('/api/parents/sa-9/reset-password').set('Authorization', ADMIN);

    expect(res.status).toBe(404);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('is not open to parents or drivers', async () => {
    for (const role of ['PARENT', 'DRIVER']) {
      const res = await request(app).post('/api/parents/p/reset-password').set('Authorization', bearer({ id: 'x', role, schoolId: 's1' }));
      expect(res.status).toBe(403);
    }
  });
});

it("sends the office the parent's email with the students list", async () => {
  prisma.student.findMany.mockResolvedValue([]);
  prisma.attendanceLog.findMany.mockResolvedValue([]);

  await request(app).get('/api/schools/s1/students').set('Authorization', ADMIN);

  expect(prisma.student.findMany.mock.calls[0][0].include.parent).toEqual({ select: { name: true, phone: true, email: true } });
});

it('tags a forgot-password notification so the dashboard can open the request', async () => {
  prisma.user.findUnique.mockResolvedValue({ id: 'p-7', name: 'P', email: 'p@x.com', role: 'PARENT', schoolId: 's1' });
  prisma.passwordResetRequest.findFirst.mockResolvedValue(null);
  prisma.passwordResetRequest.create.mockResolvedValue({ id: 'req-7' });
  prisma.user.findMany.mockResolvedValue([{ id: 'admin-1' }]);

  await request(app).post('/api/auth/forgot-password').send({ email: 'p@x.com' });

  expect(prisma.notification.createMany.mock.calls[0][0].data[0].context).toEqual({
    type: 'PASSWORD_RESET', requestId: 'req-7', userId: 'p-7',
  });
});
