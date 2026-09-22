const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const config = require('./config');
const logger = require('./logger');

let serviceAccount = null;

if (config.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const raw = config.FIREBASE_SERVICE_ACCOUNT.trim();
    serviceAccount = raw.startsWith('{')
      ? JSON.parse(raw)
      : JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch (err) {
    logger.warn({ err: err.message }, 'FIREBASE_SERVICE_ACCOUNT parse failed');
  }
}

let app = null;
let db = null;
let messaging = null;

if (serviceAccount) {
  try {
    const apps = getApps();
    app = apps.length
      ? apps[0]
      : initializeApp({ credential: cert(serviceAccount), projectId: serviceAccount.project_id });
    db = getFirestore(app);
    messaging = getMessaging(app);
    logger.info({ projectId: serviceAccount.project_id }, 'Firebase initialized');
  } catch (err) {
    logger.error({ err: err.message }, 'Firebase initialization failed');
  }
} else {
  logger.warn('Firebase disabled — no FIREBASE_SERVICE_ACCOUNT configured');
}

// ─── Retry helper ──────────────────────────────────────────
async function withRetry(fn, attempts = 3, baseDelayMs = 200) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i));
    }
  }
  throw lastErr;
}

// ─── Per-bus debouncer: coalesce gps_logs writes to at most one per 15s ──
// The `buses/{id}` merge always runs on every packet (cheap, idempotent).
const GPS_LOG_INTERVAL_MS = 15000;
const pendingGpsLogWrites = new Map(); // busId → { timer, latest }

function scheduleGpsLogFlush(busId) {
  const entry = pendingGpsLogWrites.get(busId);
  if (!entry || entry.timer) return;
  entry.timer = setTimeout(async () => {
    const data = entry.latest;
    pendingGpsLogWrites.delete(busId);
    if (!db || !data) return;
    
    // 1. Append to gps_logs
    try {
      await withRetry(() =>
        db.collection('gps_logs').add({
          busId: data.busId,
          licensePlate: data.licensePlate || 'unassigned',
          lat: data.lat,
          lng: data.lng,
          speed: data.speed || 0,
          timestamp: data.timestamp ? new Date(data.timestamp).toISOString() : new Date().toISOString(),
          createdAt: FieldValue.serverTimestamp(),
        })
      );
    } catch (err) {
      logger.error({ err: err.message, busId }, 'Firestore gps_log write failed after retries');
    }

    // 2. Update buses snapshot (debounced together to save huge costs)
    try {
      await withRetry(() =>
        db.collection('buses').doc(data.busId).set(
          {
            busId: data.busId,
            licensePlate: data.licensePlate || 'unassigned',
            lastKnownLat: data.lat,
            lastKnownLng: data.lng,
            speed: data.speed || 0,
            status: 'ONLINE',
            lastUpdate: FieldValue.serverTimestamp(),
          },
          { merge: true }
        )
      );
    } catch (err) {
      logger.error({ err: err.message, busId: data.busId }, 'Firestore bus snapshot write failed');
    }
  }, GPS_LOG_INTERVAL_MS);
}

async function syncGpsLogToFirebase(data) {
  if (!db || !data?.busId) return;

  // Debounced append to gps_logs and buses snapshot
  const entry = pendingGpsLogWrites.get(data.busId) || { timer: null, latest: null };
  entry.latest = data;
  pendingGpsLogWrites.set(data.busId, entry);
  scheduleGpsLogFlush(data.busId);
}

async function syncEmergencyAlertToFirebase(alertData) {
  if (!db) return;
  try {
    await withRetry(() =>
      db.collection('emergency_alerts').add({
        schoolId: alertData.schoolId || 'unknown',
        type: alertData.type || 'HARDWARE_SOS',
        message: alertData.message || 'SOS Triggered',
        status: alertData.status || 'ACTIVE',
        createdAt: FieldValue.serverTimestamp(),
      })
    );
  } catch (err) {
    logger.error({ err: err.message }, 'Firestore emergency alert write failed');
  }
}

async function syncStudentToFirebase(studentData) {
  if (!db) return;
  try {
    await withRetry(() =>
      db.collection('students').doc(studentData.id).set(
        {
          studentId: studentData.id,
          schoolId: studentData.schoolId,
          name: studentData.name,
          rfidTag: studentData.rfidTag,
          grade: studentData.grade || 'General',
          parentId: studentData.parentId || null,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
    );
  } catch (err) {
    logger.error({ err: err.message }, 'Firestore student write failed');
  }
}

// Flush pending Firestore writes (called during graceful shutdown).
async function flushFirestore() {
  for (const [busId, entry] of pendingGpsLogWrites.entries()) {
    if (entry.timer) clearTimeout(entry.timer);
    if (db && entry.latest) {
      try {
        await db.collection('gps_logs').add({
          busId: entry.latest.busId,
          licensePlate: entry.latest.licensePlate || 'unassigned',
          lat: entry.latest.lat,
          lng: entry.latest.lng,
          speed: entry.latest.speed || 0,
          timestamp: new Date().toISOString(),
          createdAt: FieldValue.serverTimestamp(),
        });
      } catch (err) {
        logger.warn({ err: err.message, busId }, 'Firestore flush failed');
      }
    }
  }
  pendingGpsLogWrites.clear();
}

// ─── OS push (FCM) ─────────────────────────────────────────
// Fire-and-forget delivery to device tokens. Returns the tokens FCM rejected as
// permanently invalid so the caller can clear them — a stale token otherwise sticks
// on the row forever and every future send wastes a round trip on it.
// Returns what happened to each token, not just a count:
//   accepted       FCM took the message for this token
//   invalidTokens  FCM says the token is dead (uninstalled / re-registered)
//   failed         anything else, with FCM's code — a wrong-project credential
//                  ('messaging/mismatched-credential'), quota, an outage
// Callers record delivery from `accepted` alone. This used to return only the dead
// tokens, and the caller counted every other token as delivered, so a revoked key or a
// wrong Firebase project was stamped as a successful push on every device.
async function sendPush(tokens, { title, body, data } = {}) {
  const list = [...new Set((Array.isArray(tokens) ? tokens : [tokens]).filter(Boolean))];
  if (list.length === 0) return { sent: 0, invalidTokens: [], accepted: [], failed: [] };
  if (!messaging) {
    return {
      sent: 0, invalidTokens: [], accepted: [],
      failed: list.map((token) => ({ token, code: 'push-not-configured' })),
    };
  }

  // FCM data values must be strings.
  const stringData = Object.fromEntries(
    Object.entries(data || {}).map(([k, v]) => [k, v == null ? '' : String(v)])
  );

  try {
    const res = await messaging.sendEachForMulticast({
      tokens: list,
      notification: { title, body },
      data: stringData,
    });
    const invalidTokens = [];
    const accepted = [];
    const failed = [];
    res.responses.forEach((r, i) => {
      if (r.success) {
        accepted.push(list[i]);
        return;
      }
      const code = r.error?.code || 'unknown';
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-argument') {
        invalidTokens.push(list[i]);
      } else {
        failed.push({ token: list[i], code });
      }
    });
    if (res.failureCount > 0) {
      logger.warn(
        { failureCount: res.failureCount, invalid: invalidTokens.length, codes: [...new Set(failed.map((f) => f.code))] },
        'FCM: some sends failed'
      );
    }
    return { sent: res.successCount, invalidTokens, accepted, failed };
  } catch (err) {
    // The whole call failed (revoked key, network, outage): nothing was delivered.
    const code = err.code || 'send-failed';
    logger.error({ err: err.message, code }, 'FCM send failed');
    return { sent: 0, invalidTokens: [], accepted: [], failed: list.map((token) => ({ token, code })) };
  }
}

// Whether push can actually be delivered. Callers that promise a user something
// must be able to ask rather than assume — sendPush no-ops silently without a
// service account, which is a failure with no signal anywhere.
function isPushConfigured() {
  return Boolean(messaging);
}

module.exports = {
  sendPush,
  isPushConfigured,
  app,
  db,
  messaging,
  syncGpsLogToFirebase,
  syncEmergencyAlertToFirebase,
  syncStudentToFirebase,
  flushFirestore,
};
