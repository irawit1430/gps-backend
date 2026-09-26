// A card is "printed" only when the office says the sheets came out right. Handing out
// the codes for a print run is not that, because nobody can see a printer jam, and the
// driver app reads "printed" as "this child is holding a card".

const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    student: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const { app, prisma } = require('../server');

const SECRET = process.env.JWT_SECRET;
const SCHOOL = '11111111-1111-4111-8111-111111111111';
const S1 = '66666666-6666-4666-8666-666666666666';
const admin = jwt.sign({ id: 'a1', role: 'SCHOOL_ADMIN', schoolId: SCHOOL }, SECRET);

beforeEach(() => jest.clearAllMocks());

it('generating cards for printing stamps nothing', async () => {
  prisma.student.findMany.mockResolvedValue([{ id: S1, name: 'Asha', grade: '5', qrToken: 'tok', qrCodeImported: false, qrCardPrintedAt: null, routeMappings: [] }]);

  const res = await request(app).post(`/api/schools/${SCHOOL}/qr-cards`).set('Authorization', `Bearer ${admin}`).send({ studentIds: [S1] });

  expect(res.status).toBe(200);
  expect(res.body[0]).toMatchObject({ studentId: S1, qrToken: 'tok', printedAt: null });
  expect(prisma.student.updateMany).not.toHaveBeenCalled();
});

it('confirming the print marks this school\'s generated cards, never an imported one', async () => {
  prisma.student.updateMany.mockResolvedValue({ count: 1 });

  const res = await request(app).post(`/api/schools/${SCHOOL}/qr-cards/printed`).set('Authorization', `Bearer ${admin}`).send({ studentIds: [S1] });

  expect(res.status).toBe(200);
  expect(res.body.confirmed).toBe(1);
  const { where, data } = prisma.student.updateMany.mock.calls[0][0];
  expect(where).toEqual({ id: { in: [S1] }, schoolId: SCHOOL, qrCodeImported: false });
  expect(data.qrCardPrintedAt).toBeInstanceOf(Date);
});

it('a replaced card gets a new code and reads as not printed', async () => {
  prisma.student.findUnique.mockResolvedValue({ id: S1, schoolId: SCHOOL });
  prisma.student.update.mockResolvedValue({});

  const res = await request(app).post(`/api/students/${S1}/qr-card/replace`).set('Authorization', `Bearer ${admin}`);

  expect(res.status).toBe(200);
  const { data } = prisma.student.update.mock.calls[0][0];
  expect(data).toEqual({ qrToken: expect.stringMatching(/^[0-9a-f]{32}$/), qrCodeImported: false, qrCardPrintedAt: null });
});

it('another school\'s child cannot have their card replaced', async () => {
  prisma.student.findUnique.mockResolvedValue({ id: S1, schoolId: 'another' });
  const res = await request(app).post(`/api/students/${S1}/qr-card/replace`).set('Authorization', `Bearer ${admin}`);
  expect(res.status).toBe(403);
  expect(prisma.student.update).not.toHaveBeenCalled();
});
