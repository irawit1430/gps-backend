// Signing a user out everywhere (password change or reset, role or school change) used to
// live only in memory, so a restart or deploy revived every token it had ended until the
// token expired. The cutoff is now saved to User.tokensValidAfter and restored at boot.

const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    user: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const { app, prisma } = require('../server');
const { invalidateUser, logoutToken } = require('../middleware/auth');

const SECRET = process.env.JWT_SECRET;
const now = () => Math.floor(Date.now() / 1000);
const tokenFor = (id, iat) => jwt.sign({ id, role: 'DRIVER', schoolId: 's1', iat }, SECRET);
const flush = () => new Promise((resolve) => setImmediate(resolve));

// A fresh copy of the auth state, as a newly started process would have.
const freshProcess = () => {
  let mods;
  jest.isolateModules(() => {
    mods = {
      auth: require('../middleware/auth'),
      revocations: require('../sessionRevocations'),
    };
  });
  return mods;
};
const silentLogger = () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() });

let n = 0;
const nextId = () => `rev-user-${++n}`;

beforeEach(() => {
  jest.clearAllMocks();
  prisma.user.updateMany.mockResolvedValue({ count: 1 });
});

describe('saving a revocation', () => {
  it('writes the cutoff to the user, never moving a later one back', async () => {
    const id = nextId();
    const before = now();

    invalidateUser(id);
    await flush();

    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
    const { where, data } = prisma.user.updateMany.mock.calls[0][0];
    const at = data.tokensValidAfter;
    expect(at).toBeInstanceOf(Date);
    // Whole seconds, so a restored cutoff compares with iat exactly as the original did.
    expect(at.getTime() % 1000).toBe(0);
    expect(at.getTime() / 1000).toBeGreaterThanOrEqual(before);
    expect(where).toEqual({ id, OR: [{ tokensValidAfter: null }, { tokensValidAfter: { lt: at } }] });
  });

  it('does not write anything for a single logout', async () => {
    logoutToken(tokenFor(nextId(), now()));
    await flush();

    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it('saves on a password change, and a failed save does not fail the change', async () => {
    const password = 'old-password-1';
    const row = {
      id: nextId(), email: 'd@example.com', name: 'D', role: 'DRIVER', schoolId: 's1',
      password: await bcrypt.hash(password, 4), mustResetPassword: false,
    };
    prisma.user.findUnique.mockResolvedValue(row);
    prisma.user.update.mockResolvedValue(row);
    // As if the column's migration had not been run.
    prisma.user.updateMany.mockRejectedValue(new Error('column "tokensValidAfter" does not exist'));

    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${tokenFor(row.id, now() - 5)}`)
      .send({ oldPassword: password, newPassword: 'a-new-password-2' });
    await flush();

    expect(res.status).toBe(200);
    expect(prisma.user.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: row.id }),
      data: { tokensValidAfter: expect.any(Date) },
    }));
  });

  it('cannot throw into the request, even if the database client is broken', async () => {
    const { auth, revocations } = freshProcess();
    const logger = silentLogger();
    revocations.persistRevocations({ user: {} }, logger);

    expect(() => auth.invalidateUser('u')).not.toThrow();
    await flush();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe('after a restart', () => {
  // Process A revokes; process B starts with empty memory and restores what A saved.
  const revokeAndSave = async (id) => {
    const a = freshProcess();
    const saved = [];
    a.revocations.persistRevocations({
      user: {
        updateMany: jest.fn(async ({ data }) => {
          saved.push({ id, tokensValidAfter: data.tokensValidAfter });
          return { count: 1 };
        }),
      },
    }, silentLogger());
    a.auth.invalidateUser(id);
    await flush();
    return saved;
  };

  it('still refuses a token revoked before the restart', async () => {
    const id = nextId();
    const stolen = tokenFor(id, now() - 60);
    const saved = await revokeAndSave(id);

    const b = freshProcess();
    // The bug: with nothing restored, the new process takes the revoked token.
    expect(() => b.auth.verifyAccessToken(stolen)).not.toThrow();

    const restored = await b.revocations.loadRevocations({ user: { findMany: jest.fn().mockResolvedValue(saved) } });

    expect(restored).toBe(1);
    expect(() => b.auth.verifyAccessToken(stolen)).toThrow('Token has been revoked');
  });

  it('keeps accepting tokens issued after the revocation', async () => {
    // change-password hands back a token dated one second past the cutoff.
    const id = nextId();
    const saved = await revokeAndSave(id);
    const cutoff = saved[0].tokensValidAfter.getTime() / 1000;

    const b = freshProcess();
    await b.revocations.loadRevocations({ user: { findMany: jest.fn().mockResolvedValue(saved) } });

    expect(b.auth.verifyAccessToken(tokenFor(id, cutoff + 1)).id).toBe(id);
    expect(() => b.auth.verifyAccessToken(tokenFor(id, cutoff))).toThrow('Token has been revoked');
  });

  it('reads only users with a saved cutoff', async () => {
    const b = freshProcess();
    const findMany = jest.fn().mockResolvedValue([]);

    await b.revocations.loadRevocations({ user: { findMany } });

    expect(findMany).toHaveBeenCalledWith({
      where: { tokensValidAfter: { not: null } },
      select: { id: true, tokensValidAfter: true },
    });
  });

  it('never moves a cutoff made since boot back to an older saved one', () => {
    const b = freshProcess();
    const id = nextId();
    b.auth.invalidateUser(id);

    b.auth.restoreRevocations([[id, now() - 3600]]);

    expect(() => b.auth.verifyAccessToken(tokenFor(id, now() - 60))).toThrow('Token has been revoked');
  });
});
