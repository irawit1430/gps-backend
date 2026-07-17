const { PrismaClient } = require('@prisma/client');
const axios = require('axios');

const prisma = new PrismaClient();
const API_URL = 'http://localhost:3000/api/telemetry';
const TOTAL_BUSES = 10;
const STUDENTS_PER_BUS = 40;

// Utility for sleep
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function seedDatabase() {
  console.log('Seeding Database...');
  
  // 1. Create School
  const school = await prisma.school.create({
    data: {
      name: 'Springfield Elementary Simulation',
      address: '742 Evergreen Terrace'
    }
  });
  console.log(`Created School: ${school.id}`);

  // 2. Create Buses
  const buses = [];
  for (let i = 1; i <= TOTAL_BUSES; i++) {
    const bus = await prisma.bus.create({
      data: {
        schoolId: school.id,
        licensePlate: `MH-12-AB-${1000 + i}`,
        capacity: STUDENTS_PER_BUS,
        deviceId: `TM100-SIM-${i}`
      }
    });
    buses.push(bus);
  }
  console.log(`Created ${buses.length} Buses`);

  // 3. Create Route (Mock route for simulation)
  const route = await prisma.route.create({
    data: {
      schoolId: school.id,
      name: 'Morning Simulation Route'
    }
  });

  // 4. Create Students (400 total)
  let studentCount = 0;
  const studentData = [];
  for (const bus of buses) {
    for (let j = 1; j <= STUDENTS_PER_BUS; j++) {
      studentCount++;
      studentData.push({
        schoolId: school.id,
        name: `Simulated Student ${studentCount}`,
        rfidTag: `RFID-${bus.id}-${j}`
      });
    }
  }

  await prisma.student.createMany({
    data: studentData
  });
  console.log(`Created ${studentCount} Students`);

  return buses;
}

async function simulateFleet(buses) {
  console.log('\n--- Starting Live Fleet Simulation ---');
  console.log('Sending GPS pings every 5 seconds...\n');

  // Initial dummy coordinates for buses
  const busStates = buses.map(bus => ({
    deviceId: bus.deviceId,
    lat: 18.5204 + (Math.random() * 0.05),
    lng: 73.8567 + (Math.random() * 0.05),
    speed: 40
  }));

  while (true) {
    for (let state of busStates) {
      // Move them slightly to simulate driving
      state.lat += (Math.random() - 0.5) * 0.001;
      state.lng += (Math.random() - 0.5) * 0.001;
      state.speed = 30 + Math.random() * 20; // 30 to 50 km/h

      try {
        await axios.post(API_URL, {
          deviceId: state.deviceId,
          lat: state.lat,
          lng: state.lng,
          speed: state.speed,
          timestamp: new Date().toISOString()
        });
        console.log(`[Sent] Device: ${state.deviceId} | Lat: ${state.lat.toFixed(4)} | Lng: ${state.lng.toFixed(4)}`);
      } catch (error) {
        console.error(`[Error] Failed to send telemetry for ${state.deviceId}`);
      }
    }
    
    // Wait 5 seconds before next ping
    await sleep(5000);
  }
}

async function main() {
  try {
    // Clear existing data for fresh simulation
    await prisma.gpsLog.deleteMany({});
    await prisma.attendanceLog.deleteMany({});
    await prisma.studentRouteMapping.deleteMany({});
    await prisma.student.deleteMany({});
    await prisma.trip.deleteMany({});
    await prisma.routeStop.deleteMany({});
    await prisma.route.deleteMany({});
    await prisma.bus.deleteMany({});
    await prisma.user.deleteMany({});
    await prisma.school.deleteMany({});

    const buses = await seedDatabase();
    await simulateFleet(buses);
  } catch (error) {
    console.error('Simulation Failed:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
