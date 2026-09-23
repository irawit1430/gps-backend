// A bus on a running trip that stops sending GPS: a dead phone, a killed app, an
// unplugged tracker. The school and every parent lose the bus from the map, mid-route.
//
// Before this, the only check was the 15-minute stale-bus sweep in index.js. It marked
// the bus OFFLINE after 15-30 minutes and told nobody (the dashboard does not listen
// for that event). This sweep runs every minute over running trips only, and puts a
// notification in the school admins' bell.
//
// Silence alone is not enough. The driver app sends only after the bus moves 10 m, so
// a phone-tracked bus waiting at the school gate is silent and fine. A hardware tracker
// reports even when parked, so its silence always means something. So a bus is dark
// when it has been quiet for BUS_DARK_MINUTES and either a tracker sent its last fix,
// or the phone's last fix was moving. A bus not heard from since this process started
// is unknown, not dark; the 15-minute sweep still covers it.

const busPresence = require('./busPresence');

function isDark(fix, { now, quietMs, movingKph }) {
  if (!fix) return false;
  if (now - fix.at < quietMs) return false;
  return fix.source === 'tracker' || fix.speed >= movingKph;
}

async function sweepDarkBuses(prisma, { io, emitToSchool, emitToUser, minutes, movingKph, now = Date.now() }) {
  if (!minutes) return [];
  const quietMs = minutes * 60_000;

  const trips = await prisma.trip.findMany({
    where: { status: { in: ['ON_SCHEDULE', 'DELAYED'] }, bus: { status: 'ONLINE' } },
    select: {
      id: true,
      bus: { select: { id: true, licensePlate: true, schoolId: true } },
      route: { select: { name: true, schoolId: true } },
    },
  });

  const flagged = [];
  for (const trip of trips) {
    const bus = trip.bus;
    const fix = busPresence.lastFixOf(bus.id);
    if (!isDark(fix, { now, quietMs, movingKph })) continue;

    // Whoever flips ONLINE → OFFLINE announces it, so this pass, an overlapping one and
    // the 15-minute sweep cannot all report the same bus.
    const { count } = await prisma.bus.updateMany({
      where: { id: bus.id, status: 'ONLINE' },
      data: { status: 'OFFLINE' },
    });
    if (count === 0) continue;
    // The next fix then writes and announces ONLINE straight away.
    busPresence.markOffline(bus.id);

    const schoolId = trip.route?.schoolId || bus.schoolId || null;
    const quietMinutes = Math.floor((now - fix.at) / 60_000);
    const title = 'Bus stopped sending GPS';
    const message =
      `${bus.licensePlate} on ${trip.route?.name || 'its route'} has sent no GPS for ${quietMinutes} minutes ` +
      'during a running trip. Parents cannot see it on the map. Call the driver.';
    const context = { type: 'BUS_DARK', busId: bus.id, tripId: trip.id, lastFixAt: new Date(fix.at).toISOString() };

    emitToSchool(io, schoolId, 'device_status_change', { deviceId: bus.id, status: 'OFFLINE', message });

    const admins = await prisma.user.findMany({
      where: schoolId
        ? { schoolId, role: { in: ['SCHOOL_ADMIN', 'SUPER_ADMIN'] } }
        : { role: 'SUPER_ADMIN' },
      select: { id: true },
    });
    if (admins.length > 0) {
      await prisma.notification.createMany({
        // One per admin per silence: the key is the last fix this alert is about.
        data: admins.map((a) => ({
          userId: a.id, title, message, type: 'SYSTEM', context,
          eventKey: `bus-dark:${bus.id}:${fix.at}:${a.id}`,
        })),
        skipDuplicates: true,
      });
      if (io) admins.forEach((a) => emitToUser(io, a.id, 'notification', { title, message, type: 'SYSTEM', context }));
    }
    flagged.push({ busId: bus.id, tripId: trip.id, schoolId, quietMinutes });
  }
  return flagged;
}

module.exports = { isDark, sweepDarkBuses };
