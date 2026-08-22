const net = require('net');
const { PrismaClient } = require('@prisma/client');
const { parseBlackboxPacket } = require('./blackbox-parser');

const prisma = new PrismaClient();

// ⚡ Bolt: In-memory cache for high-frequency telemetry ingestion to prevent DB bottlenecks
const tcpTelemetryCache = new Map();
const CACHE_TTL_MS = 60000; // 1 minute

function startTcpServer(io, tcpPort = 5000) {
  const server = net.createServer((socket) => {
    const clientAddress = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`[TCP Server] Blackbox Hardware Connected: ${clientAddress}`);

    let bufferAcc = '';

    socket.on('data', async (chunk) => {
      bufferAcc += chunk.toString('utf8');

      // Packets end with '*'
      let lastIndex;
      while ((lastIndex = bufferAcc.indexOf('*')) !== -1) {
        const rawPacket = bufferAcc.substring(0, lastIndex + 1);
        bufferAcc = bufferAcc.substring(lastIndex + 1);

        try {
          const parsed = parseBlackboxPacket(rawPacket);
          if (parsed && parsed.imei) {
            console.log(`[TCP Server] Parsed ${parsed.header} packet from IMEI ${parsed.imei}: Lat=${parsed.lat}, Lng=${parsed.lng}, Speed=${parsed.speed}`);

            // ⚡ Bolt: Cache bus lookups to prevent database queries on every GPS packet
            let bus = null;
            const cached = tcpTelemetryCache.get(parsed.imei);

            if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
              bus = cached.data;
            } else {
              bus = await prisma.bus.findFirst({
                where: {
                  OR: [
                    { deviceId: parsed.imei },
                    { deviceId: { contains: parsed.imei } }
                  ]
                }
              });

              if (bus) {
                tcpTelemetryCache.set(parsed.imei, { data: bus, timestamp: Date.now() });
              }
            }

            if (bus) {
              // 1. Log GPS Position in DB
              if (parsed.lat !== undefined && parsed.lng !== undefined && (parsed.lat !== 0 || parsed.lng !== 0)) {
                await prisma.gpsLog.create({
                  data: {
                    busId: bus.id,
                    lat: parsed.lat,
                    lng: parsed.lng,
                    speed: parsed.speed || 0.0,
                    timestamp: parsed.timestamp || new Date()
                  }
                });

                // Broadcast live location update to all connected WebSockets (Web Dashboards & Mobile Apps)
                if (io) {
                  io.emit('location_update', {
                    busId: bus.id,
                    licensePlate: bus.licensePlate,
                    lat: parsed.lat,
                    lng: parsed.lng,
                    speed: parsed.speed,
                    heading: parsed.heading || 0,
                    timestamp: parsed.timestamp || new Date()
                  });
                }
              }

              // 2. Handle Emergency SOS Alerts
              if (parsed.emergencyActive) {
                console.warn(`[TCP Server] 🚨 CRITICAL: SOS Emergency received from IMEI ${parsed.imei}`);
                const alert = await prisma.emergencyAlert.create({
                  data: {
                    schoolId: bus.schoolId,
                    type: 'HARDWARE_SOS',
                    message: `Emergency SOS triggered by Blackbox TM-100 device (IMEI: ${parsed.imei}, Bus: ${bus.licensePlate})`,
                    status: 'ACTIVE'
                  }
                });

                if (io) {
                  io.emit('emergency_alert', alert);
                }
              }
            } else {
              console.warn(`[TCP Server] Unregistered Hardware Device IMEI: ${parsed.imei}`);
            }
          }
        } catch (err) {
          console.error('[TCP Server] Error processing packet:', err.message);
        }
      }
    });

    socket.on('error', (err) => {
      console.error(`[TCP Server] Socket error (${clientAddress}):`, err.message);
    });

    socket.on('close', () => {
      console.log(`[TCP Server] Client Disconnected: ${clientAddress}`);
    });
  });

  server.listen(tcpPort, () => {
    console.log(`[TCP Server] Blackbox TM-100 Hardware TCP Listener running on port ${tcpPort}`);
  });

  return server;
}

module.exports = { startTcpServer };
