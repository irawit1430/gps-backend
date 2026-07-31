const net = require('net');
const { startTcpServer } = require('./tcp-server');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function runBenchmark() {
  console.log("Setting up DB...");
  await prisma.$executeRawUnsafe(`DELETE FROM "GpsLog"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Bus"`);
  await prisma.bus.create({
    data: {
      licensePlate: 'BENCH-123',
      deviceId: 'IMEI-BENCH-12345',
      schoolId: null,
      capacity: 50
    }
  });

  const server = startTcpServer(null, 5001);

  console.log("Connecting...");
  const client = new net.Socket();
  client.connect(5001, '127.0.1.1', () => {
    console.log('Connected to server');

    // DP packet
    const packet = '$DP,V1,FW1.0,NR,01,L,IMEI-BENCH-12345,BENCH-123,1,01012023,120000,34.0522,N,118.2437,W,55.5,120,5,100,,,Op,1,1,12.5,3.7,0,0,31*';
    const numPackets = 500;

    // Create one big buffer
    const payload = packet.repeat(numPackets);

    const startTime = Date.now();
    client.write(payload, async () => {
      // wait a bit for processing
      let count = 0;
      let lastCount = -1;
      while (count < numPackets && count !== lastCount) {
          lastCount = count;
          await new Promise(r => setTimeout(r, 1000));
          count = await prisma.gpsLog.count({
            where: { bus: { deviceId: 'IMEI-BENCH-12345' } }
          });
          console.log(`Current count: ${count}`);
      }

      const endTime = Date.now();
      console.log(`Processed ${count} packets in ${endTime - startTime}ms`);

      client.destroy();
      server.close();
      await prisma.$disconnect();
    });
  });
}

runBenchmark().catch(console.error);
