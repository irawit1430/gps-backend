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

  // SMTP rather than a provider SDK, so switching providers is a credential change.
  // Unset = email silently disabled, same contract as FIREBASE_SERVICE_ACCOUNT.
  EMAIL_SMTP_HOST: z.string().optional(),
  EMAIL_SMTP_PORT: z.coerce.number().int().positive().default(587),
  EMAIL_SMTP_USER: z.string().optional(),
  EMAIL_SMTP_PASS: z.string().optional(),
  // Must be an address on a domain with SPF/DKIM published, or it lands in spam.
  EMAIL_FROM: z.string().optional(),

  TELEMETRY_HMAC_ENFORCE: boolish.default('0'),
  TELEMETRY_MAX_SKEW_SECONDS: z.coerce.number().int().positive().default(300),

  // A parked bus reports every ~8s and nothing reads those rows. Persist a
  // trip-less, stationary bus at most this often; 0 speed threshold would be
  // defeated by GPS jitter, hence a km/h floor.
  GPS_PARKED_INTERVAL_MIN: z.coerce.number().int().positive().default(5),
  GPS_MOVING_SPEED_KPH: z.coerce.number().nonnegative().default(5),
  // Days of GpsLog to keep. 0 disables pruning entirely.
  GPS_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(30),

  RUN_MIGRATIONS: boolish.default('0'),
  ALLOW_SEED: boolish.default('0'),
  SEED_ADMIN_EMAIL: z.string().email().optional().or(z.literal('').transform(() => undefined)),
  SEED_ADMIN_PASSWORD: z.string().min(12).optional().or(z.literal('').transform(() => undefined)),
  ENABLE_MOCK_DATA: boolish.default('0'),

  RATE_LIMIT_LOGIN_PER_MIN: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_GLOBAL_PER_MIN: z.coerce.number().int().positive().default(300),

  // How long a trip may sit in ON_SCHEDULE/DELAYED before a new trip for the same
  // bus or driver treats it as abandoned and closes it. A school run is hours, not
  // half a day; tune if a route legitimately runs longer.
  TRIP_STALE_HOURS: z.coerce.number().int().positive().default(12),
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
