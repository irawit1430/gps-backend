const crypto = require('crypto');
const config = require('../config');

// Verifies HMAC-SHA256 signature on /api/telemetry requests.
// Header:  X-Device-Signature: <hex>
// Header:  X-Device-Timestamp: <unix seconds>
// Signed payload: `${deviceId}.${timestamp}.${lat}.${lng}`
// Secret:  Bus.deviceSecret (looked up by req.body.deviceId).
//
// Behavior:
//   - If TELEMETRY_HMAC_ENFORCE=0 → middleware is a no-op (dev only).
//   - If enforced and bus has no deviceSecret set → 403 (device must be provisioned).
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
            where: { status: 'ON_SCHEDULE' },
            include: { driver: { select: { name: true } }, route: { select: { name: true } } },
          },
        },
      });
    } catch (err) {
      return res.status(500).json({ error: 'Device lookup failed' });
    }
    if (!bus) return res.status(404).json({ error: 'Device not registered' });
    if (!bus.deviceSecret) return res.status(403).json({ error: 'Device has no HMAC secret provisioned' });

    const expected = crypto
      .createHmac('sha256', bus.deviceSecret)
      .update(`${deviceId}.${ts}.${lat}.${lng}.${speed || 0}`)
      .digest('hex');

    const sigBuf = Buffer.from(String(sig), 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return res.status(401).json({ error: 'Invalid device signature' });
    }

    req.bus = bus;
    next();
  };
}

module.exports = { telemetryHmac };
