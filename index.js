// Voltava Fleet — entry point.
// Boot order: validate env → run migrations if requested → start HTTP+Socket + TCP.

const config = require('./config');
const { execSync } = require('child_process');
const logger = require('./logger');

if (config.RUN_MIGRATIONS) {
  const schemaFlag = config.DATABASE_URL.startsWith('file:')
    ? '--schema=prisma/schema.prisma'
    : '--schema=prisma/schema.prisma';
  try {
    logger.info({ schemaFlag }, 'Running prisma migrate deploy');
    execSync(`npx prisma migrate deploy ${schemaFlag}`, { stdio: 'inherit' });
    logger.info('Migrations complete');
  } catch (err) {
    logger.fatal({ err: err.message }, 'Migration failed; aborting boot');
    process.exit(1);
  }
}

const { server, io, prisma } = require('./server.js');
const { startTcpServer } = require('./tcp-server.js');
const { flushFirestore } = require('./firebase.js');
const { emitToSchool } = require('./middleware/socketAuth');
const busPresence = require('./busPresence');
const { materialiseRuns } = require('./materialiseRuns');

const httpServer = server.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'HTTP + Socket.IO server listening');
});

let tcpServer = null;
try {
  tcpServer = startTcpServer(io, config.TCP_PORT);
} catch (err) {
  logger.error({ err: err.message }, 'Failed to start TCP listener');
}

// Stale bus sweep (15 mins)
setInterval(async () => {
  try {
    const cutoff = new Date(Date.now() - 15 * 60 * 1000);
    // Collect first: updateMany cannot return the rows, and dashboards need to be
    // told a bus went dark instead of showing it ONLINE until the next page load.
    const stale = await prisma.bus.findMany({
      where: { status: 'ONLINE', updatedAt: { lt: cutoff } },
      select: { id: true, schoolId: true, licensePlate: true },
    });
    if (stale.length === 0) return;

    const result = await prisma.bus.updateMany({
      where: { id: { in: stale.map((b) => b.id) }, status: 'ONLINE' },
      data: { status: 'OFFLINE' }
    });
    for (const bus of stale) {
      // Next packet from this bus must write + announce ONLINE right away rather
      // than wait out the status-write throttle.
      busPresence.markOffline(bus.id);
      emitToSchool(io, bus.schoolId, 'device_status_change', {
        deviceId: bus.id,
        status: 'OFFLINE',
        message: `No telemetry from ${bus.licensePlate} for 15 minutes`,
      });
    }
    if (result.count > 0) logger.info({ count: result.count }, 'Marked stale buses OFFLINE');
  } catch(err) {
    logger.error({err}, 'Stale bus sweep failed');
  }
}, 5 * 60 * 1000);

// Materialise runs into trips.
//
// In-process for the same reason retention is: a cron installed by hand is a step
// somebody can skip, mistype, or install under an account that does not exist — which
// is exactly how GpsLog went unpruned for the life of this deployment.
//
// Every four hours rather than nightly. A single overnight pass means one failure
// costs a school its morning with nobody awake to notice; repeating through the day
// means a missed run is picked up long before anyone needs it, and re-running is free
// because the unique constraint makes it a no-op.
if (config.RUN_MATERIALISER_DAYS > 0) {
  const runMaterialiser = async () => {
    const res = await materialiseRuns(prisma, {
      days: config.RUN_MATERIALISER_DAYS,
      logger,
    });
    if (res.created > 0 || res.crewless > 0) {
      logger.info(res, 'Materialised runs');
    }
  };

  // Once at boot as well as on the interval: a VM that was down overnight should
  // catch up when it comes back, not wait for the next tick.
  runMaterialiser().catch((err) => logger.error({ err }, 'Run materialiser failed at boot'));
  setInterval(() => {
    runMaterialiser().catch((err) => logger.error({ err }, 'Run materialiser failed'));
  }, 4 * 60 * 60 * 1000);
}

// GpsLog retention.
//
// DEPLOY.md §10 documented this as a crontab under user `voltava` — a user that
// does not exist on the VM, so the command errored and the table has never been
// pruned once. In-process means it ships with the code instead of being a manual
// step that can be skipped, mistyped, or installed under the wrong account.
//
// Set GPS_RETENTION_DAYS=0 to disable.
if (config.GPS_RETENTION_DAYS > 0) {
  const pruneGpsLogs = async () => {
    const cutoff = new Date(Date.now() - config.GPS_RETENTION_DAYS * 86_400_000);
    let removed = 0;
    // Batched. One unbounded DELETE over a table this size holds a lock long
    // enough to stall telemetry ingest, which is the outage this is meant to
    // prevent. The loop cap stops a runaway if something keeps re-inserting.
    for (let batch = 0; batch < 200; batch++) {
      const count = await prisma.$executeRaw`
        DELETE FROM "GpsLog" WHERE id IN (
          SELECT id FROM "GpsLog" WHERE timestamp < ${cutoff} LIMIT 5000
        )`;
      removed += count;
      if (count === 0) break;
      // Breathe between batches so ingest keeps up.
      await new Promise((r) => setTimeout(r, 200));
    }
    if (removed > 0) {
      logger.info({ removed, olderThanDays: config.GPS_RETENTION_DAYS }, "Pruned GpsLog");
    }
  };

  setInterval(() => {
    pruneGpsLogs().catch((err) => logger.error({ err }, "GpsLog prune failed"));
  }, 6 * 60 * 60 * 1000);
}

// ─── Graceful shutdown ─────────────────────────────────────
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');

  const closers = [
    new Promise((resolve) => httpServer.close(resolve)),
    new Promise((resolve) => io.close(resolve)),
  ];
  if (tcpServer) closers.push(new Promise((resolve) => tcpServer.close(resolve)));

  const timeout = new Promise((resolve) => setTimeout(resolve, 15000));

  await Promise.race([Promise.all(closers), timeout]);

  try {
    await flushFirestore();
  } catch(err) {
    logger.warn({ err: err.message }, 'flushFirestore errored');
  }
  
  try {
    await prisma.$disconnect();
  } catch (err) {
    logger.warn({ err: err.message }, 'prisma.$disconnect errored');
  }

  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandledRejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'uncaughtException — exiting');
  shutdown('uncaughtException');
});
