const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    user: { findUnique: jest.fn(), update: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const { app, prisma } = require('../server');
const SECRET = process.env.JWT_SECRET;

describe('POST /api/auth/change-password — replacement token', () => {
  const OLD = 'oldpassword1';
  let uid;
  let oldToken;
  let n = 0;

  // Revocation state (the userId → cutoff map) is process-wide and outlives a test,
  // so each case gets its own user. Sharing one id makes an earlier case's cutoff
  // revoke the next case's freshly minted token — the same second-resolution race
  // this endpoint exists to dodge.
  beforeEach(async () => {
    jest.clearAllMocks();
    uid = `u${++n}`;
    oldToken = jwt.sign({ id: uid, role: 'DRIVER', schoolId: 's1' }, SECRET);
    const row = { id: uid, role: 'DRIVER', schoolId: 's1', password: await bcrypt.hash(OLD, 4) };
    prisma.user.findUnique.mockResolvedValue(row);
    prisma.user.update.mockResolvedValue(row);
  });

  const change = () =>
    request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${oldToken}`)
      .send({ oldPassword: OLD, newPassword: 'brandnewpassword1' });

  const meWith = (t) => request(app).get('/api/users/me').set('Authorization', `Bearer ${t}`);

  it('returns a token usable immediately, in the same second as the revocation', async () => {
    const res = await change();
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');

    // The whole point: no waiting. This is the call that used to 401 because the
    // revocation cutoff and the new token's `iat` landed in the same second.
    expect((await meWith(res.body.token)).status).toBe(200);
  });

  it('still kills the token the change was made with', async () => {
    const res = await change();
    expect(res.status).toBe(200);
    expect(res.body.token).not.toBe(oldToken);
    expect((await meWith(oldToken)).status).toBe(401);
  });

  it('kills sibling sessions issued before the change', async () => {
    const otherDevice = jwt.sign({ id: uid, role: 'DRIVER', schoolId: 's1' }, SECRET);
    expect((await change()).status).toBe(200);
    expect((await meWith(otherDevice)).status).toBe(401);
  });

  it('carries the same claims login issues, with exp derived from the shifted iat', async () => {
    const res = await change();
    expect(res.status).toBe(200);
    const decoded = jwt.decode(res.body.token);
    expect(decoded).toMatchObject({ id: uid, role: 'DRIVER', schoolId: 's1' });
    expect(decoded.exp).toBeGreaterThan(decoded.iat);
  });

  it('does not hand out a token when the current password is wrong', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${oldToken}`)
      .send({ oldPassword: 'notmypassword', newPassword: 'brandnewpassword1' });

    expect(res.status).toBe(401);
    expect(res.body.token).toBeUndefined();
    // the session must survive a failed attempt
    expect((await meWith(oldToken)).status).toBe(200);
  });
});
