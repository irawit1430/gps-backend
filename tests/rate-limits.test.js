// Rate limits used to be per IP address for everything. A mobile operator puts many
// phones behind one address, so buses and families on one network shared a single
// 300-a-minute budget: with 500 buses on one address, 88% of GPS was refused.

process.env.RATE_LIMIT_GLOBAL_PER_MIN = '3';
process.env.RATE_LIMIT_TELEMETRY_PER_DEVICE_PER_MIN = '2';
process.env.RATE_LIMIT_PER_IP_PER_MIN = '25'; // the three cases below share one address

const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = { bus: { findUnique: jest.fn() }, user: { findUnique: jest.fn() } };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const { app, prisma } = require('../server');

beforeEach(() => prisma.bus.findUnique.mockResolvedValue(null)); // unknown bus: 404, cheap

const gps = (deviceId) => request(app).post('/api/telemetry').send({ deviceId, lat: 25.6, lng: 85.1, speed: 10 });
const statuses = async (n, fn) => { const out = []; for (let i = 0; i < n; i++) out.push((await fn()).status); return out; };

it('gives every bus its own GPS budget, whatever address it shares', async () => {
  // Five buses behind one address, two fixes each: none is refused.
  for (const bus of ['b1', 'b2', 'b3', 'b4', 'b5']) {
    expect(await statuses(2, () => gps(bus))).not.toContain(429);
  }
  // A third from one bus inside the minute is.
  expect((await gps('b1')).status).toBe(429);
});

it('gives every signed-in user their own budget', async () => {
  const tokens = Object.fromEntries(['p1', 'p2'].map((id) => [id, `Bearer ${jwt.sign({ id, role: 'PARENT', schoolId: 's1' }, process.env.JWT_SECRET)}`]));
  const me = (id) => () => request(app).get('/api/users/me').set('Authorization', tokens[id]);

  expect(await statuses(3, me('p1'))).not.toContain(429);
  expect(await statuses(3, me('p2'))).not.toContain(429); // same address, own budget
  expect((await me('p1')()).status).toBe(429);
});

it('still caps one address, far above any one user', async () => {
  const res = await statuses(30, () => gps(`spray-${Math.random()}`));

  expect(res.filter((s) => s === 429).length).toBeGreaterThan(0);
});
