// One alert, two senders: Android tokens to FCM, iPhone tokens to Apple. An iPhone is
// only sent to when Apple push is set up; until then it is not a failed push either.

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    user: { findMany: jest.fn(), updateMany: jest.fn() },
    pushDevice: { findMany: jest.fn(), updateMany: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});
jest.mock('../firebase', () => ({
  sendPush: jest.fn(async (tokens) => ({ invalidTokens: [], accepted: tokens, failed: [] })),
  isPushConfigured: jest.fn(() => true),
  syncGpsLogToFirebase: jest.fn(), syncEmergencyAlertToFirebase: jest.fn(), syncStudentToFirebase: jest.fn(),
}));
jest.mock('../apns', () => ({
  sendApns: jest.fn(async (tokens) => ({ invalidTokens: ['ios-dead'], accepted: tokens.filter((t) => t !== 'ios-dead'), failed: [] })),
  isApnsConfigured: jest.fn(() => true),
}));

const { prisma, pushToUsers } = require('../server');
const { sendPush } = require('../firebase');
const { sendApns, isApnsConfigured } = require('../apns');
const systemHealth = require('../systemHealth');

beforeEach(() => {
  jest.clearAllMocks();
  systemHealth.reset();
  prisma.user.findMany.mockResolvedValue([{ id: 'p1', fcmToken: null, notificationSettings: {} }]);
  prisma.pushDevice.findMany.mockResolvedValue([
    { token: 'android-1', provider: 'FCM' },
    { token: 'ios-1', provider: 'APNS' },
    { token: 'ios-dead', provider: 'APNS' },
  ]);
});

it('sends each token through its own provider and records both results', async () => {
  await pushToUsers(['p1'], { title: 'Asha boarded', body: '7:22' });

  expect(sendPush).toHaveBeenCalledWith(['android-1'], expect.any(Object));
  expect(sendApns).toHaveBeenCalledWith(['ios-1', 'ios-dead'], expect.any(Object));
  const accepted = prisma.pushDevice.updateMany.mock.calls.find((c) => c[0].data.lastAcceptedAt)[0];
  expect(accepted.where.token.in).toEqual(['android-1', 'ios-1']);
  const dead = prisma.pushDevice.updateMany.mock.calls.find((c) => c[0].data.lastFailure === 'INVALID_TOKEN')[0];
  expect(dead.where.token.in).toEqual(['ios-dead']);
});

it('leaves iPhones alone while Apple push is not set up', async () => {
  isApnsConfigured.mockReturnValue(false);
  await pushToUsers(['p1'], { title: 't', body: 'b' });
  expect(sendApns).not.toHaveBeenCalled();
  expect(sendPush).toHaveBeenCalledWith(['android-1'], expect.any(Object));
});
