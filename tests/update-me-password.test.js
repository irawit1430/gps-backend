// PUT /api/users/me changed the password on the strength of the token alone. A stolen or
// left-signed-in session could lock the owner out for good. It now needs the current
// password, like change-password. And an admin whose password a super admin chose is
// asked to replace it at next sign-in.

const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    user: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const { app, prisma } = require('../server');

const SECRET = process.env.JWT_SECRET;
let n = 0;
const tokenFor = (claims) => `Bearer ${jwt.sign(claims, SECRET)}`;
let hash;

beforeAll(async () => { hash = await bcrypt.hash('the-current-one', 4); });
beforeEach(() => {
  jest.clearAllMocks();
  prisma.user.findUnique.mockResolvedValue({ password: hash });
  prisma.user.update.mockImplementation(async ({ data }) => ({ id: 'u', name: 'U', ...data }));
  prisma.user.updateMany.mockResolvedValue({ count: 1 });
});

describe('PUT /api/users/me', () => {
  // A fresh user per case: a password change revokes that user's tokens.
  const me = () => tokenFor({ id: `me-${++n}`, role: 'DRIVER', schoolId: 's1' });
  const put = (body) => request(app).put('/api/users/me').set('Authorization', me()).send(body);

  it('refuses a new password without the current one', async () => {
    const res = await put({ password: 'a-new-password-1' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CURRENT_PASSWORD_REQUIRED');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('refuses a new password with the wrong current one', async () => {
    const res = await put({ password: 'a-new-password-1', currentPassword: 'a-guess' });

    expect(res.status).toBe(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('changes it with the right current password, and never stores the current one', async () => {
    const res = await put({ password: 'a-new-password-1', currentPassword: 'the-current-one' });

    expect(res.status).toBe(200);
    const { data } = prisma.user.update.mock.calls[0][0];
    expect(await bcrypt.compare('a-new-password-1', data.password)).toBe(true);
    expect(data.mustResetPassword).toBe(false);
    expect(data).not.toHaveProperty('currentPassword');
    expect(res.body).not.toHaveProperty('password');
  });

  it('still changes a name without any password', async () => {
    const res = await put({ name: 'New Name' });

    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: { name: 'New Name' } }));
  });
});

describe('passwords a super admin sets', () => {
  const SUPER = tokenFor({ id: 'super-1', role: 'SUPER_ADMIN', schoolId: null });

  it('are replaced by the new admin at first sign-in', async () => {
    prisma.user.create.mockResolvedValue({ id: 'a1' });

    await request(app).post('/api/admins').set('Authorization', SUPER).send({
      name: 'New Admin', email: 'new@school.in', password: 'a-long-temp-password', role: 'SCHOOL_ADMIN', schoolId: null,
    });

    expect(prisma.user.create.mock.calls[0][0].data.mustResetPassword).toBe(true);
  });

  it("are replaced at next sign-in after a reset of someone else's", async () => {
    await request(app).put('/api/admins/admin-7').set('Authorization', SUPER).send({ password: 'a-long-temp-password' });

    expect(prisma.user.update.mock.calls[0][0].data.mustResetPassword).toBe(true);
  });

  it("are not flagged when super admins change their own", async () => {
    await request(app).put('/api/admins/super-1').set('Authorization', SUPER).send({ password: 'my-own-long-password' });

    expect(prisma.user.update.mock.calls[0][0].data.mustResetPassword).toBeUndefined();
  });
});
