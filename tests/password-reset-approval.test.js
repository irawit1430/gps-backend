// Anyone can file a forgot-password request for any email, and approving one hands the
// approver a working temporary password. A school admin could approve a request for a
// super admin (or another admin) who carries their school's id, and sign in as them.
// School admins now handle parent and driver accounts only.

const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    user: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    passwordResetRequest: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
    notification: { createMany: jest.fn() },
    pushDevice: { findMany: jest.fn(), deleteMany: jest.fn() },
    $transaction: jest.fn(async (ops) => (Array.isArray(ops) ? Promise.all(ops) : ops(mockPrisma))),
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const { app, prisma } = require('../server');

const SECRET = process.env.JWT_SECRET;
const bearer = (claims) => `Bearer ${jwt.sign(claims, SECRET)}`;
const SCHOOL_ADMIN = bearer({ id: 'sa-1', role: 'SCHOOL_ADMIN', schoolId: 's1' });
const SUPER_ADMIN = bearer({ id: 'super-1', role: 'SUPER_ADMIN', schoolId: null });

const pending = (role) => ({
  id: 'req-1', userId: `target-${role}`, schoolId: 's1', status: 'PENDING',
  user: { id: `target-${role}`, name: 'T', email: 't@example.com', schoolId: 's1', role },
});

beforeEach(() => {
  jest.clearAllMocks();
  prisma.user.update.mockResolvedValue({});
  prisma.user.updateMany.mockResolvedValue({ count: 1 });
  prisma.passwordResetRequest.update.mockResolvedValue({});
});

const approve = (auth) => request(app).post('/api/password-reset-requests/req-1/approve').set('Authorization', auth);
const reject = (auth) => request(app).post('/api/password-reset-requests/req-1/reject').set('Authorization', auth);

describe('approving a reset', () => {
  it.each(['SUPER_ADMIN', 'SCHOOL_ADMIN'])('is refused to a school admin for a %s account', async (role) => {
    prisma.passwordResetRequest.findUnique.mockResolvedValue(pending(role));

    const res = await approve(SCHOOL_ADMIN);

    expect(res.status).toBe(403);
    expect(res.body.tempPassword).toBeUndefined();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it.each(['PARENT', 'DRIVER'])('still works for a school admin on a %s account', async (role) => {
    prisma.passwordResetRequest.findUnique.mockResolvedValue(pending(role));

    const res = await approve(SCHOOL_ADMIN);

    expect(res.status).toBe(200);
    expect(res.body.tempPassword).toEqual(expect.any(String));
  });

  it("works for a super admin on an administrator's account", async () => {
    prisma.passwordResetRequest.findUnique.mockResolvedValue(pending('SCHOOL_ADMIN'));

    expect((await approve(SUPER_ADMIN)).status).toBe(200);
  });
});

describe('rejecting a reset', () => {
  it("is refused to a school admin for an administrator's account", async () => {
    prisma.passwordResetRequest.findUnique.mockResolvedValue(pending('SUPER_ADMIN'));

    expect((await reject(SCHOOL_ADMIN)).status).toBe(403);
    expect(prisma.passwordResetRequest.update).not.toHaveBeenCalled();
  });

  it("works for a school admin on a parent's account", async () => {
    prisma.passwordResetRequest.findUnique.mockResolvedValue(pending('PARENT'));

    expect((await reject(SCHOOL_ADMIN)).status).toBe(200);
  });
});

describe('the request list', () => {
  it("shows a school admin only their school's parent and driver requests", async () => {
    prisma.passwordResetRequest.findMany.mockResolvedValue([]);

    await request(app).get('/api/password-reset-requests').set('Authorization', SCHOOL_ADMIN);

    expect(prisma.passwordResetRequest.findMany.mock.calls[0][0].where).toEqual({
      status: 'PENDING', schoolId: 's1', user: { role: { in: ['PARENT', 'DRIVER'] } },
    });
  });
});

describe('filing a request', () => {
  beforeEach(() => {
    prisma.passwordResetRequest.findFirst.mockResolvedValue(null);
    prisma.passwordResetRequest.create.mockResolvedValue({ id: 'req-9' });
    prisma.user.findMany.mockResolvedValue([]);
  });

  it("tells only super admins about an administrator's request", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'sa-2', name: 'A', email: 'a@x.com', role: 'SCHOOL_ADMIN', schoolId: 's1' });

    await request(app).post('/api/auth/forgot-password').send({ email: 'a@x.com' });

    expect(prisma.user.findMany).toHaveBeenCalledWith({ where: { role: 'SUPER_ADMIN' }, select: { id: true } });
  });

  it("still tells the school about a parent's request", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'p-2', name: 'P', email: 'p@x.com', role: 'PARENT', schoolId: 's1' });

    await request(app).post('/api/auth/forgot-password').send({ email: 'p@x.com' });

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { schoolId: 's1', role: { in: ['SCHOOL_ADMIN', 'SUPER_ADMIN'] } }, select: { id: true },
    });
  });
});
