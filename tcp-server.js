const net = require('net');
const { PrismaClient } = require('@prisma/client');
const { parseBlackboxPacket } = require('./blackbox-parser');
const { syncGpsLogToFirebase, syncEmergencyAlertToFirebase } = require('./firebase');
const { emitToSchool } = require('./middleware/socketAuth');
const config = require('./config');
const logger = require('./logger');

const prisma = new PrismaClient({ log: ['error'] });

const MAX_BUFFER_BYTES = 4 * 1024;
const MAX_CONCURRENT_CONNECTIONS = 500;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

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

          const bus = await prisma.bus.findUnique({ where: { deviceId: parsed.imei } });
          if (!bus) {
            logger.warn({ ip: clientAddress, imei: parsed.imei }, 'TCP: unregistered IMEI');
            continue;
          }

          if (parsed.lat !== undefined && parsed.lng !== undefined && (parsed.lat !== 0 || parsed.lng !== 0)) {
            const log = await prisma.gpsLog.create({
              data: { busId: bus.id, lat: parsed.lat, lng: parsed.lng, speed: parsed.speed || 0, timestamp: parsed.timestamp || new Date() },
            });

            syncGpsLogToFirebase({
              busId: bus.id,
              licensePlate: bus.licensePlate,
              lat: parsed.lat,
              lng: parsed.lng,
              speed: parsed.speed || 0,
              timestamp: log.timestamp,
            });

            if (io) {
              emitToSchool(io, bus.schoolId, 'location_update', {
                busId: bus.id,
                licensePlate: bus.licensePlate,
                lat: parsed.lat,
                lng: parsed.lng,
                speed: parsed.speed,
                heading: parsed.heading || 0,
                timestamp: parsed.timestamp || new Date(),
              });
            }
          }

          if (parsed.emergencyActive) {
            logger.warn({ imei: parsed.imei, busId: bus.id }, 'TCP: hardware SOS');
            const alert = await prisma.emergencyAlert.create({
              data: {
                schoolId: bus.schoolId || 'unknown',
                type: 'HARDWARE_SOS',
                message: `Emergency SOS from Blackbox TM-100 (IMEI ${parsed.imei}, Bus ${bus.licensePlate})`,
                status: 'ACTIVE',
              },
            });
            syncEmergencyAlertToFirebase(alert);
            if (io) emitToSchool(io, bus.schoolId, 'emergency_alert', alert);
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
