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

const httpServer = server.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'HTTP + Socket.IO server listening');
});

let tcpServer = null;
try {
  tcpServer = startTcpServer(io, config.TCP_PORT);
} catch (err) {
  logger.error({ err: err.message }, 'Failed to start TCP listener');
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
