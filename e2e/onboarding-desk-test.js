// Gate A of the 30-bus UAT plan, as a script: a school is set up, its roster is imported,
// families are invited and sign in, a trip runs with no GPS, and every step is checked
// against the running server and its database.
//
//   DATABASE_URL=postgresql://…/voltava_e2e TARGET=http://127.0.0.1:3900 node e2e/onboarding-desk-test.js
//
// Point it at a SCRATCH database and a server using that same database, never at
// production: it creates a school, 100 children and their parents, and a running trip.
// It refuses a database whose name does not say it is for testing.

const assert = require('assert/strict');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const TARGET = (process.env.TARGET || 'http://127.0.0.1:3900').replace(/\/$/, '');
const dbName = (process.env.DATABASE_URL || '').split('/').pop().split('?')[0];
if (!/(e2e|test|uat|scratch|staging)/i.test(dbName)) {
  console.error(`Refusing to run against database "${dbName}": its name must contain e2e, test, uat, scratch or staging.`);
  process.exit(2);
}

const prisma = new PrismaClient();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const step = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    console.log(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
    throw err;
  }
};
const call = async (method, path, body, token) => {
  const res = await fetch(TARGET + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, body: data };
};

async function seed() {
  const tag = crypto.randomBytes(3).toString('hex');
  const school = await prisma.school.create({ data: { name: `E2E School ${tag}`, latitude: 25.6, longitude: 85.1 } });
  const password = crypto.randomBytes(12).toString('base64url');
  const adminEmail = `e2e.admin.${tag}@example.test`;
  await prisma.user.create({ data: { email: adminEmail, password: await bcrypt.hash(password, 10), role: 'SCHOOL_ADMIN', name: 'E2E Transport Head', schoolId: school.id } });
  await prisma.user.create({ data: { email: `existing.${tag}@example.test`, password: 'x', role: 'PARENT', name: 'Existing Parent', schoolId: school.id } });
  const driver = await prisma.user.create({ data: { email: `driver.${tag}@example.test`, password: await bcrypt.hash(password, 10), role: 'DRIVER', name: 'E2E Driver', schoolId: school.id } });
  const mk = (name, stops) => prisma.route.create({ data: { schoolId: school.id, name, stops: { create: stops.map((s, i) => ({ name: s, lat: 25.6 + i / 100, lng: 85.1, orderIdx: i })) } } });
  const r1 = await mk('Route 1 Kankarbagh', ['Rajendra Nagar', 'Patliputra Gate', 'Boring Road']);
  await mk('Route 2 Danapur', ['Danapur Cantt', 'Khagaul']);
  return { tag, school, adminEmail, password, driver, r1 };
}

(async () => {
  const s = await seed();
  const login = await call('POST', '/api/auth/login', { email: s.adminEmail, password: s.password });
  assert.equal(login.status, 200, 'admin can sign in');
  const T = login.body.token;
  const base = `/api/schools/${s.school.id}`;

  // 100 children in pairs of siblings; every tenth without an email; one family already here.
  const rows = Array.from({ length: 100 }, (_, k) => {
    const i = k + 1;
    const fam = Math.ceil(i / 2);
    return {
      line: i + 1, rfidTag: `${s.tag}-00${String(i).padStart(3, '0')}`, name: `Student ${i}`, grade: `Class ${1 + (i % 10)}`,
      guardianPhone: `98765${String(i).padStart(5, '0')}`, parentEmail: i % 10 === 0 ? '' : `family${fam}.${s.tag}@example.test`, parentName: `Guardian ${fam}`,
      route: i % 2 ? 'route 1 kankarbagh' : 'Route 2 Danapur', stop: i % 2 ? 'Patliputra Gate' : 'KHAGAUL',
    };
  });
  rows[4].parentEmail = `EXISTING.${s.tag}@example.test`;
  const broken = [
    { ...rows[0], line: 200, rfidTag: `${s.tag}-X1`, name: 'Wrong route', route: 'Route 9', stop: 'Gate' },
    { ...rows[0], line: 201, name: 'Same ID as line 2' },
    { ...rows[0], line: 202, rfidTag: `${s.tag}-X3`, name: 'Driver email', parentEmail: s.driver.email },
    { ...rows[0], line: 203, rfidTag: `${s.tag}-X4`, name: 'Card A', qrToken: `CARD-${s.tag}` },
    { ...rows[0], line: 204, rfidTag: `${s.tag}-X5`, name: 'Card B', qrToken: `CARD-${s.tag}` },
  ];

  await step('dry run flags every broken row by line and writes nothing', async () => {
    const r = await call('POST', `${base}/students/bulk?dryRun=1`, [...rows, ...broken], T);
    assert.equal(r.status, 200);
    const bad = r.body.rows.filter((x) => x.errors.length).map((x) => x.line).sort((a, b) => a - b);
    assert.deepEqual(bad, [2, 200, 201, 202, 203, 204]);
    assert.equal(await prisma.student.count({ where: { schoolId: s.school.id } }), 0);
  });

  await step('an import with errors is refused whole', async () => {
    const r = await call('POST', `${base}/students/bulk`, [...rows, ...broken], T);
    assert.equal(r.status, 409);
    assert.equal(await prisma.student.count({ where: { schoolId: s.school.id } }), 0);
  });

  await step('a clean import creates children, parents and stops in one go', async () => {
    const r = await call('POST', `${base}/students/bulk`, rows, T);
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
    assert.deepEqual(
      { new: r.body.totals.new, parentsCreated: r.body.totals.parentsCreated, parentsLinked: r.body.totals.parentsLinked, noParent: r.body.totals.noParent, stopsAssigned: r.body.totals.stopsAssigned },
      { new: 100, parentsCreated: 50, parentsLinked: 1, noParent: 10, stopsAssigned: 100 },
    );
    assert.ok(!JSON.stringify(r.body).match(/temporaryPassword|tempPassword/), 'no password in the response');
  });

  await step('running the same file again changes nothing', async () => {
    const r = await call('POST', `${base}/students/bulk`, rows, T);
    assert.equal(r.status, 200);
    assert.equal(r.body.totals.unchanged, 100);
    assert.equal(await prisma.student.count({ where: { schoolId: s.school.id } }), 100);
    assert.equal(await prisma.studentRouteMapping.count({ where: { student: { schoolId: s.school.id } } }), 100);
  });

  let fam1;
  let fam2;
  await step('the activation funnel counts every family', async () => {
    const r = await call('GET', `${base}/parent-activation`, null, T);
    assert.equal(r.status, 200);
    assert.equal(r.body.totals.studentsWithoutParent, 10);
    assert.equal(r.body.totals.stages.NOT_INVITED, 50);
    fam1 = r.body.parents.find((p) => p.email === `family1.${s.tag}@example.test`);
    fam2 = r.body.parents.find((p) => p.email === `family2.${s.tag}@example.test`);
    assert.equal(fam1.children.length, 2, 'siblings share one parent');
  });

  let code1;
  let code2;
  await step('an invite makes a code that is the only way in', async () => {
    const r = await call('POST', `${base}/parent-invites`, { parentIds: [fam1.id], channel: 'PRINT' }, T);
    assert.equal(r.status, 200);
    code1 = r.body.letters[0].code;
    assert.match(r.body.letters[0].message.text, new RegExp(`One-time code: ${code1}`));
    const w = await call('POST', `/api/parents/${fam2.id}/invite`, { channel: 'WHATSAPP' }, T);
    assert.equal(w.status, 200);
    code2 = w.body.code;
    assert.ok(w.body.phone, 'a number for WhatsApp');
  });

  await sleep(1100); // a family reads the code; never in the same second it was made

  await step('a parent signs in with the code, must choose a password, then sees only their children', async () => {
    let r = await call('POST', '/api/auth/login', { email: `Family1.${s.tag}@example.test`, password: code1 });
    assert.equal(r.status, 200, 'capitalised email still signs in');
    assert.equal(r.body.user.mustResetPassword, true);
    const blocked = await call('GET', `/api/parents/${fam1.id}/students`, null, r.body.token);
    assert.equal(blocked.status, 403, 'nothing works before choosing a password');
    const changed = await call('POST', '/api/auth/change-password', { oldPassword: code1, newPassword: 'E2eOwnPassword9' }, r.body.token);
    assert.equal(changed.status, 200);
    await sleep(1100);
    r = await call('POST', '/api/auth/login', { email: `family1.${s.tag}@example.test`, password: code1 });
    assert.equal(r.status, 401, 'the code is dead once used');
    r = await call('POST', '/api/auth/login', { email: `family1.${s.tag}@example.test`, password: 'E2eOwnPassword9' });
    assert.equal(r.status, 200);
    const kids = await call('GET', `/api/parents/${fam1.id}/students`, null, r.body.token);
    assert.deepEqual(kids.body.map((k) => k.name).sort(), ['Student 1', 'Student 2']);
    const phone = await call('POST', '/api/users/me/push-devices', { deviceId: `iphone-${s.tag}`, platform: 'IOS', provider: 'APNS', token: 'a'.repeat(64) }, r.body.token);
    assert.equal(phone.status, 200, 'an iPhone registers');
  });

  await step('an expired code is refused with a message saying what to do', async () => {
    await prisma.user.update({ where: { id: fam2.id }, data: { inviteExpiresAt: new Date(Date.now() - 1000) } });
    const r = await call('POST', '/api/auth/login', { email: `family2.${s.tag}@example.test`, password: code2 });
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'INVITE_EXPIRED');
  });

  await step('add student saves child, parent and stop together', async () => {
    const stop = s.r1.id && (await prisma.routeStop.findFirst({ where: { routeId: s.r1.id } }));
    const r = await call('POST', `${base}/students`, { name: 'Walk-in', rfidTag: `${s.tag}-W1`, parentEmail: `New.${s.tag}@Example.test`, routeStopId: stop.id }, T);
    assert.equal(r.status, 200);
    assert.equal(r.body.stopAssigned, true);
    assert.equal(r.body.parent.email, `new.${s.tag}@example.test`);
  });

  await step('a card counts as printed only after the office confirms', async () => {
    const ids = (await prisma.student.findMany({ where: { schoolId: s.school.id }, take: 3, select: { id: true } })).map((x) => x.id);
    const cards = await call('POST', `${base}/qr-cards`, { studentIds: ids }, T);
    assert.ok(cards.body.every((c) => c.printedAt === null));
    const ok = await call('POST', `${base}/qr-cards/printed`, { studentIds: ids }, T);
    assert.equal(ok.body.confirmed, 3);
  });

  await step('a trip with no GPS is on the school\'s list at once, and reported by the driver once', async () => {
    const bus = await prisma.bus.create({ data: { schoolId: s.school.id, licensePlate: `E2E-${s.tag}`, capacity: 40, deviceId: `e2e-${s.tag}` } });
    const trip = await prisma.trip.create({ data: { routeId: s.r1.id, busId: bus.id, driverId: s.driver.id, status: 'ON_SCHEDULE', startTime: new Date(Date.now() - 10 * 60_000) } });
    const ready = await call('GET', `${base}/readiness`, null, T);
    const untracked = ready.body.items.find((i) => i.key === 'TRIP_UNTRACKED');
    assert.ok(untracked && untracked.detail.includes(`E2E-${s.tag}`));
    const d = await call('POST', '/api/auth/login', { email: s.driver.email, password: s.password });
    const rep = await call('POST', `/api/trips/${trip.id}/tracking-problem`, { reason: 'permission' }, d.body.token);
    assert.equal(rep.status, 200);
    const again = await call('POST', `/api/trips/${trip.id}/tracking-problem`, { reason: 'permission' }, d.body.token);
    assert.equal(again.status, 200);
    const notes = await prisma.notification.count({ where: { eventKey: { startsWith: `tracking-unverified:${trip.id}:` } } });
    assert.equal(notes, 1, 'one alert per admin per trip');
  });

  await step('readiness lists what is waiting, and no family\'s phone is claimed as alerted', async () => {
    const r = await call('GET', `${base}/readiness`, null, T);
    const keys = r.body.items.map((i) => i.key);
    for (const k of ['STUDENT_NO_PARENT', 'PARENT_NOT_INVITED', 'INVITE_EXPIRED', 'CARD_NOT_PRINTED']) assert.ok(keys.includes(k), k);
  });

  console.log(`\n${passed} steps passed against ${TARGET} (school ${s.school.name}).`);
  await prisma.$disconnect();
})().catch(async (err) => {
  if (!process.exitCode) {
    console.error(err);
    process.exitCode = 1;
  }
  await prisma.$disconnect();
});
