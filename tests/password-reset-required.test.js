// mustResetPassword used to be advisory for everyone. A parent on a provisioning password
// (which can be one password shared by a whole school) now has to change it before the
// account does anything else — including receiving the live bus feed.

const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    user: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const { app, prisma } = require('../server');
const { attachSocketAuth } = require('../middleware/socketAuth');

const SECRET = process.env.JWT_SECRET;
const PASSWORD = 'shared-notice-password';
let hash;
let n = 0;

beforeAll(async () => {
  hash = await bcrypt.hash(PASSWORD, 4);
});

// Revocation state is process-wide, so every case gets its own user id.
const userRow = (overrides = {}) => ({
  id: `user-${++n}`, email: `p${n}@example.com`, name: 'P', role: 'PARENT', schoolId: 's1',
  password: hash, mustResetPassword: true, notificationSettings: null, ...overrides,
});

const login = async (row) => {
  prisma.user.findUnique.mockResolvedValue(row);
  prisma.user.update.mockResolvedValue(row);
  const res = await request(app).post('/api/auth/login').send({ email: row.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return res.body.token;
};

const me = (token) => request(app).get('/api/users/me').set('Authorization', `Bearer ${token}`);

beforeEach(() => jest.clearAllMocks());

describe('login', () => {
  it('marks the token of a parent who must reset', async () => {
    const token = await login(userRow());
    expect(jwt.decode(token).mustResetPassword).toBe(true);
  });

  it('leaves it off once the parent has reset', async () => {
    const token = await login(userRow({ mustResetPassword: false }));
    expect(jwt.decode(token).mustResetPassword).toBeUndefined();
  });

  it('leaves it off for drivers and admins, who are not gated', async () => {
    const token = await login(userRow({ role: 'DRIVER' }));
    expect(jwt.decode(token).mustResetPassword).toBeUndefined();
  });
});

describe('a parent who has not reset', () => {
  it('is refused everything else, with a code the app can act on', async () => {
    const row = userRow();
    const token = await login(row);

    const res = await me(token);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PASSWORD_RESET_REQUIRED');
  });

  it('is refused the leave routes too, which mount after the gate', async () => {
    const token = await login(userRow());

    const res = await request(app).get('/api/parents/x/leaves').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PASSWORD_RESET_REQUIRED');
  });

  it('can change the password, and the replacement token gets straight in', async () => {
    const row = userRow();
    const token = await login(row);

    const changed = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ oldPassword: PASSWORD, newPassword: 'a-password-of-their-own' });

    expect(changed.status).toBe(200);
    expect(prisma.user.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ mustResetPassword: false }),
    }));
    expect(jwt.decode(changed.body.token).mustResetPassword).toBeUndefined();

    prisma.user.findUnique.mockResolvedValue({ ...row, mustResetPassword: false });
    expect((await me(changed.body.token)).status).toBe(200);
  });

  it('can log out', async () => {
    const token = await login(userRow());
    prisma.user.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
  });
});

it('does not gate other roles, even if a token carried the flag', async () => {
  const row = userRow({ role: 'DRIVER' });
  prisma.user.findUnique.mockResolvedValue(row);
  const token = jwt.sign({ id: row.id, role: 'DRIVER', schoolId: 's1', mustResetPassword: true }, SECRET);

  expect((await me(token)).status).toBe(200);
});

describe('the live socket', () => {
  const connect = (token) => {
    let middleware;
    attachSocketAuth({
      use: (fn) => { middleware = fn; },
      on: () => {},
      in: () => ({ disconnectSockets: () => {} }),
    });
    const socket = { handshake: { auth: { token } }, data: {}, join: jest.fn(), on: jest.fn(), id: 's' };
    return new Promise((resolve) => middleware(socket, (err) => resolve({ err, socket })));
  };

  it('refuses a parent who has not reset, without the word the app signs out on', async () => {
    const token = jwt.sign({ id: `sock-${++n}`, role: 'PARENT', schoolId: 's1', mustResetPassword: true }, SECRET);

    const { err, socket } = await connect(token);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Password change required');
    // The parent app calls signOut() on any connect_error mentioning "unauthorized",
    // which would throw the parent off the reset screen they are on.
    expect(err.message).not.toMatch(/unauthorized/i);
    expect(socket.join).not.toHaveBeenCalled();
  });

  it('lets a parent who has reset connect', async () => {
    const token = jwt.sign({ id: `sock-${++n}`, role: 'PARENT', schoolId: 's1' }, SECRET);

    const { err, socket } = await connect(token);

    expect(err).toBeUndefined();
    expect(socket.join).toHaveBeenCalledWith(expect.stringMatching(/^user:/));
  });
});
