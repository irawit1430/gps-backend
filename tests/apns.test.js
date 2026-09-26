// iPhones get their alerts from Apple directly. Same contract as the Android sender:
// what happened to each token, never a count, and a dead token is dropped.

const crypto = require('crypto');

const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const P8 = privateKey.export({ type: 'pkcs8', format: 'pem' });

const load = (env) => {
  let mod;
  jest.isolateModules(() => {
    for (const k of ['APNS_KEY', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_BUNDLE_ID']) delete process.env[k];
    Object.assign(process.env, env);
    mod = require('../apns');
  });
  return mod;
};
const full = { APNS_KEY: P8, APNS_KEY_ID: 'KEY1234567', APNS_TEAM_ID: 'TEAM123456', APNS_BUNDLE_ID: 'com.voltava.in' };

afterAll(() => { for (const k of Object.keys(full)) delete process.env[k]; });

describe('the .p8 key', () => {
  const { readKey } = load({});
  it.each([
    ['as pasted', P8],
    ['with escaped newlines', P8.replace(/\n/g, '\\n')],
    ['as base64 of the file', Buffer.from(P8).toString('base64')],
  ])('is read %s', (_label, raw) => {
    expect(readKey(raw)).toBe(P8.trim());
  });

  it('is refused when it is not a key', () => {
    expect(readKey('not a key')).toBeNull();
  });
});

describe('sendApns', () => {
  it('stays off without all four settings, and says so per token', async () => {
    const { sendApns, isApnsConfigured } = load({ APNS_KEY: P8, APNS_KEY_ID: 'K' });
    expect(isApnsConfigured()).toBe(false);
    const res = await sendApns(['t1'], { title: 't', body: 'b' });
    expect(res).toEqual({ sent: 0, invalidTokens: [], accepted: [], failed: [{ token: 't1', code: 'apns-not-configured' }] });
  });

  it('sorts each token by Apple\'s answer', async () => {
    const { sendApns, isApnsConfigured } = load(full);
    expect(isApnsConfigured()).toBe(true);
    const answers = { ok: { status: 200 }, gone: { status: 410, reason: 'Unregistered' }, bad: { status: 400, reason: 'BadDeviceToken' }, busy: { status: 429, reason: 'TooManyRequests' }, down: { status: 0, reason: 'timeout' } };
    const transport = jest.fn(async (token) => answers[token]);

    const res = await sendApns(Object.keys(answers), { title: 'Asha boarded', body: 'Bus BR01 at 7:22', data: { studentId: 's1', n: 2 } }, transport);

    expect(res).toEqual({
      sent: 1, accepted: ['ok'], invalidTokens: ['gone', 'bad'],
      failed: [{ token: 'busy', code: 'apns/TooManyRequests' }, { token: 'down', code: 'apns/timeout' }],
    });
    const [, headers, body] = transport.mock.calls[0];
    expect(headers).toMatchObject({ 'apns-topic': 'com.voltava.in', 'apns-push-type': 'alert', 'apns-priority': '10' });
    expect(JSON.parse(body)).toEqual({ aps: { alert: { title: 'Asha boarded', body: 'Bus BR01 at 7:22' }, sound: 'default' }, studentId: 's1', n: '2' });

    // A signed ES256 token for the team and key, reused across sends.
    const bearer = headers.authorization.replace('bearer ', '');
    const [head, claims] = bearer.split('.').slice(0, 2).map((p) => JSON.parse(Buffer.from(p, 'base64url').toString()));
    expect(head).toEqual({ alg: 'ES256', kid: 'KEY1234567', typ: 'JWT' });
    expect(claims.iss).toBe('TEAM123456');
    await sendApns(['ok'], { title: 'x' }, transport);
    expect(transport.mock.calls.at(-1)[1].authorization).toBe(headers.authorization);
  });
});
