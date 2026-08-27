#!/usr/bin/env node
// One student should sit at one stop per route. The @@unique is (studentId, routeStopId),
// so it only ever blocked re-assigning the SAME stop — a second stop on the same route
// slipped through, and the child then renders twice on the driver's roster and sweep list
// (which is what threw "two children with the same key").
//
// POST /api/student-route-mappings now 409s on this, but rows created before that fix are
// still in the database. This finds them.
//
//   node scripts/dedupe-student-mappings.js             report only, changes nothing
//   node scripts/dedupe-student-mappings.js --fix       delete the extras
//   node scripts/dedupe-student-mappings.js --selftest  check the grouping logic, no DB
//
// Keeps the EARLIEST mapping (the original assignment) and deletes later ones. Read the
// report before passing --fix: deleting the wrong row moves a child to the wrong stop.

// Same student + same route = duplicate. Same student on two different routes is normal,
// and two students on one stop is the entire point of a stop.
function groupDuplicates(mappings) {
  const groups = new Map();
  for (const m of mappings) {
    const key = `${m.student.id}::${m.routeStop.route.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

if (process.argv.includes('--selftest')) {
  const assert = require('assert');
  const mk = (id, sid, rid, stop) => ({
    id, createdAt: new Date(), student: { id: sid, name: sid },
    routeStop: { id: stop, name: stop, orderIdx: 0, route: { id: rid, name: rid } },
  });

  const dupe = groupDuplicates([mk('m1', 's1', 'r1', 'a'), mk('m2', 's1', 'r1', 'b')]);
  assert.strictEqual(dupe.length, 1, 'same student, same route, two stops = duplicate');
  assert.deepStrictEqual(dupe[0].map((m) => m.id), ['m1', 'm2'], 'order preserved, earliest first');

  assert.strictEqual(
    groupDuplicates([mk('m1', 's1', 'r1', 'a'), mk('m2', 's1', 'r2', 'b')]).length, 0,
    'same student on two different routes is legitimate',
  );
  assert.strictEqual(
    groupDuplicates([mk('m1', 's1', 'r1', 'a'), mk('m2', 's2', 'r1', 'a')]).length, 0,
    'two students on one stop is normal',
  );
  assert.strictEqual(groupDuplicates([]).length, 0, 'empty input');

  console.log('selftest ok');
  process.exit(0);
}

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const FIX = process.argv.includes('--fix');

(async () => {
  const mappings = await prisma.studentRouteMapping.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      createdAt: true,
      student: { select: { id: true, name: true } },
      routeStop: {
        select: { id: true, name: true, orderIdx: true, route: { select: { id: true, name: true } } },
      },
    },
  });

  const dupes = groupDuplicates(mappings);

  if (!dupes.length) {
    console.log('No duplicates: every student sits at one stop per route.');
    return;
  }

  let extras = 0;
  for (const group of dupes) {
    const [keep, ...drop] = group; // earliest first, courtesy of the orderBy
    extras += drop.length;
    console.log(`\n${keep.student.name}  —  route "${keep.routeStop.route.name}"`);
    console.log(`  KEEP   stop "${keep.routeStop.name}" (order ${keep.routeStop.orderIdx})  added ${keep.createdAt.toISOString()}`);
    for (const d of drop) {
      console.log(`  DELETE stop "${d.routeStop.name}" (order ${d.routeStop.orderIdx})  added ${d.createdAt.toISOString()}`);
    }
  }

  console.log(`\n${dupes.length} student/route pair(s) affected, ${extras} extra mapping(s).`);

  if (!FIX) {
    console.log('Report only — nothing changed. Re-run with --fix to delete the rows marked DELETE.');
    return;
  }

  const ids = dupes.flatMap(([, ...drop]) => drop.map((d) => d.id));
  const { count } = await prisma.studentRouteMapping.deleteMany({ where: { id: { in: ids } } });
  console.log(`Deleted ${count} mapping(s).`);
})()
  .catch((err) => {
    console.error('failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
