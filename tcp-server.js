const net = require('net');
const { PrismaClient } = require('@prisma/client');
const { parseBlackboxPacket } = require('./blackbox-parser');
const { syncGpsLogToFirebase, syncEmergencyAlertToFirebase } = require('./firebase');
const { emitToSchool, emitToUser } = require('./middleware/socketAuth');
const liveFixGuard = require('./liveFixGuard');
const busPresence = require('./busPresence');
const gpsWriteGate = require('./gpsWriteGate');
const positionAudience = require('./positionAudience');
const config = require('./config');
const logger = require('./logger');

const prisma = new PrismaClient({ log: ['error'] });

const MAX_BUFFER_BYTES = 4 * 1024;
const MAX_CONCURRENT_CONNECTIONS = 500;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;


// One hardware SOS per bus per cooldown window. A latched panic button sets the
// emergency flag on every packet, so without this each packet becomes its own alert.
const SOS_COOLDOWN_MS = 5 * 60 * 1000;
const sosCooldownCache = new Map(); // busId → last alert epoch ms

let activeConnections = 0;

function startTcpServer(io, tcpPort = config.TCP_PORT) {
  const server = net.createServer((socket) => {
    if (activeConnections >= MAX_CONCURRENT_CONNECTIONS) {
      logger.warn({ ip: socket.remoteAddress }, 'TCP: rejecting connection — cap reached');
      socket.destroy();
      return;
    }
    activeConnections += 1;

    const clientAddress = `${socket.remoteAddress}:${socket.remotePort}`;
    logger.info({ ip: clientAddress }, 'TCP client connected');

    socket.setTimeout(IDLE_TIMEOUT_MS);
    socket.on('timeout', () => {
      logger.info({ ip: clientAddress }, 'TCP idle timeout');
      socket.destroy();
    });

    let bufferAcc = '';

    socket.on('data', async (chunk) => {
      bufferAcc += chunk.toString('utf8');

      if (bufferAcc.length > MAX_BUFFER_BYTES) {
        logger.warn({ ip: clientAddress, bytes: bufferAcc.length }, 'TCP buffer overflow — destroying socket');
        socket.destroy();
        return;
      }

      let lastIndex;
      while ((lastIndex = bufferAcc.indexOf('*')) !== -1) {
        const rawPacket = bufferAcc.substring(0, lastIndex + 1);
        bufferAcc = bufferAcc.substring(lastIndex + 1);

        try {
          const parsed = parseBlackboxPacket(rawPacket);
          if (!parsed) continue;
          if (parsed.__crcFailed) {
            logger.warn({ ip: clientAddress, expected: parsed.expected, received: parsed.received }, 'TCP: packet CRC failed');
            continue;
          }
          if (!parsed.imei) continue;

          logger.debug({ ip: clientAddress, header: parsed.header, imei: parsed.imei, lat: parsed.lat, lng: parsed.lng }, 'TCP packet');

          const bus = await prisma.bus.findUnique({ 
            where: { deviceId: parsed.imei },
            // DELAYED is running too — matching only ON_SCHEDULE filed every fix
            // from a late bus under tripId null, exactly when the track matters.
            include: { trips: { where: { status: { in: ['ON_SCHEDULE', 'DELAYED'] } }, select: { id: true } } }
          });
          if (!bus) {
            logger.warn({ ip: clientAddress, imei: parsed.imei }, 'TCP: unregistered IMEI');
            continue;
          }

          if (parsed.lat !== undefined && parsed.lng !== undefined && (parsed.lat !== 0 || parsed.lng !== 0)) {
            const fixAt = parsed.timestamp || new Date();
            const fixSpeed = parsed.speed || 0;
            const activeTripId = bus.trips?.[0]?.id || null;

            // Not every packet earns a row — see gpsWriteGate. The broadcast below
            // is unaffected and still runs on every packet.
            if (gpsWriteGate.shouldPersist(bus.id, activeTripId, fixSpeed)) {
              await prisma.gpsLog.create({
                data: { busId: bus.id, tripId: activeTripId, lat: parsed.lat, lng: parsed.lng, speed: fixSpeed, timestamp: fixAt },
              });
            }
            
            const presence = busPresence.evaluate(bus.id, bus.status);
            if (presence.write) {
              await prisma.bus.update({
                where: { id: bus.id },
                data: { status: 'ONLINE' }
              });
            }
            if (presence.cameOnline && io) {
              emitToSchool(io, bus.schoolId, 'device_status_change', {
                deviceId: bus.id,
                status: 'ONLINE',
                message: `${bus.licensePlate} is reporting`,
              });
            }

            // Only a live, GPS-fixed packet describes where the bus is *now*.
            // History replays ($DP field 5 = 'H') and no-fix packets are persisted
            // above for the trail, but must never drive the live map.
            const isLiveFix = parsed.isLive !== false && parsed.gpsFix !== false;

            if (!isLiveFix || !liveFixGuard.shouldBroadcast(bus.id, fixAt)) {
              logger.debug(
                { busId: bus.id, imei: parsed.imei, isLive: parsed.isLive, gpsFix: parsed.gpsFix, timestamp: fixAt },
                'TCP: skipping live broadcast for stale/history fix'
              );
            } else {
              syncGpsLogToFirebase({
                busId: bus.id,
                licensePlate: bus.licensePlate,
                lat: parsed.lat,
                lng: parsed.lng,
                speed: parsed.speed || 0,
                timestamp: fixAt,
              });

              if (io) {
                const positionPayload = {
                  busId: bus.id,
                  licensePlate: bus.licensePlate,
                  lat: parsed.lat,
                  lng: parsed.lng,
                  speed: parsed.speed,
                  heading: parsed.heading || 0,
                  timestamp: fixAt,
                };
                emitToSchool(io, bus.schoolId, 'location_update', positionPayload);
                // The school room holds admins only. Parents and the driver are
                // addressed individually, scoped to the trip they are actually on.
                await positionAudience.emitToRiders(
                  io, prisma, activeTripId, 'location_update', positionPayload, logger
                );
              }
            }
          }

          if (parsed.emergencyActive) {
            // The emergency flag stays set on every packet for as long as the panic
            // button is latched, and stored packets ($EPB type 'SP', $DP status 'H')
            // replay old ones — both would otherwise mint a fresh ACTIVE alert per
            // packet and bury the dashboard.
            const isReplay = parsed.isStored === true || parsed.isLive === false;
            const lastAlertAt = sosCooldownCache.get(bus.id) || 0;
            const withinCooldown = Date.now() - lastAlertAt < SOS_COOLDOWN_MS;

            if (isReplay || withinCooldown) {
              logger.debug(
                { imei: parsed.imei, busId: bus.id, isReplay, withinCooldown },
                'TCP: suppressing duplicate hardware SOS'
              );
              continue;
            }
            sosCooldownCache.set(bus.id, Date.now());

            logger.warn({ imei: parsed.imei, busId: bus.id }, 'TCP: hardware SOS');
            // Stamping the running trip lets parents of that trip be notified, and
            // lets GET /api/parents/:id/alerts find this alert on a cold start.
            const activeTripId = bus.trips?.[0]?.id || null;
            const alert = await prisma.emergencyAlert.create({
              data: {
                schoolId: bus.schoolId || 'unknown',
                tripId: activeTripId,
                type: 'HARDWARE_SOS',
                message: `Emergency SOS from Blackbox TM-100 (IMEI ${parsed.imei}, Bus ${bus.licensePlate})`,
                status: 'ACTIVE',
              },
            });
            syncEmergencyAlertToFirebase(alert);
            if (io) {
              emitToSchool(io, bus.schoolId, 'emergency_alert', alert);
              if (activeTripId) {
                const riders = await prisma.studentRouteMapping.findMany({
                  where: { routeStop: { route: { trips: { some: { id: activeTripId } } } } },
                  select: { student: { select: { parentId: true } } },
                });
                const parentIds = [...new Set(riders.map((r) => r.student.parentId).filter(Boolean))];
                parentIds.forEach((pid) => emitToUser(io, pid, 'emergency_alert', alert));
              }
            }
          }
        } catch (err) {
          logger.error({ err: err.message, ip: clientAddress }, 'TCP packet processing failed');
        }
      }
    });

    socket.on('error', (err) => {
      logger.warn({ err: err.message, ip: clientAddress }, 'TCP socket error');
    });

    socket.on('close', () => {
      activeConnections = Math.max(0, activeConnections - 1);
      logger.info({ ip: clientAddress }, 'TCP client disconnected');
    });
  });

  server.on('error', (err) => {
    logger.error({ err: err.message }, 'TCP listener error');
  });

  server.listen(tcpPort, () => {
    logger.info({ port: tcpPort, maxConcurrent: MAX_CONCURRENT_CONNECTIONS }, 'TCP listener ready');
  });

  return server;
}

module.exports = { startTcpServer };
