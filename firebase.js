const admin = require('firebase-admin');
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

if (serviceAccount) {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: serviceAccount.project_id || 'lost-and-found-29d1f'
    });
    console.log(`[Firebase] Cloud Firestore initialized for project: ${serviceAccount.project_id}`);
  }
} else {
  console.warn('[Firebase] No Service Account credentials found. Firestore cloud sync will be disabled.');
}

const db = admin.apps.length ? admin.firestore() : null;
const messaging = admin.apps.length ? admin.messaging() : null;

module.exports = {
  admin,
  db,
  messaging
};
