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

  // iPhone push, sent straight to Apple (apns.js). All four or iPhone push stays off.
  // APNS_KEY is the .p8 file from Apple Developer > Keys: pasted as is, with \n for
  // newlines, or base64. APNS_BUNDLE_ID is the parent app's iOS bundle id.
  APNS_KEY: z.string().optional(),
  APNS_KEY_ID: z.string().optional(),
  APNS_TEAM_ID: z.string().optional(),
  APNS_BUNDLE_ID: z.string().optional(),
  // 1 for App Store and TestFlight builds; 0 for development builds, whose tokens only
  // Apple's sandbox accepts.
  APNS_PRODUCTION: boolish.default('1'),

  // SMTP rather than a provider SDK, so switching providers is a credential change.
  // Unset = email silently disabled, same contract as FIREBASE_SERVICE_ACCOUNT.
  EMAIL_SMTP_HOST: z.string().optional(),
  EMAIL_SMTP_PORT: z.coerce.number().int().positive().default(587),
  EMAIL_SMTP_USER: z.string().optional(),
  EMAIL_SMTP_PASS: z.string().optional(),
  // Must be an address on a domain with SPF/DKIM published, or it lands in spam.
  EMAIL_FROM: z.string().optional(),

  // Signature check on phone GPS (middleware/telemetryHmac.js). It is /api/telemetry's
  // only guard: that route sits before authenticate. Unset means ON in production, so a
  // forgotten line cannot open it, and off elsewhere. Set 0 or 1 to choose. Resolved
  // below, once NODE_ENV is known.
  TELEMETRY_HMAC_ENFORCE: z.string().optional(),
  TELEMETRY_MAX_SKEW_SECONDS: z.coerce.number().int().positive().default(300),
  // Whether the signature check still accepts Bus.deviceSecret, the bus's permanent key.
  // Driver phones now get a key per trip (telemetryKeys.js), but phones that fetched the
  // permanent key before that still hold it, and any hardware posting over HTTPS is
  // flashed with it. Each bus still using it is logged hourly. Once the log is quiet,
  // or only shows hardware you then re-flash, set 0: every copy on a phone stops working.
  TELEMETRY_ACCEPT_BUS_SECRET: boolish.default('1'),

  // A parked bus reports every ~8s and nothing reads those rows. Persist a
  // trip-less, stationary bus at most this often; 0 speed threshold would be
  // defeated by GPS jitter, hence a km/h floor.
  GPS_PARKED_INTERVAL_MIN: z.coerce.number().int().positive().default(5),
  GPS_MOVING_SPEED_KPH: z.coerce.number().nonnegative().default(5),
  // Days of GpsLog to keep. 0 disables pruning entirely.
  GPS_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(30),

  // How many days ahead to materialise trips from runs. 0 disables the scheduler
  // entirely, which is the state every school is in until runs are created for it.
  // Short window on purpose: the trip table stays small, a schedule change takes
  // effect almost immediately, and an edit never has to rewrite months of rows.
  RUN_MATERIALISER_DAYS: z.coerce.number().int().nonnegative().default(3),

  RUN_MIGRATIONS: boolish.default('0'),
  ALLOW_SEED: boolish.default('0'),
  SEED_ADMIN_EMAIL: z.string().email().optional().or(z.literal('').transform(() => undefined)),
  SEED_ADMIN_PASSWORD: z.string().min(12).optional().or(z.literal('').transform(() => undefined)),
  ENABLE_MOCK_DATA: boolish.default('0'),

  // Parent invites (parentInvites.js). Days a one-time code keeps working.
  PARENT_INVITE_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  // The store pages an invite points families to. Set them once the listings are live;
  // until then an invite says "find Voltava on the Play Store" and the school's
  // readiness page says the links are missing. Never guessed from the package name.
  PARENT_APP_ANDROID_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  PARENT_APP_IOS_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),

  RATE_LIMIT_LOGIN_PER_MIN: z.coerce.number().int().positive().default(5),
  // Per signed-in user (or per IP for requests without a token).
  RATE_LIMIT_GLOBAL_PER_MIN: z.coerce.number().int().positive().default(300),
  // GPS is signed per device, so its budget is per device. The driver app sends every
  // 15 s and replays a backlog after a dead spot; 120 leaves room for both.
  RATE_LIMIT_TELEMETRY_PER_DEVICE_PER_MIN: z.coerce.number().int().positive().default(120),
  // A backstop per IP address. Mobile operators put many phones behind one address,
  // so this is deliberately far above any one user's budget.
  RATE_LIMIT_PER_IP_PER_MIN: z.coerce.number().int().positive().default(6000),

  // How long a trip may sit in ON_SCHEDULE/DELAYED before a new trip for the same
  // bus or driver treats it as abandoned and closes it. A school run is hours, not
  // half a day; tune if a route legitimately runs longer.
  TRIP_STALE_HOURS: z.coerce.number().int().positive().default(12),

  // Cancel PLANNED trips whose departure is more than TRIP_STALE_HOURS gone (staleTrips.js).
  // Off by default because it changes data one way: nothing records which trips it
  // cancelled, and its first pass works through every leftover trip since go-live. Off,
  // it only logs how many it would cancel — read that number, then turn it on.
  STALE_TRIP_SWEEP: boolish.default('0'),

  // Minutes of silence before a bus on a running trip counts as dark and the school's
  // admins are told (darkBuses.js). A phone that stopped while standing still is not
  // counted: it only sends after the bus moves. 0 turns the alert off.
  BUS_DARK_MINUTES: z.coerce.number().int().nonnegative().default(5),
  // Minutes after a trip starts by which its first GPS position must have arrived.
  // After that the school's admins are told the trip is running untracked. 0 = off.
  TRACKING_CONFIRM_MINUTES: z.coerce.number().int().nonnegative().default(3),
  // Minutes a bus waits at each stop for children to get on or off. A route's stop
  // times are pure driving time, so without this every ETA ran early, by about the
  // number of stops before yours. Applies to every school. 0 turns it off.
  STOP_DWELL_MINUTES: z.coerce.number().min(0).max(10).default(1),
  // How close, in minutes, the bus must be before parents at that stop get the
  // "approaching your stop" alert. 0 turns the alert off.
  APPROACH_ALERT_MINUTES: z.coerce.number().int().min(0).max(30).default(5),
  // Whole-system alarms to super admins (systemHealth.js). No GPS from any bus for this
  // many minutes while trips are running. 0 turns it off.
  SYSTEM_GPS_SILENCE_MINUTES: z.coerce.number().int().nonnegative().default(10),
  // Push failing: at least SYSTEM_PUSH_FAIL_RATE of the pushes in the last
  // SYSTEM_PUSH_WINDOW_MINUTES failed, out of at least SYSTEM_PUSH_MIN_ATTEMPTS.
  // A window of 0 turns it off.
  SYSTEM_PUSH_WINDOW_MINUTES: z.coerce.number().int().nonnegative().default(30),
  SYSTEM_PUSH_MIN_ATTEMPTS: z.coerce.number().int().min(1).default(20),
  SYSTEM_PUSH_FAIL_RATE: z.coerce.number().min(0).max(1).default(0.5),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`FATAL: invalid environment configuration:\n${issues}`);
  process.exit(1);
}

const config = parsed.data;

config.TELEMETRY_HMAC_ENFORCE =
  config.TELEMETRY_HMAC_ENFORCE === undefined || config.TELEMETRY_HMAC_ENFORCE.trim() === ''
    ? config.NODE_ENV === 'production'
    : boolish.parse(config.TELEMETRY_HMAC_ENFORCE.trim());

// Retired: one opening password shared by every new parent. A leaked slip opened other
// families' accounts. Each family now gets its own invite code, so this is ignored.
if (process.env.PARENT_DEFAULT_PASSWORD) {
  console.warn('WARNING: PARENT_DEFAULT_PASSWORD is ignored. Every parent now gets their own invite code; remove it from the environment.');
}

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
  if (!config.TELEMETRY_HMAC_ENFORCE) {
    console.warn(
      'WARNING: TELEMETRY_HMAC_ENFORCE is off in production. Anyone who knows a bus IMEI can post GPS for it.'
    );
  }
}

module.exports = config;
