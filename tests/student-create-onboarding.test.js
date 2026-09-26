// Add student saves the child, the parent's account and the stop together, or nothing.
// Two requests used to leave a child created with no stop when the second one failed.

const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const tx = {
    user: { findFirst: jest.fn(), create: jest.fn() },
    student: { create: jest.fn() },
    studentRouteMapping: { create: jest.fn() },
  };
  const mockPrisma = {
    routeStop: { findUnique: jest.fn() },
    $transaction: jest.fn(async (fn) => fn(tx)),
    __tx: tx,
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const { app, prisma } = require('../server');

const SECRET = process.env.JWT_SECRET;
const SCHOOL = '11111111-1111-4111-8111-111111111111';
const STOP = '77777777-7777-4777-8777-777777777777';
const admin = jwt.sign({ id: 'a1', role: 'SCHOOL_ADMIN', schoolId: SCHOOL }, SECRET);
const create = (body) => request(app).post(`/api/schools/${SCHOOL}/students`).set('Authorization', `Bearer ${admin}`).send(body);

beforeEach(() => {
  jest.clearAllMocks();
  prisma.__tx.user.findFirst.mockResolvedValue(null);
  prisma.__tx.user.create.mockImplementation(({ data }) => Promise.resolve({ id: 'p1', ...data }));
  prisma.__tx.student.create.mockImplementation(({ data }) => Promise.resolve({ id: 's1', ...data }));
  prisma.routeStop.findUnique.mockResolvedValue({ route: { schoolId: SCHOOL } });
});

it('creates the child, their parent and their stop in one transaction', async () => {
  const res = await create({ name: 'Asha', rfidTag: 'A-1', parentEmail: 'sunita@mail.com', guardianPhone: '9876543210', routeStopId: STOP, direction: 'TO_SCHOOL' });

  expect(res.status).toBe(200);
  expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  expect(prisma.__tx.studentRouteMapping.create).toHaveBeenCalledWith({ data: { studentId: 's1', routeStopId: STOP, direction: 'TO_SCHOOL' } });
  expect(prisma.__tx.user.create.mock.calls[0][0].data).toMatchObject({ phone: '9876543210', mustResetPassword: true });
  expect(res.body).toMatchObject({ stopAssigned: true, parent: { id: 'p1', created: true, invited: false } });
  expect(res.body.student.qrToken).toBeUndefined();
});

it('saves nothing when the stop cannot be saved', async () => {
  prisma.__tx.studentRouteMapping.create.mockRejectedValue(new Error('db down'));
  const res = await create({ name: 'Asha', routeStopId: STOP });
  // The transaction threw, so Postgres rolled the child back with it.
  expect(res.status).toBe(500);
});

it('refuses another school\'s stop before creating anything', async () => {
  prisma.routeStop.findUnique.mockResolvedValue({ route: { schoolId: 'another' } });
  const res = await create({ name: 'Asha', routeStopId: STOP });
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/not on one of this school's routes/);
  expect(prisma.$transaction).not.toHaveBeenCalled();
});

it('links the parent the school already has, whatever the case of the email', async () => {
  prisma.__tx.user.findFirst.mockResolvedValue({ id: 'p-old', role: 'PARENT', schoolId: SCHOOL });
  const res = await create({ name: 'Arun', parentEmail: 'Sunita@Mail.com' });
  expect(res.status).toBe(200);
  expect(prisma.__tx.user.findFirst.mock.calls[0][0].where).toEqual({ email: { equals: 'sunita@mail.com', mode: 'insensitive' } });
  expect(prisma.__tx.user.create).not.toHaveBeenCalled();
  expect(res.body.parent).toMatchObject({ id: 'p-old', created: false });
});
