// Per-bus presence bookkeeping shared by both telemetry ingest paths.
//
// Two jobs:
//  1. Throttle the Bus.status='ONLINE' write to at most one per interval, so a
//     device sending every few seconds does not write to the DB on every packet.
//     The HTTP path cannot keep this state on the bus object: with HMAC enforced
//     the row is re-read per request, so the "last write" marker was always absent
//     and the throttle never engaged.
//  2. Report the OFFLINE→ONLINE edge, so the ingest paths can announce
//     `device_status_change` when a bus starts reporting again. The stale sweep
//     announces the ONLINE→OFFLINE edge; without this one a dashboard that dims a
//     bus on the sweep event has nothing to light it back up.

const systemHealth = require('./systemHealth');

const STATUS_WRITE_INTERVAL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 5000;

const lastWriteAt = new Map(); // busId → epoch ms of last ONLINE status write

// The last usable fix from each bus since this process started: when it arrived, how
// fast the bus was going (km/h), and whether a hardware tracker or the driver's phone
// sent it. The dark-bus sweep (darkBuses.js) reads it.
const lastFix = new Map(); // busId → { at, speed, source: 'tracker' | 'phone' }

function noteFix(busId, { speed, source }, at = Date.now()) {
  if (!busId) return;
  // Both ingest paths come through here, so this is also the system-wide "GPS is
  // arriving" signal (systemHealth.js).
  systemHealth.noteFix(at);
  if (!lastFix.has(busId) && lastFix.size >= MAX_ENTRIES) {
    lastFix.delete(lastFix.keys().next().value);
  }
  lastFix.set(busId, { at, speed: typeof speed === 'number' ? speed : 0, source });
}

function lastFixOf(busId) {
  return lastFix.get(busId) || null;
}

// currentStatus is the Bus.status we just read (DB row or cached copy).
// Returns { write, cameOnline }.
function evaluate(busId, currentStatus) {
  if (!busId) return { write: false, cameOnline: false };

  const now = Date.now();
  const last = lastWriteAt.get(busId);
  const firstSeen = last === undefined;
  const wasOffline = currentStatus !== 'ONLINE';
  const write = firstSeen || wasOffline || now - last > STATUS_WRITE_INTERVAL_MS;

  if (write) {
    if (firstSeen && lastWriteAt.size >= MAX_ENTRIES) {
      lastWriteAt.delete(lastWriteAt.keys().next().value);
    }
    lastWriteAt.set(busId, now);
  }

  // On a fresh process the previous state is unknown, so announce once rather than
  // leave a dashboard showing a bus that is in fact reporting. The event is
  // idempotent for the client.
  return { write, cameOnline: wasOffline || firstSeen };
}

// Called by the stale sweep so the next packet from this bus writes (and announces)
// ONLINE immediately instead of waiting out the throttle interval.
function markOffline(busId) {
  lastWriteAt.delete(busId);
}

function clear() {
  lastWriteAt.clear();
  lastFix.clear();
}

module.exports = { evaluate, markOffline, noteFix, lastFixOf, clear, STATUS_WRITE_INTERVAL_MS };
