// Guards the live `location_update` broadcast against out-of-order fixes.
//
// Both ingest paths (HTTP /api/telemetry and the TCP listener) can receive a fix
// that is *older* than one already broadcast for the same bus: an AIS-140 device
// replaying its stored buffer, a driver app flushing an offline queue, a duplicate
// retry, or a device whose clock runs behind. Persisting those is fine — they
// belong in the trail — but broadcasting them drags the map marker backwards.
//
// Both paths run in the same process (index.js), so one in-memory map covers both.

const MAX_ENTRIES = 5000;
const MAX_CLOCK_SKEW_MS = 2 * 60 * 1000;

const lastFixMs = new Map(); // busId → epoch ms of the newest fix broadcast

// Returns true (and records the fix) only when this fix is strictly newer than
// the last one broadcast for the bus.
function shouldBroadcast(busId, timestamp) {
  let fixMs = new Date(timestamp).getTime();
  if (!busId || !Number.isFinite(fixMs)) return false;

  // A device whose clock runs ahead would otherwise park the watermark in the
  // future and mute every correct fix until real time caught up.
  const now = Date.now();
  if (fixMs > now + MAX_CLOCK_SKEW_MS) fixMs = now;

  // Equal timestamps pass: a TM-100 reuses the last fix time on packets sent while
  // it has no fresh fix, and a phone can post twice inside the same second. Only a
  // fix that is genuinely *older* than what clients already have is dropped —
  // rejecting equal ones would punch gaps into an otherwise live stream.
  const lastMs = lastFixMs.get(busId) || 0;
  if (fixMs < lastMs) return false;

  if (!lastFixMs.has(busId) && lastFixMs.size >= MAX_ENTRIES) {
    lastFixMs.delete(lastFixMs.keys().next().value);
  }
  lastFixMs.set(busId, fixMs);
  return true;
}

function clear() {
  lastFixMs.clear();
}

module.exports = { shouldBroadcast, clear };
