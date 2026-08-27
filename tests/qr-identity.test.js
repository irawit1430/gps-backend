const request = require('supertest');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    trip: { findMany: jest.fn() },
    leaveApplication: { findMany: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const { app, prisma } = require('../server');
const SECRET = process.env.JWT_SECRET;

const TOKEN = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const EXPECTED = crypto.createHash('sha256').update(TOKEN).digest('hex');

const tripWith = (students) => ({
  id: 'trip-A',
  status: 'ON_SCHEDULE',
  route: {
    name: 'R1',
    stops: [{ name: 'Stop 1', orderIdx: 0, studentMappings: students.map((s) => ({ student: s })) }],
  },
  bus: { id: 'bus-1' },
  attendanceLogs: [],
});

describe('driver roster QR identity', () => {
  let token;

  beforeEach(() => {
    jest.clearAllMocks();
    token = jwt.sign({ id: 'driver-1', role: 'DRIVER' }, SECRET);
    prisma.leaveApplication.findMany.mockResolvedValue([]);
  });

  const get = () =>
    request(app).get('/api/drivers/driver-1/trips').set('Authorization', `Bearer ${token}`);

  // The whole point of a separate token: a driver's phone can verify a card without
  // ever holding the thing that makes one.
  it('sends the hash and never the token', async () => {
    prisma.trip.findMany.mockResolvedValue([
      tripWith([{ id: 's1', name: 'Asha', qrToken: TOKEN }]),
    ]);

    const res = await get();

    expect(res.status).toBe(200);
    const student = res.body[0].route.stops[0].studentMappings[0].student;
    expect(student.qrHash).toBe(EXPECTED);
    expect(student.qrToken).toBeUndefined();

    // and belt-and-braces: the token must not appear anywhere in the payload
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
  });

  it('sends null rather than a hash of nothing when a child has no code', async () => {
    prisma.trip.findMany.mockResolvedValue([
      tripWith([{ id: 's2', name: 'Ravi', qrToken: null }]),
    ]);

    const student = (await get()).body[0].route.stops[0].studentMappings[0].student;
    expect(student.qrHash).toBeNull();
    expect(student.qrToken).toBeUndefined();
  });

  it('hashes every child on every stop, not just the first', async () => {
    const other = 'f' .repeat(32);
    prisma.trip.findMany.mockResolvedValue([
      tripWith([
        { id: 's1', name: 'Asha', qrToken: TOKEN },
        { id: 's3', name: 'Meera', qrToken: other },
      ]),
    ]);

    const mappings = (await get()).body[0].route.stops[0].studentMappings;
    expect(mappings[0].student.qrHash).toBe(EXPECTED);
    expect(mappings[1].student.qrHash).toBe(crypto.createHash('sha256').update(other).digest('hex'));
    expect(JSON.stringify(mappings)).not.toContain(other);
  });
});
