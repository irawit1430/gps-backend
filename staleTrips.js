// Past trips nobody started.
//
// Trips are materialised ahead as PLANNED and only a driver starting one moves it on.
// A run that was skipped (the driver used another trip, the bus stayed in the depot,
// the office handled the day by phone) stayed PLANNED for ever, because nothing
// closed it and TripStatus has no terminal "missed" state. Those leftovers counted as
// active everywhere PLANNED does: the driver app showed yesterday's run as the current
// one, and telemetry credentials once went to the oldest of them, signing a driver's
// GPS as a bus they were not driving.
//
// A PLANNED trip whose departure is more than TRIP_STALE_HOURS gone is cancelled —
// the same threshold that already closes a running trip left open for half a day. Only
// trips with a scheduledStart are judged: an ad-hoc trip with no time has no "past".
//
// Nobody is told but the school's dashboards. The driver app stops GPS on any
// CANCELLED event without checking which trip it names, so telling a driver on the
// road that last night's trip was cancelled would switch off the trip they are on.

const MAX_PER_PASS = 500;

const staleWhere = (staleHours, now) => ({
  status: 'PLANNED',
  scheduledStart: { lt: new Date(now.getTime() - staleHours * 3_600_000) },
});

// What a pass would cancel, without cancelling it. Run while STALE_TRIP_SWEEP is off, so
// the number can be checked before the sweep is allowed to change anything.
async function countUnstartedTrips(prisma, { staleHours, now = new Date() }) {
  return prisma.trip.count({ where: staleWhere(staleHours, now) });
}

async function cancelUnstartedTrips(prisma, { staleHours, now = new Date() }) {
  const stale = await prisma.trip.findMany({
    where: staleWhere(staleHours, now),
    select: { id: true },
    take: MAX_PER_PASS,
  });
  if (stale.length === 0) return [];

  const ids = stale.map((t) => t.id);
  // Re-checks PLANNED, so a trip started between the read and this write is left alone.
  await prisma.trip.updateMany({
    where: { id: { in: ids }, status: 'PLANNED' },
    data: { status: 'CANCELLED' },
  });

  // Report only what this pass actually cancelled.
  return prisma.trip.findMany({
    where: { id: { in: ids }, status: 'CANCELLED' },
    select: {
      id: true, status: true, busId: true, driverId: true, routeId: true, scheduledStart: true,
      route: { select: { name: true, schoolId: true } },
    },
  });
}

// One hourly pass. Off (the default), it changes nothing and reports what it would cancel.
async function sweepUnstartedTrips(prisma, { enabled, staleHours, now = new Date() }) {
  if (!enabled) {
    return { cancelled: [], wouldCancel: await countUnstartedTrips(prisma, { staleHours, now }) };
  }
  return { cancelled: await cancelUnstartedTrips(prisma, { staleHours, now }), wouldCancel: 0 };
}

module.exports = { sweepUnstartedTrips, cancelUnstartedTrips, countUnstartedTrips, MAX_PER_PASS };
