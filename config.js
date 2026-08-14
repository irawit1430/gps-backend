require('dotenv').config();
const { z } = require('zod');

const boolish = z
  .union([z.string(), z.boolean(), z.undefined()])
  .transform((v) => v === true || v === '1' || v === 'true' || v === 'yes');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  TCP_PORT: z.coerce.number().int().positive().default(5000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
  JWT_EXPIRES_IN: z.string().default('24h'),

  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean)),

  FIREBASE_SERVICE_ACCOUNT: z.string().optional(),

  TELEMETRY_HMAC_ENFORCE: boolish.default('0'),
  TELEMETRY_MAX_SKEW_SECONDS: z.coerce.number().int().positive().default(300),

  RUN_MIGRATIONS: boolish.default('0'),
  ALLOW_SEED: boolish.default('0'),
  SEED_ADMIN_EMAIL: z.string().email().optional().or(z.literal('').transform(() => undefined)),
  SEED_ADMIN_PASSWORD: z.string().min(12).optional().or(z.literal('').transform(() => undefined)),
  ENABLE_MOCK_DATA: boolish.default('0'),

  RATE_LIMIT_LOGIN_PER_MIN: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_GLOBAL_PER_MIN: z.coerce.number().int().positive().default(300),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`FATAL: invalid environment configuration:\n${issues}`);
  process.exit(1);
}

const config = parsed.data;

// Cross-field checks
if (config.ALLOW_SEED && (!config.SEED_ADMIN_EMAIL || !config.SEED_ADMIN_PASSWORD)) {
  console.error('FATAL: ALLOW_SEED=1 requires SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD');
  process.exit(1);
}

if (config.NODE_ENV === 'production') {
  if (config.CORS_ORIGINS.length === 0) {
    console.error('FATAL: CORS_ORIGINS must list at least one origin in production');
    process.exit(1);
  }
  if (config.ENABLE_MOCK_DATA) {
    console.error('FATAL: ENABLE_MOCK_DATA must not be enabled in production');
    process.exit(1);
  }
}

module.exports = config;
