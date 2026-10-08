const { PrismaClient } = require('@prisma/client');
const { materialiseRuns } = require('./materialiseRuns');

const prisma = new PrismaClient();

async function run() {
  await prisma.$connect();

  // Clear db
  await prisma.notification.deleteMany();
  await prisma.trip.deleteMany();
  await prisma.runException.deleteMany();
  await prisma.run.deleteMany();
  await prisma.route.deleteMany();
  await prisma.user.deleteMany();
  await prisma.school.deleteMany();

  // Create school
  const school1 = await prisma.school.create({ data: { name: 'Test School 1', timezone: 'UTC' } });
  const school2 = await prisma.school.create({ data: { name: 'Test School 2', timezone: 'UTC' } });

  // Create admins
  for (let i = 0; i < 5; i++) {
    await prisma.user.create({
      data: { name: `Admin 1-${i}`, email: `admin1-${i}@example.com`, passwordHash: 'hash', role: 'SCHOOL_ADMIN', schoolId: school1.id }
    });
    await prisma.user.create({
      data: { name: `Admin 2-${i}`, email: `admin2-${i}@example.com`, passwordHash: 'hash', role: 'SCHOOL_ADMIN', schoolId: school2.id }
    });
  }

  // Create routes
  const route1 = await prisma.route.create({ data: { name: 'Test Route 1', schoolId: school1.id } });
  const route2 = await prisma.route.create({ data: { name: 'Test Route 2', schoolId: school2.id } });

  // Create runs without bus/driver
  for (let i = 0; i < 100; i++) {
    await prisma.run.create({
      data: {
        name: `Run 1-${i}`,
        routeId: route1.id,
        active: true,
        startDate: new Date('2020-01-01'),
        endDate: new Date('2030-01-01'),
        direction: 'TO_SCHOOL',
        departureTime: '08:00'
      }
    });
    await prisma.run.create({
      data: {
        name: `Run 2-${i}`,
        routeId: route2.id,
        active: true,
        startDate: new Date('2020-01-01'),
        endDate: new Date('2030-01-01'),
        direction: 'TO_SCHOOL',
        departureTime: '08:00'
      }
    });
  }

  console.log('Starting baseline measure...');
  const start = Date.now();
  await materialiseRuns(prisma, { days: 1 });
  const end = Date.now();
  console.log(`Materialise completed in ${end - start}ms`);

  const notifications = await prisma.notification.count();
  console.log(`Created ${notifications} notifications`);

  await prisma.$disconnect();
}

run().catch(console.error);
