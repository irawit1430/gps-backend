// Push to iPhones, straight to Apple.
//
// firebase-admin sends to FCM registration tokens. An iPhone running the parent app
// gives an APNs device token instead, which FCM rejects, so iPhone families got no
// alerts at all. This talks to Apple's push service directly (HTTP/2, token auth), with
// the same contract as firebase.sendPush: what happened to each token, never a count.
//
// Off until the four APNS_* settings are present. Off means iPhones register (so the
// school can see who is on an iPhone) and nothing is sent to them; the school's
// activation page and the parent app both say so.

const http2 = require('http2');
const jwt = require('jsonwebtoken');
const config = require('./config');
const logger = require('./logger');

// A .p8 key pasted into an environment variable arrives in one of three shapes: the PEM
// as is, the PEM with its newlines escaped, or base64 of the file.
function readKey(raw) {
  if (!raw) return null;
  const text = raw.trim();
  if (text.includes('BEGIN PRIVATE KEY')) return text.replace(/\\n/g, '\n').trim();
  try {
    const decoded = Buffer.from(text, 'base64').toString('utf8');
    if (decoded.includes('BEGIN PRIVATE KEY')) return decoded.trim();
  } catch { /* not base64 */ }
  return null;
}

const key = readKey(config.APNS_KEY);
const settings = key && config.APNS_KEY_ID && config.APNS_TEAM_ID && config.APNS_BUNDLE_ID
  ? {
      key, keyId: config.APNS_KEY_ID, teamId: config.APNS_TEAM_ID, topic: config.APNS_BUNDLE_ID,
      host: config.APNS_PRODUCTION ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com',
    }
  : null;
if (config.APNS_KEY && !key) logger.warn('APNS_KEY is set but is not a readable .p8 key; iPhone push stays off');
if (settings) logger.info({ host: settings.host, topic: settings.topic }, 'APNs configured');

const isApnsConfigured = () => Boolean(settings);

// Apple wants the signing token reused for up to an hour and refreshed no more than
// every 20 minutes; a new one per request gets TooManyProviderTokenUpdates.
let cachedToken = null;
function providerToken(now = Date.now()) {
  if (cachedToken && now - cachedToken.at < 40 * 60 * 1000) return cachedToken.value;
  const value = jwt.sign({ iss: settings.teamId, iat: Math.floor(now / 1000) }, settings.key, {
    algorithm: 'ES256', header: { alg: 'ES256', kid: settings.keyId },
  });
  cachedToken = { value, at: now };
  return value;
}

// One HTTP/2 connection, reopened when Apple or the network closes it.
let session = null;
function connection() {
  if (session && !session.closed && !session.destroyed) return session;
  session = http2.connect(settings.host);
  session.on('error', (err) => logger.warn({ err: err.message }, 'APNs connection error'));
  session.on('goaway', () => { session = null; });
  session.unref?.();
  return session;
}

function post(deviceToken, headers, body) {
  return new Promise((resolve) => {
    let req;
    try {
      req = connection().request({ ':method': 'POST', ':path': `/3/device/${deviceToken}`, ...headers });
    } catch (err) {
      resolve({ status: 0, reason: err.code || 'connect-failed' });
      return;
    }
    let status = 0;
    let data = '';
    req.setEncoding('utf8');
    req.setTimeout(10_000, () => { req.close(); resolve({ status: 0, reason: 'timeout' }); });
    req.on('response', (h) => { status = h[':status']; });
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      let reason = null;
      try { reason = data ? JSON.parse(data).reason : null; } catch { reason = null; }
      resolve({ status, reason });
    });
    req.on('error', (err) => resolve({ status: 0, reason: err.code || 'request-failed' }));
    req.end(body);
  });
}

// What Apple's answer means for the token. 410, and a 400 BadDeviceToken, mean the token
// is dead: the app was deleted, or it belongs to the other environment.
const DEAD = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);

/**
 * Send one alert to many iPhones. Same shape as firebase.sendPush:
 * { sent, accepted: [token], invalidTokens: [token], failed: [{ token, code }] }.
 * `transport` is for tests.
 */
async function sendApns(tokens, { title, body, data } = {}, transport = post) {
  const list = [...new Set((Array.isArray(tokens) ? tokens : [tokens]).filter(Boolean))];
  if (list.length === 0) return { sent: 0, invalidTokens: [], accepted: [], failed: [] };
  if (!settings) {
    return { sent: 0, invalidTokens: [], accepted: [], failed: list.map((token) => ({ token, code: 'apns-not-configured' })) };
  }

  const payload = JSON.stringify({
    aps: { alert: { title, body }, sound: 'default' },
    // Same data the Android alert carries, so a tap opens the same screen.
    ...Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k, v == null ? '' : String(v)])),
  });
  const headers = {
    authorization: `bearer ${providerToken()}`,
    'apns-topic': settings.topic,
    'apns-push-type': 'alert',
    'apns-priority': '10',
    'content-type': 'application/json',
  };

  const accepted = [];
  const invalidTokens = [];
  const failed = [];
  const results = await Promise.all(list.map((token) => transport(token, headers, payload)));
  results.forEach(({ status, reason }, i) => {
    if (status === 200) accepted.push(list[i]);
    else if (status === 410 || DEAD.has(reason)) invalidTokens.push(list[i]);
    else failed.push({ token: list[i], code: `apns/${reason || status || 'no-response'}` });
  });
  if (failed.length || invalidTokens.length) {
    logger.warn({ failed: failed.length, invalid: invalidTokens.length, codes: [...new Set(failed.map((f) => f.code))] }, 'APNs: some sends failed');
  }
  return { sent: accepted.length, invalidTokens, accepted, failed };
}

module.exports = { sendApns, isApnsConfigured, readKey };
