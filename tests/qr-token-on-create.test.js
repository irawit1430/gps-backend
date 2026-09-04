const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const tx = {
    student: { create: jest.fn().mockResolvedValue({ id: 's1', name: 'Asha' }) },
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
const SECRET = process.env.JWT_SECRET;
const admin = jwt.sign({ id: 'a1', role: 'SCHOOL_ADMIN', schoolId: 'school-1' }, SECRET);
const SCHOOL = '11111111-1111-4111-8111-111111111111';

// Migration 5 backfilled a token for everyone who existed then and nothing generated
// one afterwards. Every new admission was invisible to the whole QR system: no card
// printable, qrHash null on the driver roster so a scan could never match — and one
// such child fails an entire print batch, because the card screen builds QR images
// from the token client-side.
describe('a newly created student gets a QR token', () => {
  beforeEach(() => jest.clearAllMocks());

  it('single create issues a token', async () => {
    const res = await request(app)
      .post(`/api/schools/${SCHOOL}/students`)
      .set('Authorization', `Bearer ${jwt.sign({ id: 'a1', role: 'SCHOOL_ADMIN', schoolId: SCHOOL }, SECRET)}`)
      .send({ name: 'Asha', grade: '5th' });

    expect(res.status).toBe(200);
    const data = prisma.__tx.student.create.mock.calls[0][0].data;
    expect(data.qrToken).toMatch(/^[0-9a-f]{32}$/);
  });

  it('issues a different token to each student', async () => {
    const post = () =>
      request(app)
        .post(`/api/schools/${SCHOOL}/students`)
        .set('Authorization', `Bearer ${jwt.sign({ id: 'a1', role: 'SCHOOL_ADMIN', schoolId: SCHOOL }, SECRET)}`)
        .send({ name: 'Asha', grade: '5th' });

    await post();
    await post();

    const [a, b] = prisma.__tx.student.create.mock.calls.map((c) => c[0].data.qrToken);
    expect(a).not.toBe(b);
  });

  it('does not attach an existing parent account from another school', async () => {
    prisma.__tx.user.findUnique.mockResolvedValue({
      id: 'parent-other', role: 'PARENT', schoolId: 'school-other',
    });

    const res = await request(app)
      .post(`/api/schools/${SCHOOL}/students`)
      .set('Authorization', `Bearer ${jwt.sign({ id: 'a1', role: 'SCHOOL_ADMIN', schoolId: SCHOOL }, SECRET)}`)
      .send({ name: 'Asha', grade: '5th', parentEmail: 'parent@example.com' });

    expect(res.status).toBe(409);
    expect(prisma.__tx.student.create).not.toHaveBeenCalled();
  });
});
