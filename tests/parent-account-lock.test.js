// A new parent account opens with a lock nobody holds. The family's way in is its own
// invite (tests/parent-invites.test.js), never a password in an import's response and
// never one opening password shared by the whole school.

const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

jest.mock('@prisma/client', () => {
  const tx = {
    student: { create: jest.fn().mockResolvedValue({ id: 's1' }), findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
    user: { findUnique: jest.fn().mockResolvedValue(null), findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]), create: jest.fn(), update: jest.fn() },
    route: { findMany: jest.fn().mockResolvedValue([]) },
    studentRouteMapping: { create: jest.fn() },
  };
  const mockPrisma = {
    student: { create: jest.fn(), findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    user: { findUnique: jest.fn(), create: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    route: { findMany: jest.fn().mockResolvedValue([]) },
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

beforeEach(() => {
  jest.clearAllMocks();
  prisma.__tx.user.create.mockImplementation(({ data }) => Promise.resolve({ id: `p-${data.email}`, ...data }));
  prisma.__tx.student.create.mockResolvedValue({ id: 's1' });
});

const importTwo = () =>
  request(app)
    .post(`/api/schools/${SCHOOL}/students/bulk`)
    .set('Authorization', `Bearer ${token}`)
    .send([
      { rfidTag: 'RF-1', name: 'Asha', parentEmail: 'one@example.com' },
      { rfidTag: 'RF-2', name: 'Rahul', parentEmail: 'two@example.com' },
    ]);

const createdParents = () => prisma.__tx.user.create.mock.calls.map((c) => c[0].data);

describe('parents made by an import', () => {
  it('open with a lock, flagged to choose their own password', async () => {
    const res = await importTwo();

    expect(res.status).toBe(200);
    const parents = createdParents();
    expect(parents).toHaveLength(2);
    for (const p of parents) {
      expect(p.mustResetPassword).toBe(true);
      expect(p.password).toMatch(/^\$2[aby]\$10\$/);
      // Not any of the strings an office might try.
      expect(await bcrypt.compare('password123', p.password)).toBe(false);
      expect(await bcrypt.compare('', p.password)).toBe(false);
    }
  });

  it('hand back no password of any kind', async () => {
    const res = await importTwo();

    expect(res.body.parentCredentials).toBeUndefined();
    expect(res.body.sharedPassword).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/temporaryPassword|tempPassword/);
    expect(res.body.totals).toMatchObject({ new: 2, parentsCreated: 2 });
  });
});

describe('a parent made by Add student', () => {
  it('gets no password back either, just who to invite', async () => {
    const res = await request(app)
      .post(`/api/schools/${SCHOOL}/students`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Asha', parentEmail: 'Asha.Parent@Example.com' });

    expect(res.status).toBe(200);
    expect(res.body.parentCredentials).toBeUndefined();
    expect(res.body.parent).toEqual({ id: 'p-asha.parent@example.com', email: 'asha.parent@example.com', created: true, invited: false });
    // Lowercased: the sign-in email of one family is one account however it was typed.
    expect(createdParents()[0].email).toBe('asha.parent@example.com');
  });
});

describe('PARENT_DEFAULT_PASSWORD', () => {
  it('is gone from the configuration, so setting it changes nothing', () => {
    expect(config).not.toHaveProperty('PARENT_DEFAULT_PASSWORD');
  });

  // A driver can start and end trips; that account keeps its own unique password.
  it('leaves driver provisioning on a unique readable password', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockImplementation(({ data }) => Promise.resolve({ id: 'd1', ...data }));

    const res = await request(app)
      .post(`/api/schools/${SCHOOL}/drivers`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Ravi', email: 'ravi@example.com', phone: '9999999999' });

    expect(res.status).toBe(200);
    expect(res.body.tempPassword).toMatch(/^[A-HJ-NP-Za-hj-np-z2-9]{12}$/);
  });
});
