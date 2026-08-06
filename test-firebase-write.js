const { db, syncGpsLogToFirebase, syncEmergencyAlertToFirebase, syncStudentToFirebase } = require('./firebase.js');

async function testFirebaseWrite() {
  console.log('=== TESTING FIREBASE CLOUD FIRESTORE WRITE ===\n');

  if (!db) {
    console.error('❌ Firestore instance is null. Check credentials.');
    process.exit(1);
  }

  try {
    // 1. Write GPS Log
    console.log('1. Writing test GPS Telemetry log to Firestore...');
    await syncGpsLogToFirebase({
      busId: 'test-bus-101',
      licensePlate: 'DL1P-1234',
      lat: 28.6139,
      lng: 77.2090,
      speed: 42.5,
      timestamp: new Date()
    });

    // 2. Write Emergency Alert
    console.log('2. Writing test Emergency SOS Alert to Firestore...');
    await syncEmergencyAlertToFirebase({
      schoolId: 'dps-school-id',
      type: 'HARDWARE_SOS',
      message: 'Test SOS Emergency from Blackbox TM-100',
      status: 'ACTIVE'
    });

    // 3. Write Student Profile
    console.log('3. Writing test Student profile to Firestore...');
    await syncStudentToFirebase({
      id: 'student-test-uuid',
      schoolId: 'dps-school-id',
      name: 'Rohan Sharma Test',
      rfidTag: 'RFID-999-TEST',
      grade: '5th-A'
    });

    console.log('\n✅ ALL FIREBASE CLOUD FIRESTORE WRITE TESTS PASSED 100%!');
    console.log('Open your Firebase Console (lost-and-found-29d1f) to view collections: gps_logs, buses, emergency_alerts, students.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Firebase Write Error:', err);
    process.exit(1);
  }
}

testFirebaseWrite();
