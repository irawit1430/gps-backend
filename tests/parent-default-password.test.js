const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

jest.mock('@prisma/client', () => {
  const tx = {
    student: { create: jest.fn().mockResolvedValue({ id: 's1' }) },
    user: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
  };
  const mockPrisma = {
    student: { create: jest.fn(), findUnique: jest.fn() },
    user: { findUnique: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(async (fn) => (typeof fn === 'function' ? fn(tx) : Promise.all(fn))),
    __tx: tx,
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const { app, prisma } = require('../server');
const config = require('../config');

const SECRET = process.env.JWT_SECRET;
const SCHOOL = '11111111-1111-4111-8111-111111111111';
const token = jwt.sign({ id: 'a1', role: 'SCHOOL_ADMIN', schoolId: SCHOOL }, SECRET);

// Read at call time, so a test can set it and restore it.
const original = config.PARENT_DEFAULT_PASSWORD;
afterEach(() => {
  config.PARENT_DEFAULT_PASSWORD = original;
});

beforeEach(() => {
  jest.clearAllMocks();
  prisma.__tx.user.findUnique.mockResolvedValue(null);
  prisma.__tx.user.create.mockImplementation(({ data }) => Promise.resolve({ id: `p-${data.email}`, ...data }));
});

const importTwo = () =>
  request(app)
    .post(`/api/schools/${SCHOOL}/students/bulk`)
    .set('Authorization', `Bearer ${token}`)
    .send([
      { name: 'Asha', rfidTag: 'RF-1', parentEmail: 'one@example.com' },
      { name: 'Rahul', rfidTag: 'RF-2', parentEmail: 'two@example.com' },
    ]);

const createdParents = () => prisma.__tx.user.create.mock.calls.map((c) => c[0].data);

describe('PARENT_DEFAULT_PASSWORD set: one shared opening password', () => {
  beforeEach(() => {
    config.PARENT_DEFAULT_PASSWORD = 'FixtureSharedPw1';
  });

  it('opens every imported parent account with that one string', async () => {
    const res = await importTwo();

    expect(res.status).toBe(200);
    const parents = createdParents();
    expect(parents).toHaveLength(2);
    // The stored hash must verify against the shared password, for both of them.
    for (const p of parents) {
      expect(await bcrypt.compare('FixtureSharedPw1', p.password)).toBe(true);
    }
    // Still flagged, even though nothing server-side enforces it yet.
    expect(parents.every((p) => p.mustResetPassword === true)).toBe(true);
  });

  it('tells the caller the credentials it returned are one shared string', async () => {
    const res = await importTwo();

    expect(res.body.sharedPassword).toBe(true);
    expect(res.body.parentCredentials).toEqual([
      { email: 'one@example.com', temporaryPassword: 'FixtureSharedPw1' },
      { email: 'two@example.com', temporaryPassword: 'FixtureSharedPw1' },
    ]);
  });

  // A driver can start and end trips; that account does not join the shared scheme.
  it('leaves driver provisioning on a unique password', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockImplementation(({ data }) => Promise.resolve({ id: 'd1', ...data }));

    const res = await request(app)
      .post(`/api/schools/${SCHOOL}/drivers`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Ravi', email: 'ravi@example.com', phone: '9999999999' });

    expect(res.status).toBe(200);
    expect(res.body.tempPassword).not.toBe('FixtureSharedPw1');
    expect(res.body.tempPassword).toHaveLength(12);
  });
});

describe('PARENT_DEFAULT_PASSWORD unset: a password per parent', () => {
  beforeEach(() => {
    config.PARENT_DEFAULT_PASSWORD = undefined;
  });

  it('gives each parent their own readable password', async () => {
    const res = await importTwo();

    expect(res.status).toBe(200);
    expect(res.body.sharedPassword).toBe(false);
    const [a, b] = res.body.parentCredentials.map((c) => c.temporaryPassword);
    expect(a).not.toBe(b);
    // Readable alphabet, no O/0/I/1 — this is handed out on paper or read aloud.
    expect(a).toMatch(/^[A-HJ-NP-Za-hj-np-z2-9]{12}$/);
  });
});
