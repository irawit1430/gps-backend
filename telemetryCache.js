// Bounded LRU-lite cache for bus lookups on the telemetry hot path.
// Cap: 2000 entries; TTL: 60s.

const MAX_ENTRIES = 2000;
const TTL_MS = 60_000;

const map = new Map();

function get(key) {
  const entry = map.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > TTL_MS) {
    map.delete(key);
    return null;
  }
  // Refresh recency (Map preserves insertion order → re-insert)
  map.delete(key);
  map.set(key, entry);
  return entry.value;
}

function set(key, value) {
  if (map.size >= MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
  map.set(key, { value, at: Date.now() });
}

function clear() {
  map.clear();
}

module.exports = { get, set, clear };
