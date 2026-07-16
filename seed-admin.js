const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const prisma = new PrismaClient({ log: ['error'] });

async function seedAdmin() {
  try {
    let password = process.env.ADMIN_PASSWORD;
    if (!password) {
      password = crypto.randomBytes(16).toString('hex');
      console.warn('====================================================');
      console.warn('WARNING: No ADMIN_PASSWORD provided in environment.');
      console.warn(`Generated random password for seeded users: ${password}`);
      console.warn('Please save this password or set ADMIN_PASSWORD.');
      console.warn('====================================================');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    
    // 1. Create Super Admin
    const existingAdmin = await prisma.user.findUnique({ where: { email: 'admin@fleet.com' } });
    if (!existingAdmin) {
      await prisma.user.create({
      data: {
        name: 'Super Admin',
        email: 'admin@fleet.com',
        password: hashedPassword,
        role: 'SUPER_ADMIN'
      }
    });
    }

    // 2. Create Dummy School
    const school = await prisma.school.create({
      data: { name: 'Delhi Public School', address: 'New Delhi, India' }
    });

    // 3. Create Dummy Parent
    const existingParent = await prisma.user.findUnique({ where: { email: 'parent@example.com' } });
    let parent = existingParent;
    if (!existingParent) {
      parent = await prisma.user.create({
        data: {
          name: 'Rahul Sharma (Parent)',
          email: 'parent@example.com',
          password: hashedPassword,
          role: 'PARENT'
        }
      });
    }

    // 4. Create Dummy Driver
    const existingDriver = await prisma.user.findUnique({ where: { email: 'driver@example.com' } });
    if (!existingDriver) {
      await prisma.user.create({
        data: {
          name: 'Ashok Kumar (Driver)',
          email: 'driver@example.com',
          password: hashedPassword,
          role: 'DRIVER',
          schoolId: school.id
        }
      });
    }

    // 5. Create a Student linked to School and Parent
    const existingStudent = await prisma.student.findUnique({ where: { rfidTag: 'RFID-12345' } });
    if (!existingStudent && parent) {
      const student = await prisma.student.create({
        data: {
          schoolId: school.id,
          parentId: parent.id,
          name: 'Rohan Sharma',
          grade: 'Grade 4',
          rfidTag: 'RFID-12345'
        }
      });

      // 6. Create a Route and Stops
      const route = await prisma.route.create({
        data: {
          schoolId: school.id,
          name: 'Morning Route A',
          estimatedDuration: 45
        }
      });

      const stop = await prisma.routeStop.create({
        data: {
          routeId: route.id,
          name: 'Green Park Estate',
          lat: 28.5584,
          lng: 77.2029,
          orderIdx: 1
        }
      });

      await prisma.studentRouteMapping.create({
        data: {
          studentId: student.id,
          routeStopId: stop.id
        }
      });
    }

    // 7. Create a Bus
    const existingBus = await prisma.bus.findUnique({ where: { licensePlate: 'DL1P-1234' } });
    if (!existingBus) {
      await prisma.bus.create({
        data: {
          schoolId: school.id,
          licensePlate: 'DL1P-1234',
          capacity: 40,
          deviceId: 'TM100-MOCK'
        }
      });
    }

    console.log('Successfully seeded complete dummy dataset for testing!');
  } catch (err) {
    console.error('Error seeding admin:', err);
  } finally {
    await prisma.$disconnect();
  }
}

seedAdmin();
