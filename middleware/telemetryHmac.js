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

    const { deviceId, lat, lng } = req.body || {};
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
      bus = await prisma.bus.findUnique({ where: { deviceId }, select: { id: true, deviceSecret: true, schoolId: true, licensePlate: true, capacity: true } });
    } catch (err) {
      return res.status(500).json({ error: 'Device lookup failed' });
    }
    if (!bus) return res.status(404).json({ error: 'Device not registered' });
    if (!bus.deviceSecret) return res.status(403).json({ error: 'Device has no HMAC secret provisioned' });

    const expected = crypto
      .createHmac('sha256', bus.deviceSecret)
      .update(`${deviceId}.${ts}.${lat}.${lng}`)
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
