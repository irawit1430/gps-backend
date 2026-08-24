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

const STATUS_WRITE_INTERVAL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 5000;

const lastWriteAt = new Map(); // busId → epoch ms of last ONLINE status write

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
}

module.exports = { evaluate, markOffline, clear, STATUS_WRITE_INTERVAL_MS };
