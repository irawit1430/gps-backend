const pino = require('pino');
const config = require('./config');

const isDev = config.NODE_ENV === 'development';

module.exports = pino({
  level: config.LOG_LEVEL,
  base: { service: 'voltava-fleet' },
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token'],
    censor: '[REDACTED]',
  },
  transport: isDev
    ? {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
      }
    : undefined,
});
