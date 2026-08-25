// Ensures config.js validation passes under test before any module loads it.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-at-least-32-characters-long';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'file:./test.db';
process.env.CORS_ORIGINS = process.env.CORS_ORIGINS || 'http://localhost:3000';
process.env.TELEMETRY_HMAC_ENFORCE = '0';
process.env.LOG_LEVEL = 'silent';
// The login limiter is per-IP and every test hits it from the same address; the
// production default of 5/min would 429 the later cases in a suite.
process.env.RATE_LIMIT_LOGIN_PER_MIN = process.env.RATE_LIMIT_LOGIN_PER_MIN || '1000';
