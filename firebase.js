const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

let serviceAccount = null;

// 1. Try reading from FIREBASE_SERVICE_ACCOUNT environment variable (JSON string or base64)
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const rawEnv = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
    if (rawEnv.startsWith('{')) {
      serviceAccount = JSON.parse(rawEnv);
    } else {
      // Decode Base64 string
      const decoded = Buffer.from(rawEnv, 'base64').toString('utf8');
      serviceAccount = JSON.parse(decoded);
    }
  } catch (err) {
    console.warn('[Firebase] Failed to parse FIREBASE_SERVICE_ACCOUNT env var:', err.message);
  }
}

// 2. Fallback to local service account key file
if (!serviceAccount) {
  const possiblePaths = [
    path.join(__dirname, 'firebase-key.json'),
    'C:\\Users\\ANURAG TIWARI\\Downloads\\lost-and-found-29d1f-firebase-adminsdk-fbsvc-9d5054f63d.json'
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      try {
        serviceAccount = JSON.parse(fs.readFileSync(p, 'utf8'));
        console.log(`[Firebase] Loaded Service Account Key from: ${p}`);
        break;
      } catch (err) {
        console.warn(`[Firebase] Error reading key file ${p}:`, err.message);
      }
    }
  }
}

let app = null;
let db = null;
let messaging = null;

if (serviceAccount) {
  try {
    const apps = getApps();
    if (!apps.length) {
      app = initializeApp({
        credential: cert(serviceAccount),
        projectId: serviceAccount.project_id || 'lost-and-found-29d1f'
      });
    } else {
      app = apps[0];
    }
    db = getFirestore(app);
    messaging = getMessaging(app);
    console.log(`[Firebase] Cloud Firestore & FCM initialized for project: ${serviceAccount.project_id}`);
  } catch (err) {
    console.error('[Firebase] Initialization error:', err.message);
  }
} else {
  console.warn('[Firebase] No Service Account credentials found. Firestore cloud sync will be disabled.');
}

/**
 * Sync GPS location telemetry log to Firestore
 */
async function syncGpsLogToFirebase(data) {
  if (!db) return;
  try {
    // 1. Add log to 'gps_logs' collection
    await db.collection('gps_logs').add({
      busId: data.busId || 'unknown',
      licensePlate: data.licensePlate || 'unassigned',
      lat: data.lat,
      lng: data.lng,
      speed: data.speed || 0.0,
      timestamp: data.timestamp ? new Date(data.timestamp).toISOString() : new Date().toISOString(),
      createdAt: FieldValue.serverTimestamp()
    });

    // 2. Update latest location in 'buses' collection
    if (data.busId) {
      await db.collection('buses').doc(data.busId).set({
        busId: data.busId,
        licensePlate: data.licensePlate || 'unassigned',
        lastKnownLat: data.lat,
        lastKnownLng: data.lng,
        speed: data.speed || 0.0,
        status: 'ONLINE',
        lastUpdate: FieldValue.serverTimestamp()
      }, { merge: true });
    }
  } catch (err) {
    console.error('[Firebase Sync Error] GpsLog:', err.message);
  }
}

/**
 * Sync Emergency SOS Alert to Firestore
 */
async function syncEmergencyAlertToFirebase(alertData) {
  if (!db) return;
  try {
    await db.collection('emergency_alerts').add({
      schoolId: alertData.schoolId || 'unknown',
      type: alertData.type || 'HARDWARE_SOS',
      message: alertData.message || 'SOS Triggered',
      status: alertData.status || 'ACTIVE',
      createdAt: FieldValue.serverTimestamp()
    });
    console.log('[Firebase Sync] Emergency Alert written to Cloud Firestore');
  } catch (err) {
    console.error('[Firebase Sync Error] EmergencyAlert:', err.message);
  }
}

/**
 * Sync Student Profile to Firestore
 */
async function syncStudentToFirebase(studentData) {
  if (!db) return;
  try {
    await db.collection('students').doc(studentData.id).set({
      studentId: studentData.id,
      schoolId: studentData.schoolId,
      name: studentData.name,
      rfidTag: studentData.rfidTag,
      grade: studentData.grade || 'General',
      parentId: studentData.parentId || null,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    console.log(`[Firebase Sync] Student '${studentData.name}' synced to Cloud Firestore`);
  } catch (err) {
    console.error('[Firebase Sync Error] Student:', err.message);
  }
}

module.exports = {
  app,
  db,
  messaging,
  syncGpsLogToFirebase,
  syncEmergencyAlertToFirebase,
  syncStudentToFirebase
};
