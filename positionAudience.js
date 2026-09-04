// Who is allowed to see a bus's live position, beyond the school's admins.
//
// Socket rooms used to put every user carrying a schoolId into `school:<id>`, so a
// parent received a position update for every bus in the school — including the ones
// none of their children ride. Scoping the room to admins closed that, but it also
// cut parents and drivers off from the only feed the tracking screen has. This is the
// other half: the people with a legitimate claim on THIS bus, and nobody else.
//
// A claim means riding the trip or driving it. No trip means no audience — a parked
// bus between runs is not something a parent has any reason to watch.
//
// Cached because the two facts have wildly different rates: a bus emits a fix every
// few seconds (282k rows on one bus in this deployment), while its roster changes a
// handful of times a day. Without the cache every packet would run a four-table join.

const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 5000;

const cache = new Map(); // tripId → { ids, expires }

async function forTrip(prisma, tripId) {
  if (!tripId) return [];

  const hit = cache.get(tripId);
  if (hit && hit.expires > Date.now()) return hit.ids;

  const trip = await prisma.trip.findUnique({
    where: { id: tripId },
    select: {
      driverId: true,
      route: {
        select: {
          stops: {
            select: { studentMappings: { select: { student: { select: { parentId: true } } } } },
          },
        },
      },
    },
  });

  const ids = new Set();
  // The driver is on the bus, so their own position is not news — but the app draws
  // the same map, and excluding them would mean two delivery rules to keep in step.
  if (trip?.driverId) ids.add(trip.driverId);
  for (const stop of trip?.route?.stops || []) {
    for (const m of stop.studentMappings || []) {
      if (m.student?.parentId) ids.add(m.student.parentId);
    }
  }

  const arr = [...ids];
  // Bounded so a long-running process cannot accumulate a row per trip forever.
  if (!cache.has(tripId) && cache.size >= MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(tripId, { ids: arr, expires: Date.now() + TTL_MS });
  return arr;
}

// Send one event to everyone riding or driving this trip. Both telemetry paths call
// this immediately after their admin-room emit; keeping it here rather than in each
// caller means the two ingest routes cannot drift apart on who is allowed to see a
// position, which is exactly the class of bug that made them disagree on `heading`.
//
// Never throws. A failed audience lookup must not fail the telemetry request that
// triggered it — the fix is already persisted and the admin broadcast already sent,
// and a 500 here would make a device retry a packet that actually landed.
async function emitToRiders(io, prisma, tripId, event, payload, logger) {
  if (!io || !tripId) return;
  try {
    const { emitToUsers } = require('./middleware/socketAuth');
    emitToUsers(io, await forTrip(prisma, tripId), event, payload);
  } catch (err) {
    logger?.error?.({ err: err.message, tripId }, 'Failed to broadcast position to riders');
  }
}

// Called when a trip's roster or crew changes, so the next fix re-reads it rather
// than waiting out the TTL with a stale audience.
function invalidate(tripId) {
  if (tripId) cache.delete(tripId);
}

function clear() {
  cache.clear();
}

module.exports = { forTrip, emitToRiders, invalidate, clear, TTL_MS };
