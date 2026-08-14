// Seed the initial SUPER_ADMIN. Idempotent — never overwrites an existing password.
// Gated: requires ALLOW_SEED=1 + SEED_ADMIN_EMAIL + SEED_ADMIN_PASSWORD in env.
// Additional dev fixtures (dummy school/parent/driver/student/bus) are gated behind
// SEED_INCLUDE_DEMO=1 so prod runs create *only* the super admin.

const config = require('./config');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const logger = require('./logger');

const prisma = new PrismaClient({ log: ['error'] });

async function main() {
  if (!config.ALLOW_SEED) {
    logger.warn('Seed refused: ALLOW_SEED is not 1');
    return;
  }
  if (!config.SEED_ADMIN_EMAIL || !config.SEED_ADMIN_PASSWORD) {
    logger.error('Seed refused: SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are required');
    process.exitCode = 1;
    return;
  }

  const email = config.SEED_ADMIN_EMAIL;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    logger.info({ email }, 'Seed: super admin already exists — leaving password unchanged');
  } else {
    const hashed = await bcrypt.hash(config.SEED_ADMIN_PASSWORD, 10);
    await prisma.user.create({
      data: { name: 'Super Admin', email, password: hashed, role: 'SUPER_ADMIN' },
    });
    logger.info({ email }, 'Seed: created SUPER_ADMIN');
  }

  if (process.env.SEED_INCLUDE_DEMO !== '1') {
    logger.info('Seed complete (SEED_INCLUDE_DEMO=0)');
    return;
  }

  // ─── Demo fixtures (staging only) ─────────────────────────
  logger.warn('Seed: creating DEMO fixtures — do not run this in production');

  let school = await prisma.school.findFirst({ where: { name: 'Delhi Public School' } });
  if (!school) {
    school = await prisma.school.create({ data: { name: 'Delhi Public School', address: 'New Delhi, India' } });
  }

  const demoPass = await bcrypt.hash('changeme-demo-' + Date.now(), 10);

  await prisma.user.upsert({
    where: { email: 'principal@example.com' },
    update: { schoolId: school.id },
    create: { name: 'Principal Sharma', email: 'principal@example.com', password: demoPass, role: 'SCHOOL_ADMIN', schoolId: school.id, mustResetPassword: true },
  });
  const parent = await prisma.user.upsert({
    where: { email: 'parent@example.com' },
    update: {},
    create: { name: 'Rahul Sharma', email: 'parent@example.com', password: demoPass, role: 'PARENT', mustResetPassword: true },
  });
  await prisma.user.upsert({
    where: { email: 'driver@example.com' },
    update: { schoolId: school.id },
    create: { name: 'Ashok Kumar', email: 'driver@example.com', password: demoPass, role: 'DRIVER', schoolId: school.id, mustResetPassword: true },
  });

  const existingStudent = await prisma.student.findUnique({ where: { rfidTag: 'RFID-12345' } });
  if (!existingStudent) {
    const student = await prisma.student.create({
      data: { schoolId: school.id, parentId: parent.id, name: 'Rohan Sharma', grade: 'Grade 4', rfidTag: 'RFID-12345' },
    });
    const route = await prisma.route.create({ data: { schoolId: school.id, name: 'Morning Route A', estimatedDuration: 45 } });
    const stop = await prisma.routeStop.create({ data: { routeId: route.id, name: 'Green Park Estate', lat: 28.5584, lng: 77.2029, orderIdx: 1 } });
    await prisma.studentRouteMapping.create({ data: { studentId: student.id, routeStopId: stop.id } });
  }

  await prisma.bus.upsert({
    where: { licensePlate: 'DL1P-1234' },
    update: {},
    create: { schoolId: school.id, licensePlate: 'DL1P-1234', capacity: 40, deviceId: '866738083792638' },
  });

  logger.info('Seed complete (with demo fixtures)');
}

main()
  .catch((err) => {
    logger.error({ err: err.message }, 'Seed failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
