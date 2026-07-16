const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient({ log: ['error'] });

async function seedAdmin() {
  try {
    const existingAdmin = await prisma.user.findUnique({ where: { email: 'admin@fleet.com' } });
    if (existingAdmin) {
      console.log('Super Admin already exists!');
      return;
    }

    const hashedPassword = await bcrypt.hash('password123', 10);
    await prisma.user.create({
      data: {
        name: 'Super Admin',
        email: 'admin@fleet.com',
        password: hashedPassword,
        role: 'SUPER_ADMIN'
      }
    });
    console.log('Successfully created Super Admin: admin@fleet.com / password123');
  } catch (err) {
    console.error('Error seeding admin:', err);
  } finally {
    await prisma.$disconnect();
  }
}

seedAdmin();
