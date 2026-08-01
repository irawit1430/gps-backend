const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
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

module.exports = {
  app,
  db,
  messaging
};
