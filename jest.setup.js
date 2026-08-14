// Ensures config.js validation passes under test before any module loads it.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-at-least-32-characters-long';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'file:./test.db';
process.env.CORS_ORIGINS = process.env.CORS_ORIGINS || 'http://localhost:3000';
process.env.TELEMETRY_HMAC_ENFORCE = '0';
process.env.LOG_LEVEL = 'silent';
