// firebase.sendPush must say what happened to each token. It used to return only the
// dead ones, and its caller counted every other token as delivered — so a revoked key or
// a wrong Firebase project read as a successful push on every device.

const mockSend = jest.fn();

jest.mock('firebase-admin/app', () => ({
  initializeApp: jest.fn(() => ({})),
  cert: jest.fn(() => ({})),
  getApps: jest.fn(() => []),
}));
jest.mock('firebase-admin/firestore', () => ({ getFirestore: jest.fn(() => ({})), FieldValue: {} }));
jest.mock('firebase-admin/messaging', () => ({
  getMessaging: jest.fn(() => ({ sendEachForMulticast: mockSend })),
}));

const loadFirebase = (serviceAccount) => {
  let mod;
  jest.isolateModules(() => {
    if (serviceAccount) process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify(serviceAccount);
    else delete process.env.FIREBASE_SERVICE_ACCOUNT;
    mod = require('../firebase');
  });
  return mod;
};

afterAll(() => {
  delete process.env.FIREBASE_SERVICE_ACCOUNT;
});

describe('sendPush', () => {
  const { sendPush } = loadFirebase({ project_id: 'voltava-1', client_email: 'x', private_key: 'y' });

  beforeEach(() => mockSend.mockReset());

  it('sorts each token into accepted, invalid, or failed with its code', async () => {
    mockSend.mockResolvedValue({
      successCount: 1,
      failureCount: 3,
      responses: [
        { success: true },
        { success: false, error: { code: 'messaging/registration-token-not-registered' } },
        { success: false, error: { code: 'messaging/mismatched-credential' } },
        { success: false, error: { code: 'messaging/quota-exceeded' } },
      ],
    });

    const res = await sendPush(['ok', 'dead', 'wrong-project', 'quota'], { title: 't', body: 'b' });

    expect(res).toEqual({
      sent: 1,
      accepted: ['ok'],
      invalidTokens: ['dead'],
      failed: [
        { token: 'wrong-project', code: 'messaging/mismatched-credential' },
        { token: 'quota', code: 'messaging/quota-exceeded' },
      ],
    });
  });

  it('accepts nothing when the whole call throws', async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('Credential revoked'), { code: 'app/invalid-credential' }));

    const res = await sendPush(['a', 'b'], { title: 't', body: 'b' });

    expect(res.accepted).toEqual([]);
    expect(res.failed).toEqual([
      { token: 'a', code: 'app/invalid-credential' },
      { token: 'b', code: 'app/invalid-credential' },
    ]);
  });
});

describe('sendPush without a service account', () => {
  it('reports every token as not delivered rather than returning silently', async () => {
    const { sendPush } = loadFirebase(null);

    const res = await sendPush(['a'], { title: 't', body: 'b' });

    expect(res.accepted).toEqual([]);
    expect(res.failed).toEqual([{ token: 'a', code: 'push-not-configured' }]);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
