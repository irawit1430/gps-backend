// Signing keys for phone GPS.
//
// A driver's phone used to be handed Bus.deviceSecret: the bus's permanent key, the one
// a hardware tracker is flashed with. The phone kept it after the trip, nothing rotated
// it on reassignment, so every driver who had ever driven a bus could post GPS as that
// bus for good.
//
// Now the phone gets a key for one trip and one driver, derived here rather than
// stored, so there is nothing to migrate or clean up. The signature check accepts it
// only while that trip is running with that driver on it (middleware/telemetryHmac.js):
// it dies when the trip ends or is handed to someone else. The driver app needs no
// change; it signs with whatever key telemetry-credentials returns.
//
// Derived from JWT_SECRET under its own label, so it can never collide with a token
// signature. Rotating JWT_SECRET (which signs everyone out anyway) also retires them.

const crypto = require('crypto');
const config = require('./config');

function tripTelemetryKey(busId, tripId, driverId) {
  return crypto
    .createHmac('sha256', config.JWT_SECRET)
    .update(`telemetry-trip-key:v1:${busId}:${tripId}:${driverId}`)
    .digest('hex');
}

module.exports = { tripTelemetryKey };
