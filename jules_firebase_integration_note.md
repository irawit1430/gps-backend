# Note for @jules: Firebase Cloud Firestore & FCM Integration

Hey Jules,

We have integrated **Firebase Admin SDK** (`firebase-admin`) into the backend to provide permanent cloud data persistence and push notifications while running on Render!

---

## 🛠️ Key Technical Details

1. **Firebase Project**: `lost-and-found-29d1f`
2. **Service Account Credentials**:
   - Loaded from `firebase.js` module.
   - For local development: Automatically loads from `firebase-key.json` or `C:\Users\ANURAG TIWARI\Downloads\lost-and-found-29d1f-firebase-adminsdk-fbsvc-9d5054f63d.json`.
   - For Render Staging/Production: Reads Base64 or raw JSON string from `process.env.FIREBASE_SERVICE_ACCOUNT`.

3. **Cloud Firestore Collections**:
   - `buses`: Stores live locations, license plates, device IDs, and status.
   - `gps_logs`: Time-series GPS location logs for historical tracking.
   - `emergency_alerts`: High-priority SOS panic triggers.
   - `students`: Student profiles, RFID mappings, and grade info.
   - `notifications`: Multi-tenant user notification feeds.

4. **Firebase Cloud Messaging (FCM)**:
   - FCM instance exported via `require('./firebase').messaging`.
   - Enables sending real-time push notifications to Parent App and Driver App mobile clients!

---

## 🚀 How to Enable on Render Staging

1. On Render Web Service dashboard, add Environment Variable:
   - **Key**: `FIREBASE_SERVICE_ACCOUNT`
   - **Value**: Paste the raw contents of `lost-and-found-29d1f-firebase-adminsdk-fbsvc-9d5054f63d.json` (or base64 encoded string).
2. The server will automatically detect the credentials and initialize Cloud Firestore & FCM messaging on boot!

Cheers!
