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
  }, GPS_LOG_INTERVAL_MS);
}

async function syncGpsLogToFirebase(data) {
  if (!db || !data?.busId) return;

  // 1. Debounced append to gps_logs
  const entry = pendingGpsLogWrites.get(data.busId) || { timer: null, latest: null };
  entry.latest = data;
  pendingGpsLogWrites.set(data.busId, entry);
  scheduleGpsLogFlush(data.busId);

  // 2. Always-fresh `buses/{id}` snapshot (single doc merge — cheap & idempotent)
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

module.exports = {
  app,
  db,
  messaging,
  syncGpsLogToFirebase,
  syncEmergencyAlertToFirebase,
  syncStudentToFirebase,
  flushFirestore,
};
