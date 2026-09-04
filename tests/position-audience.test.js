// Live position delivery: who receives a bus's location, and who must not.
//
// The socket rooms were narrowed so that `school:<id>` — which every user carrying a
// schoolId joined, parents included — became `school-admin:<id>`. That closed a real
// leak: a parent was receiving a position for every bus in the school, including ones
// none of their children ride. It also silently cut parents off from the only feed
// the tracking screen has, and every test still passed, because nothing asserted that
// a parent ever receives a position at all.
//
// These tests assert both halves. Deleting the rider broadcast makes them fail.

const positionAudience = require('../positionAudience');

function makePrisma(trip) {
  return {
    trip: { findUnique: jest.fn().mockResolvedValue(trip) },
  };
}

// Records the rooms each emit targeted, which is the thing under test — not the
// payload, which the ingest paths already agree on.
function makeIo() {
  const emits = [];
  return {
    emits,
    to(rooms) {
      const list = Array.isArray(rooms) ? rooms : [rooms];
      return {
        emit: (event, payload) => emits.push({ rooms: list, event, payload }),
        to(more) {
          const merged = list.concat(Array.isArray(more) ? more : [more]);
          return { emit: (event, payload) => emits.push({ rooms: merged, event, payload }) };
        },
      };
    },
  };
}

const tripWith = (parentIds, driverId = 'driver-1') => ({
  driverId,
  route: {
    stops: parentIds.map((pid) => ({ studentMappings: [{ student: { parentId: pid } }] })),
  },
});

beforeEach(() => positionAudience.clear());

describe('positionAudience.forTrip', () => {
  it('includes every riding child’s parent and the driver', async () => {
    const prisma = makePrisma(tripWith(['parent-a', 'parent-b']));
    const ids = await positionAudience.forTrip(prisma, 'trip-1');
    expect(ids.sort()).toEqual(['driver-1', 'parent-a', 'parent-b']);
  });

  it('returns each parent once when two of their children ride the same trip', async () => {
    // Two stops, same parent. A duplicate here would mean a parent's socket is
    // addressed twice and the marker is moved twice per fix.
    const prisma = makePrisma(tripWith(['parent-a', 'parent-a']));
    const ids = await positionAudience.forTrip(prisma, 'trip-1');
    expect(ids.filter((id) => id === 'parent-a')).toHaveLength(1);
  });

  it('returns nobody when there is no trip — a parked bus has no audience', async () => {
    const prisma = makePrisma(null);
    expect(await positionAudience.forTrip(prisma, null)).toEqual([]);
    expect(prisma.trip.findUnique).not.toHaveBeenCalled();
  });

  it('queries once per trip and serves the rest from cache', async () => {
    // A bus emits a fix every few seconds; one of them has 282k rows in production.
    // Without the cache every packet would run this four-table join.
    const prisma = makePrisma(tripWith(['parent-a']));
    for (let i = 0; i < 25; i++) await positionAudience.forTrip(prisma, 'trip-1');
    expect(prisma.trip.findUnique).toHaveBeenCalledTimes(1);
  });

  it('re-reads after invalidate, so a roster change is not stuck behind the TTL', async () => {
    const prisma = makePrisma(tripWith(['parent-a']));
    await positionAudience.forTrip(prisma, 'trip-1');
    positionAudience.invalidate('trip-1');
    await positionAudience.forTrip(prisma, 'trip-1');
    expect(prisma.trip.findUnique).toHaveBeenCalledTimes(2);
  });
});

describe('positionAudience.emitToRiders', () => {
  it('addresses each rider’s own user room — this is what makes tracking work', async () => {
    const io = makeIo();
    const prisma = makePrisma(tripWith(['parent-a', 'parent-b']));

    await positionAudience.emitToRiders(io, prisma, 'trip-1', 'location_update', { lat: 1, lng: 2 });

    expect(io.emits).toHaveLength(1);
    expect(io.emits[0].event).toBe('location_update');
    expect(io.emits[0].rooms.sort()).toEqual(['user:driver-1', 'user:parent-a', 'user:parent-b']);
  });

  it('never targets the school-admin room — admins are served by the other emit', async () => {
    const io = makeIo();
    const prisma = makePrisma(tripWith(['parent-a']));
    await positionAudience.emitToRiders(io, prisma, 'trip-1', 'location_update', {});
    const rooms = io.emits.flatMap((e) => e.rooms);
    expect(rooms.some((r) => r.startsWith('school-admin:'))).toBe(false);
    expect(rooms.some((r) => r.startsWith('school:'))).toBe(false);
  });

  it('emits nothing for a bus that is not on a trip', async () => {
    const io = makeIo();
    const prisma = makePrisma(null);
    await positionAudience.emitToRiders(io, prisma, null, 'location_update', {});
    expect(io.emits).toHaveLength(0);
  });

  // The tests above prove the helper is correct. They would all still pass if someone
  // deleted the call to it, which is precisely how this broke the first time: the
  // rooms changed, delivery to parents disappeared, and 160 tests stayed green.
  // Both ingest paths must call it, so both are asserted.
  it.each([
    ['server.js', 'HTTP /api/telemetry — the driver app’s phone GPS'],
    ['tcp-server.js', 'TCP listener — the TM-100 hardware'],
  ])('%s still broadcasts positions to riders (%s)', (file) => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', file), 'utf8');
    expect(src).toMatch(/positionAudience\.emitToRiders\(/);
  });

  it('swallows a lookup failure rather than failing the telemetry request', async () => {
    // The fix is already persisted and the admin broadcast already sent by this
    // point. Throwing here would make a device retry a packet that actually landed.
    const io = makeIo();
    const prisma = { trip: { findUnique: jest.fn().mockRejectedValue(new Error('db down')) } };
    const logger = { error: jest.fn() };

    await expect(
      positionAudience.emitToRiders(io, prisma, 'trip-1', 'location_update', {}, logger)
    ).resolves.toBeUndefined();

    expect(io.emits).toHaveLength(0);
    expect(logger.error).toHaveBeenCalled();
  });
});
