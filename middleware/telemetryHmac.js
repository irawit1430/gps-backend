const crypto = require('crypto');
const config = require('../config');
const logger = require('../logger');
const { tripTelemetryKey } = require('../telemetryKeys');

// Verifies HMAC-SHA256 signature on /api/telemetry requests.
// Header:  X-Device-Signature: <hex>
// Header:  X-Device-Timestamp: <unix seconds>
// Signed payload: `${deviceId}.${timestamp}.${lat}.${lng}.${speed || 0}`
// Keys accepted (bus looked up by req.body.deviceId):
//   - a trip key (telemetryKeys.js) for a trip running on this bus, with that trip's
//     driver: what driver phones get now. It stops working when the trip ends or is
//     reassigned. It also works for a trip about to start (PLANNED, due within
//     PRESTART_WINDOW_MS): the driver app now proves GPS reaches the server BEFORE it
//     starts the trip, so the first fixes arrive while the trip is still planned. Those
//     fixes file under no trip; only a running trip tags GPS or reaches parents.
//   - Bus.deviceSecret, the bus's permanent key, while TELEMETRY_ACCEPT_BUS_SECRET is
//     on (default): hardware flashed with it, and phones that fetched it before trip
//     keys existed. Each bus using it is logged, hourly, so it can be switched off.
//
// Behavior:
//   - If TELEMETRY_HMAC_ENFORCE is off → middleware is a no-op. Unset means on in
//     production (see config.js).
//   - If enforced and the bus has no key to check against → 403.

const BUS_SECRET_LOG_INTERVAL_MS = 60 * 60 * 1000;
const PRESTART_WINDOW_MS = 6 * 60 * 60 * 1000;
const RUNNING = ['ON_SCHEDULE', 'DELAYED'];
// The query below selects status; a row without one can only have come from a query that
// asked for running trips alone, so it counts as running.
const isRunning = (t) => !t.status || RUNNING.includes(t.status);

// A planned trip whose key may sign GPS now: due within the window, or with no time set.
const aboutToStart = (t, now = Date.now()) =>
  t.status === 'PLANNED' && (!t.scheduledStart || Math.abs(new Date(t.scheduledStart).getTime() - now) <= PRESTART_WINDOW_MS);
const busSecretLoggedAt = new Map(); // busId → epoch ms

function noteBusSecretUse(bus) {
  const last = busSecretLoggedAt.get(bus.id) || 0;
  if (Date.now() - last < BUS_SECRET_LOG_INTERVAL_MS) return;
  if (busSecretLoggedAt.size >= 5000) busSecretLoggedAt.clear();
  busSecretLoggedAt.set(bus.id, Date.now());
  logger.info(
    { busId: bus.id, deviceId: bus.deviceId },
    'Telemetry signed with the permanent bus secret (TELEMETRY_ACCEPT_BUS_SECRET)'
  );
}

async function telemetryHmac(prisma) {
  return async function (req, res, next) {
    if (!config.TELEMETRY_HMAC_ENFORCE) return next();

    let { deviceId, lat, lng, speed, logs } = req.body || {};
    // For bulk uploads, use the first log in the array to verify the signature
    if (logs && Array.isArray(logs) && logs.length > 0 && lat === undefined) {
      lat = logs[0].lat;
      lng = logs[0].lng;
      speed = logs[0].speed;
    }
    const sig = req.headers['x-device-signature'];
    const ts = req.headers['x-device-timestamp'];

    if (!deviceId || !sig || !ts) {
      return res.status(401).json({ error: 'Missing device signature headers' });
    }

    const skew = Math.abs(Date.now() / 1000 - Number(ts));
    if (!Number.isFinite(skew) || skew > config.TELEMETRY_MAX_SKEW_SECONDS) {
      return res.status(401).json({ error: 'Timestamp skew exceeds tolerance' });
    }

    let bus;
    try {
      bus = await prisma.bus.findUnique({ 
        where: { deviceId },
        include: {
          trips: {
            // DELAYED is running too. Matching only ON_SCHEDULE filed a late bus's GPS
            // under no trip, and its parents stopped seeing it move. The route needs the
            // id; driverId is what a trip key is bound to. PLANNED only for the key.
            where: { status: { in: [...RUNNING, 'PLANNED'] } },
            select: { id: true, driverId: true, status: true, scheduledStart: true },
          },
        },
      });
    } catch (err) {
      return res.status(500).json({ error: 'Device lookup failed' });
    }
    if (!bus) return res.status(404).json({ error: 'Device not registered' });

    const signing = (bus.trips || []).filter((t) => isRunning(t) || aboutToStart(t));
    const keys = signing.map((t) => ({ key: tripTelemetryKey(bus.id, t.id, t.driverId) }));
    // Everything after this reads bus.trips as "the running trip": keep it exactly that.
    bus.trips = (bus.trips || []).filter(isRunning);
    if (bus.deviceSecret && config.TELEMETRY_ACCEPT_BUS_SECRET) keys.push({ key: bus.deviceSecret, busSecret: true });
    if (keys.length === 0) {
      return res.status(403).json({ error: 'Device has no HMAC secret provisioned and no running trip' });
    }

    const message = `${deviceId}.${ts}.${lat}.${lng}.${speed || 0}`;
    const sigBuf = Buffer.from(String(sig), 'hex');
    const match = keys.find(({ key }) => {
      const expBuf = Buffer.from(crypto.createHmac('sha256', key).update(message).digest('hex'), 'hex');
      return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
    });
    if (!match) {
      return res.status(401).json({ error: 'Invalid device signature' });
    }
    if (match.busSecret) noteBusSecretUse(bus);

    req.bus = bus;
    next();
  };
}

module.exports = { telemetryHmac };
