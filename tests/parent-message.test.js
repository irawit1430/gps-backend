// The school dashboard's "Message parent" posts to /api/parents/:parentId/messages. That
// route did not exist, so every message failed with a 404.

const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    user: { findUnique: jest.fn(), findMany: jest.fn() },
    notification: { create: jest.fn() },
    pushDevice: { findMany: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const { app, prisma } = require('../server');

const SECRET = process.env.JWT_SECRET;
const bearer = (claims) => `Bearer ${jwt.sign(claims, SECRET)}`;
const ADMIN = bearer({ id: 'admin-1', role: 'SCHOOL_ADMIN', schoolId: 's1' });
const OTHER_ADMIN = bearer({ id: 'admin-2', role: 'SCHOOL_ADMIN', schoolId: 's2' });
const DRIVER = bearer({ id: 'driver-1', role: 'DRIVER', schoolId: 's1' });
const PARENT = bearer({ id: 'parent-9', role: 'PARENT', schoolId: 's1' });

const send = (auth, body = { subject: 'Pickup change', message: 'Asha will be collected by her uncle today.' }) =>
  request(app).post('/api/parents/parent-1/messages').set('Authorization', auth).send(body);

beforeEach(() => {
  jest.clearAllMocks();
  prisma.user.findUnique.mockResolvedValue({ id: 'parent-1', role: 'PARENT', schoolId: 's1' });
  prisma.user.findMany.mockResolvedValue([]);
  prisma.notification.create.mockImplementation(async ({ data }) => ({ id: 'n-1', createdAt: new Date(), ...data }));
});

it("puts the school's message in the parent's notifications", async () => {
  const res = await send(ADMIN);

  expect(res.status).toBe(201);
  expect(res.body.id).toBe('n-1');
  expect(prisma.notification.create).toHaveBeenCalledWith({
    data: {
      userId: 'parent-1',
      title: 'Pickup change',
      message: 'Asha will be collected by her uncle today.',
      type: 'SYSTEM',
      context: { type: 'SCHOOL_MESSAGE', sentBy: 'admin-1' },
    },
  });
});

it("refuses another school's admin", async () => {
  expect((await send(OTHER_ADMIN)).status).toBe(403);
  expect(prisma.notification.create).not.toHaveBeenCalled();
});

it.each([['a driver', DRIVER], ['a parent', PARENT]])('refuses %s', async (_label, auth) => {
  expect((await send(auth)).status).toBe(403);
  expect(prisma.notification.create).not.toHaveBeenCalled();
});

it('only messages parent accounts', async () => {
  prisma.user.findUnique.mockResolvedValue({ id: 'parent-1', role: 'DRIVER', schoolId: 's1' });

  expect((await send(ADMIN)).status).toBe(404);
});

it('needs a subject and a message', async () => {
  expect((await send(ADMIN, { subject: '  ', message: 'x' })).status).toBe(400);
  expect((await send(ADMIN, { subject: 'x' })).status).toBe(400);
  expect(prisma.notification.create).not.toHaveBeenCalled();
});
