// Decides whether an incoming fix needs a GpsLog row at all.
//
// Measured on production 2026-08-27: 463,018 of 463,170 rows (99.97%) carried no
// tripId. A TM-100 reports every ~8s whether or not the bus is moving, so a bus
// parked overnight writes ~10,000 rows a day of the same coordinates, and nothing
// ever reads them — playback and segment history only look at trips, and the live
// map is driven by the socket emit, not the stored row. At the 500-bus target in
// DEPLOY.md that was ~1.26 GB/day, which overruns the 28.9 GB disk inside a 30-day
// retention window.
//
// So: always persist a fix that belongs to a trip or shows movement, and persist a
// parked, trip-less bus at most once per interval — enough to keep a coarse trail
// and to answer "where was this bus last night".
//
// Nothing here affects the live broadcast. Presence, the socket emit and the
// Firebase mirror all still run on every packet; this only governs the DB row.

const config = require('./config');

const MAX_ENTRIES = 5000;
const lastStoredAt = new Map(); // busId → epoch ms of the last row we wrote

// speed arrives in km/h from both ingest paths. A stationary GPS unit jitters a few
// km/h, so the threshold is a floor rather than "> 0".
function isMoving(speed) {
  return typeof speed === 'number' && speed >= config.GPS_MOVING_SPEED_KPH;
}

// Returns true when this fix should be written to GpsLog.
function shouldPersist(busId, tripId, speed) {
  if (!busId) return false;

  const now = Date.now();
  const keep = Boolean(tripId) || isMoving(speed);

  if (!keep) {
    const last = lastStoredAt.get(busId);
    if (last !== undefined && now - last < config.GPS_PARKED_INTERVAL_MIN * 60_000) {
      return false;
    }
  }

  if (!lastStoredAt.has(busId) && lastStoredAt.size >= MAX_ENTRIES) {
    lastStoredAt.delete(lastStoredAt.keys().next().value);
  }
  lastStoredAt.set(busId, now);
  return true;
}

function clear() {
  lastStoredAt.clear();
}

module.exports = { shouldPersist, clear };
