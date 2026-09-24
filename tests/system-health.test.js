// Whole-system alarms: no GPS from any bus while trips run, or push failing across the
// board. Both hit every school at once and neither showed up anywhere.

const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    trip: { count: jest.fn() },
    user: { findMany: jest.fn() },
    notification: { createMany: jest.fn() },
    pushDevice: { findMany: jest.fn(), updateMany: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const { app, prisma, notifySuperAdmins } = require('../server');
const health = require('../systemHealth');

const MIN = 60_000;
const opts = { gpsSilenceMinutes: 10, pushWindowMinutes: 30, pushMinAttempts: 20, pushFailRate: 0.5 };
let notify;
const sweep = (now) => health.sweepSystemHealth(prisma, { ...opts, notify, now });

beforeEach(() => {
  jest.clearAllMocks();
  health.reset();
  notify = jest.fn();
  prisma.trip.count.mockResolvedValue(3);
});

describe('GPS intake', () => {
  it('raises the alarm once when no bus has reported for 10 minutes while trips run', async () => {
    const t0 = Date.now();
    health.noteFix(t0);

    await sweep(t0 + 9 * MIN);
    expect(notify).not.toHaveBeenCalled();

    await sweep(t0 + 10 * MIN);
    await sweep(t0 + 12 * MIN);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({
      check: 'GPS_INTAKE', status: 'DOWN', title: 'No GPS from any bus',
      detail: { runningTrips: 3, quietMinutes: 10 },
    });
  });

  it('says so when positions come back', async () => {
    const t0 = Date.now();
    health.noteFix(t0);
    await sweep(t0 + 10 * MIN);

    health.noteFix(t0 + 14 * MIN);
    await sweep(t0 + 14 * MIN);

    expect(notify.mock.calls.map(([n]) => n.status)).toEqual(['DOWN', 'RECOVERED']);
    expect(notify.mock.calls[1][0].message).toMatch(/after about 4 minutes/);
  });

  it('stays quiet at night, when nothing is running', async () => {
    prisma.trip.count.mockResolvedValue(0);
    await sweep(Date.now() + 120 * MIN);

    expect(notify).not.toHaveBeenCalled();
  });

  it('counts a fresh start from when the server started, not from never', async () => {
    await sweep(Date.now() + 5 * MIN);

    expect(notify).not.toHaveBeenCalled();
  });
});

describe('push delivery', () => {
  const pushes = (n, outcome) => {
    for (let i = 0; i < n; i++) health.notePush(outcome);
  };

  it('raises the alarm when most pushes fail, naming the usual reason', async () => {
    pushes(15, { failed: 1, codes: ['messaging/mismatched-credential'] });
    pushes(5, { accepted: 1 });
    pushes(2, { failed: 1, codes: ['messaging/internal-error'] });

    await sweep(Date.now());

    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      check: 'PUSH_DELIVERY', status: 'DOWN',
      detail: { attempts: 22, failed: 17, topReason: 'messaging/mismatched-credential' },
    }));
  });

  it('does not alarm on a handful of sends', async () => {
    pushes(5, { failed: 1, codes: ['x'] });
    await sweep(Date.now());

    expect(notify).not.toHaveBeenCalled();
  });

  it('forgets failures older than the window', async () => {
    pushes(30, { failed: 1, codes: ['x'] });
    await sweep(Date.now() + 31 * MIN);

    expect(notify.mock.calls.filter(([n]) => n.check === 'PUSH_DELIVERY')).toEqual([]);
  });
});

describe('telling the super admins', () => {
  it('puts it in every super admin\'s bell', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'sa1' }, { id: 'sa2' }]);

    await notifySuperAdmins({ check: 'GPS_INTAKE', status: 'DOWN', title: 'No GPS from any bus', message: 'm', detail: { runningTrips: 2 } });

    expect(prisma.notification.createMany).toHaveBeenCalledWith({
      data: ['sa1', 'sa2'].map((userId) => ({
        userId, title: 'No GPS from any bus', message: 'm', type: 'SYSTEM',
        context: { type: 'SYSTEM_HEALTH', check: 'GPS_INTAKE', status: 'DOWN', runningTrips: 2 },
      })),
    });
  });

  it('shows the current state to super admins only', async () => {
    const bearer = (role) => `Bearer ${jwt.sign({ id: 'u', role, schoolId: role === 'SUPER_ADMIN' ? null : 's1' }, process.env.JWT_SECRET)}`;
    health.notePush({ accepted: 3 });

    const res = await request(app).get('/api/admin/system-health').set('Authorization', bearer('SUPER_ADMIN'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ runningTrips: 3, push: { accepted: 3, failed: 0 }, alarms: [] });

    expect((await request(app).get('/api/admin/system-health').set('Authorization', bearer('SCHOOL_ADMIN'))).status).toBe(403);
  });
});
