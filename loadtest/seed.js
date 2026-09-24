// Fills a SCRATCH database with a fleet to load-test against: schools, buses already on
// a running trip, routes with stops, and a child and parent at every stop.
//
//   LOADTEST_ALLOW_SEED=1 DATABASE_URL=postgresql://…/voltava_loadtest node loadtest/seed.js
//
// Never point this at production. It refuses unless LOADTEST_ALLOW_SEED=1 and the
// database name contains "loadtest", and everything it makes is named "Loadtest …" so
// `--clean` can take it out again. Writes loadtest/.fleet.json for run.js.
//
// Shape (env, defaults): BUSES=500, SCHOOLS=25, STOPS=10 per route, KIDS_PER_STOP=2.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const url = process.env.DATABASE_URL || '';
const dbName = url.split('/').pop().split('?')[0];
if (process.env.LOADTEST_ALLOW_SEED !== '1' || !/loadtest/i.test(dbName)) {
  console.error('Refusing: set LOADTEST_ALLOW_SEED=1 and use a database whose name contains "loadtest".');
  process.exit(1);
}

const BUSES = Number(process.env.BUSES || 500);
const SCHOOLS = Number(process.env.SCHOOLS || 25);
const STOPS = Number(process.env.STOPS || 10);
const KIDS_PER_STOP = Number(process.env.KIDS_PER_STOP || 2);
const PARENT_PASSWORD = 'loadtest-parent-1';
const OUT = path.join(__dirname, '.fleet.json');

const prisma = new PrismaClient();
const id = () => crypto.randomUUID();

async function clean() {
  const schools = await prisma.school.findMany({ where: { name: { startsWith: 'Loadtest ' } }, select: { id: true } });
  const schoolIds = schools.map((s) => s.id);
  if (schoolIds.length === 0) return;
  const trips = { route: { schoolId: { in: schoolIds } } };
  await prisma.gpsLog.deleteMany({ where: { bus: { schoolId: { in: schoolIds } } } });
  await prisma.notification.deleteMany({ where: { user: { schoolId: { in: schoolIds } } } });
  await prisma.attendanceLog.deleteMany({ where: { trip: trips } });
  await prisma.trip.deleteMany({ where: trips });
  await prisma.studentRouteMapping.deleteMany({ where: { student: { schoolId: { in: schoolIds } } } });
  await prisma.student.deleteMany({ where: { schoolId: { in: schoolIds } } });
  await prisma.route.deleteMany({ where: { schoolId: { in: schoolIds } } });
  await prisma.bus.deleteMany({ where: { schoolId: { in: schoolIds } } });
  await prisma.user.deleteMany({ where: { schoolId: { in: schoolIds } } });
  await prisma.school.deleteMany({ where: { id: { in: schoolIds } } });
}

async function seed() {
  await clean();
  const hash = await bcrypt.hash(PARENT_PASSWORD, 8);
  const fleet = { parentPassword: PARENT_PASSWORD, buses: [], parents: [] };
  const now = new Date();

  const schools = Array.from({ length: SCHOOLS }, (_, i) => ({
    id: id(), name: `Loadtest School ${i + 1}`, latitude: 25.6 + i * 0.05, longitude: 85.1,
  }));
  await prisma.school.createMany({ data: schools });

  for (let b = 0; b < BUSES; b++) {
    const school = schools[b % SCHOOLS];
    // A straight road of STOPS stops, 800 m apart, ending near the school.
    const baseLat = school.latitude - 0.08 + (b % 7) * 0.002;
    const baseLng = school.longitude - 0.06 + Math.floor(b / SCHOOLS) * 0.001;
    const stops = Array.from({ length: STOPS }, (_, s) => ({
      id: id(), name: `Stop ${s + 1}`, lat: baseLat + s * 0.0072, lng: baseLng, orderIdx: s, expectedArrivalMinutes: s * 3,
    }));
    const driverId = id(), busId = id(), routeId = id(), tripId = id();
    const bus = { id: busId, schoolId: school.id, licensePlate: `LT-${String(b + 1).padStart(4, '0')}`, capacity: 40,
      deviceId: `LT-DEV-${b + 1}`, deviceSecret: crypto.randomBytes(24).toString('hex'), status: 'ONLINE' };
    await prisma.user.create({ data: { id: driverId, email: `lt-driver-${b + 1}@loadtest.invalid`, password: hash, role: 'DRIVER', name: `Driver ${b + 1}`, schoolId: school.id } });
    await prisma.bus.create({ data: bus });
    await prisma.route.create({ data: { id: routeId, schoolId: school.id, name: `Loadtest route ${b + 1}`, estimatedDuration: (STOPS - 1) * 3 } });
    await prisma.routeStop.createMany({ data: stops.map((s) => ({ ...s, routeId })) });
    await prisma.trip.create({ data: {
      id: tripId, routeId, busId, driverId, status: 'ON_SCHEDULE', direction: 'TO_SCHOOL',
      startTime: now, scheduledStart: now, serviceDate: new Date(now.toISOString().slice(0, 10)),
    } });

    const parents = [], students = [], mappings = [];
    stops.forEach((s, si) => {
      for (let k = 0; k < KIDS_PER_STOP; k++) {
        const n = `${b + 1}-${si + 1}-${k + 1}`;
        const parentId = id(), studentId = id();
        parents.push({ id: parentId, email: `lt-parent-${n}@loadtest.invalid`, password: hash, role: 'PARENT', name: `Parent ${n}`, schoolId: school.id });
        students.push({ id: studentId, schoolId: school.id, rfidTag: `LT-${n}`, name: `Child ${n}`, parentId });
        mappings.push({ id: id(), studentId, routeStopId: s.id });
        fleet.parents.push({ id: parentId, schoolId: school.id, busId });
      }
    });
    await prisma.user.createMany({ data: parents });
    await prisma.student.createMany({ data: students });
    await prisma.studentRouteMapping.createMany({ data: mappings });
    fleet.buses.push({ busId, deviceId: bus.deviceId, secret: bus.deviceSecret, tripId, path: stops.map((s) => [s.lat, s.lng]) });
    if ((b + 1) % 50 === 0) console.log(`  ${b + 1}/${BUSES} buses`);
  }

  fs.writeFileSync(OUT, JSON.stringify(fleet));
  console.log(`Seeded ${BUSES} buses on running trips, ${fleet.parents.length} parents across ${SCHOOLS} schools. Wrote ${OUT}`);
}

(process.argv.includes('--clean') ? clean().then(() => console.log('Load-test data removed.')) : seed())
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
