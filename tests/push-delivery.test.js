// pushToUsers records delivery per device from what FCM actually accepted. Before, every
// token not reported dead was stamped lastAcceptedAt = now, so a failed send looked like
// a delivered one.

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    user: { findMany: jest.fn(), updateMany: jest.fn() },
    pushDevice: { findMany: jest.fn(), updateMany: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

jest.mock('../firebase', () => ({
  sendPush: jest.fn(),
  isPushConfigured: jest.fn(() => true),
  syncGpsLogToFirebase: jest.fn(),
  syncEmergencyAlertToFirebase: jest.fn(),
  syncStudentToFirebase: jest.fn(),
  flushFirestore: jest.fn(),
  app: null, db: null, messaging: null,
}));

const { prisma, pushToUsers } = require('../server');
const { sendPush } = require('../firebase');

const payload = { title: 'Boarded the bus', body: 'Asha is on board.' };

beforeEach(() => {
  jest.clearAllMocks();
  prisma.user.findMany.mockResolvedValue([{ id: 'p1', fcmToken: null, notificationSettings: null }]);
  prisma.pushDevice.findMany.mockResolvedValue([{ token: 'ok' }, { token: 'wrong-project' }, { token: 'dead' }]);
  prisma.pushDevice.updateMany.mockResolvedValue({ count: 1 });
  prisma.user.updateMany.mockResolvedValue({ count: 0 });
});

const updatesTo = (field) =>
  prisma.pushDevice.updateMany.mock.calls.map(([arg]) => arg).filter((arg) => field in arg.data);

describe('pushToUsers delivery record', () => {
  it('stamps lastAcceptedAt only on tokens FCM accepted', async () => {
    sendPush.mockResolvedValue({
      sent: 1,
      accepted: ['ok'],
      invalidTokens: ['dead'],
      failed: [{ token: 'wrong-project', code: 'messaging/mismatched-credential' }],
    });

    await pushToUsers(['p1'], payload);

    const accepted = updatesTo('lastAcceptedAt');
    expect(accepted).toHaveLength(1);
    expect(accepted[0].where).toEqual({ token: { in: ['ok'] } });
  });

  it("records the failure code on a failed token and leaves its last delivery time alone", async () => {
    sendPush.mockResolvedValue({
      sent: 0,
      accepted: [],
      invalidTokens: [],
      failed: [{ token: 'wrong-project', code: 'messaging/mismatched-credential' }],
    });

    await pushToUsers(['p1'], payload);

    expect(prisma.pushDevice.updateMany).toHaveBeenCalledWith({
      where: { token: { in: ['wrong-project'] } },
      data: { lastFailure: 'messaging/mismatched-credential' },
    });
    expect(updatesTo('lastAcceptedAt')).toHaveLength(0);
  });

  it('stamps nothing as delivered when the whole send failed', async () => {
    const all = ['ok', 'wrong-project', 'dead'];
    sendPush.mockResolvedValue({
      sent: 0, accepted: [], invalidTokens: [],
      failed: all.map((token) => ({ token, code: 'app/invalid-credential' })),
    });

    await pushToUsers(['p1'], payload);

    expect(updatesTo('lastAcceptedAt')).toHaveLength(0);
    expect(prisma.pushDevice.updateMany).toHaveBeenCalledWith({
      where: { token: { in: all } },
      data: { lastFailure: 'app/invalid-credential' },
    });
  });

  it('treats a result with no per-token detail as nothing confirmed', async () => {
    // The old return shape. Absence of detail must never read as success.
    sendPush.mockResolvedValue({ sent: 0, invalidTokens: [] });

    await pushToUsers(['p1'], payload);

    expect(updatesTo('lastAcceptedAt')).toHaveLength(0);
  });

  it('still disables dead tokens', async () => {
    sendPush.mockResolvedValue({ sent: 0, accepted: [], invalidTokens: ['dead'], failed: [] });

    await pushToUsers(['p1'], payload);

    expect(prisma.pushDevice.updateMany).toHaveBeenCalledWith({
      where: { token: { in: ['dead'] } },
      data: { enabled: false, lastFailure: 'INVALID_TOKEN' },
    });
  });
});
