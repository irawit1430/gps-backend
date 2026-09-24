// Drives a seeded fleet (seed.js) against a STAGING server: every bus sends signed GPS
// on the driver app's cadence, parents hold the live socket open, and parents refresh
// their child's card. Reports what matters for the launch criteria: how much GPS got
// in, how fast, and how late the live position reached a parent.
//
//   TARGET=http://staging:3000 JWT_SECRET=<staging secret> node loadtest/run.js
//
// Env (defaults): DURATION_S=180, INTERVAL_S=15 (driver app cadence), SOCKET_PARENTS=2000,
// POLLING_PARENTS=2000, POLL_S=60, SERVER_PID (sample the server's memory and CPU when
// it runs on this machine), OUT=loadtest/result.json.
//
// Every request comes from this one machine, so the server under test needs its per-IP
// limits raised (RATE_LIMIT_GLOBAL_PER_MIN) or it will be measuring its own rate
// limiter. JWT_SECRET is needed to sign parent tokens without 10,000 logins; use a
// staging secret, never production's. Never run this against production: it writes
// GPS for buses that do not exist.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const jwt = require('jsonwebtoken');
const { io: connect } = require('socket.io-client');

const TARGET = (process.env.TARGET || 'http://127.0.0.1:3000').replace(/\/$/, '');
const DURATION_S = Number(process.env.DURATION_S || 180);
const INTERVAL_S = Number(process.env.INTERVAL_S || 15);
const SOCKET_PARENTS = Number(process.env.SOCKET_PARENTS || 2000);
const POLLING_PARENTS = Number(process.env.POLLING_PARENTS || 2000);
const POLL_S = Number(process.env.POLL_S || 60);
const SERVER_PID = process.env.SERVER_PID || null;
const OUT = process.env.OUT || path.join(__dirname, 'result.json');
const SECRET = process.env.JWT_SECRET;
if (!SECRET) { console.error('Set JWT_SECRET (the staging server\'s) to sign parent tokens.'); process.exit(1); }

const fleet = JSON.parse(fs.readFileSync(path.join(__dirname, '.fleet.json'), 'utf8'));
const started = Date.now();
const stopAt = started + DURATION_S * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── measurement ────────────────────────────────────────────
const series = () => ({ sent: 0, ok: 0, byStatus: {}, ms: [] });
const m = { telemetry: series(), poll: series(), socket: { connected: 0, failed: 0, received: 0, ms: [] }, server: [] };
function record(s, status, ms) {
  s.sent++;
  if (status >= 200 && status < 300) s.ok++;
  s.byStatus[status] = (s.byStatus[status] || 0) + 1;
  s.ms.push(ms);
}
function pct(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);
}
const summary = (s) => ({
  sent: s.sent, ok: s.ok, okPct: s.sent ? +((100 * s.ok) / s.sent).toFixed(2) : null, byStatus: s.byStatus,
  p50: pct(s.ms, 50), p95: pct(s.ms, 95), p99: pct(s.ms, 99), max: s.ms.length ? Math.round(Math.max(...s.ms)) : null,
});

// ─── buses ──────────────────────────────────────────────────
// Each bus creeps along its seeded road, ~25 km/h, one fix per INTERVAL_S.
async function drive(bus) {
  await sleep(Math.random() * INTERVAL_S * 1000);
  let step = 0;
  while (Date.now() < stopAt) {
    const [a, b] = [bus.path[Math.min(Math.floor(step / 10), bus.path.length - 1)], bus.path[Math.min(Math.floor(step / 10) + 1, bus.path.length - 1)]];
    const f = (step % 10) / 10;
    const body = { deviceId: bus.deviceId, lat: +(a[0] + (b[0] - a[0]) * f).toFixed(6), lng: +(a[1] + (b[1] - a[1]) * f).toFixed(6), speed: 25, timestamp: new Date().toISOString() };
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', bus.secret).update(`${body.deviceId}.${ts}.${body.lat}.${body.lng}.${body.speed}`).digest('hex');
    const t0 = performance.now();
    let status = 0;
    try {
      const res = await fetch(`${TARGET}/api/telemetry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Device-Signature': sig, 'X-Device-Timestamp': String(ts) },
        body: JSON.stringify(body),
      });
      status = res.status;
      await res.arrayBuffer();
    } catch { status = 0; }
    record(m.telemetry, status, performance.now() - t0);
    step++;
    await sleep(INTERVAL_S * 1000);
  }
}

// ─── parents ────────────────────────────────────────────────
const tokenFor = (p) => jwt.sign({ id: p.id, role: 'PARENT', schoolId: p.schoolId }, SECRET, { expiresIn: '2h' });

function listen(parent) {
  return new Promise((resolve) => {
    const socket = connect(TARGET, { auth: { token: tokenFor(parent) }, transports: ['websocket'], reconnection: false, timeout: 20_000 });
    socket.on('connect', () => { m.socket.connected++; resolve(socket); });
    socket.on('connect_error', () => { m.socket.failed++; resolve(null); });
    socket.on('location_update', (p) => {
      m.socket.received++;
      const at = Date.parse(p.timestamp);
      if (Number.isFinite(at)) m.socket.ms.push(Date.now() - at);
    });
  });
}

async function poll(parent) {
  const auth = { Authorization: `Bearer ${tokenFor(parent)}` };
  await sleep(Math.random() * POLL_S * 1000);
  while (Date.now() < stopAt) {
    const t0 = performance.now();
    let status = 0;
    try {
      const res = await fetch(`${TARGET}/api/parents/${parent.id}/students`, { headers: auth });
      status = res.status;
      await res.arrayBuffer();
    } catch { status = 0; }
    record(m.poll, status, performance.now() - t0);
    await sleep(POLL_S * 1000);
  }
}

// ─── the server itself, when it runs here ───────────────────
// CPU is the share of one core used since the last sample (ps's own figure is an
// average over the process's whole life, which hides a saturated minute).
const TICKS = Number(execSync('getconf CLK_TCK').toString().trim()) || 100;
let lastCpu = null;
function sampleServer() {
  if (!SERVER_PID) return;
  try {
    const stat = fs.readFileSync(`/proc/${SERVER_PID}/stat`, 'utf8').split(') ')[1].split(' ');
    const ticks = Number(stat[11]) + Number(stat[12]); // utime + stime
    const rssKb = Number(execSync(`ps -o rss= -p ${SERVER_PID}`).toString().trim());
    const now = Date.now();
    if (lastCpu) {
      const cpuPct = Math.round(((ticks - lastCpu.ticks) / TICKS / ((now - lastCpu.at) / 1000)) * 100);
      m.server.push({ t: Math.round((now - started) / 1000), rssMb: Math.round(rssKb / 1024), cpuPct });
    }
    lastCpu = { ticks, at: now };
  } catch { /* the server went away, or it is not on this machine */ }
}

function report(final) {
  const r = {
    target: TARGET, buses: fleet.buses.length, intervalS: INTERVAL_S, elapsedS: Math.round((Date.now() - started) / 1000),
    telemetry: summary(m.telemetry),
    parentRefresh: summary(m.poll),
    liveSocket: { connected: m.socket.connected, failed: m.socket.failed, received: m.socket.received,
      p50: pct(m.socket.ms, 50), p95: pct(m.socket.ms, 95), p99: pct(m.socket.ms, 99) },
    server: m.server.length ? {
      peakRssMb: Math.max(...m.server.map((s) => s.rssMb)), peakCpuPct: Math.max(...m.server.map((s) => s.cpuPct)),
      avgCpuPct: Math.round(m.server.reduce((a, s) => a + s.cpuPct, 0) / m.server.length),
    } : null,
  };
  console.log(final ? '\n=== RESULT ===' : `\n--- ${r.elapsedS}s ---`);
  console.log(JSON.stringify(r, null, final ? 2 : 0));
  if (final) fs.writeFileSync(OUT, JSON.stringify({ ...r, serverSamples: m.server }, null, 2));
}

(async () => {
  console.log(`Load test: ${fleet.buses.length} buses every ${INTERVAL_S}s, ${SOCKET_PARENTS} live parents, ${POLLING_PARENTS} refreshing every ${POLL_S}s, for ${DURATION_S}s against ${TARGET}`);
  const listeners = fleet.parents.slice(0, SOCKET_PARENTS);
  const sockets = [];
  for (let i = 0; i < listeners.length; i += 100) {
    sockets.push(...(await Promise.all(listeners.slice(i, i + 100).map(listen))));
  }
  console.log(`Sockets: ${m.socket.connected} connected, ${m.socket.failed} failed`);
  const ticker = setInterval(() => { sampleServer(); report(false); }, 30_000);
  const serverTicker = setInterval(sampleServer, 5_000);
  const pollers = fleet.parents.slice(-POLLING_PARENTS);
  await Promise.all([...fleet.buses.map(drive), ...pollers.map(poll)]);
  clearInterval(ticker); clearInterval(serverTicker);
  await sleep(2000); // late socket deliveries
  sockets.forEach((s) => s?.close());
  report(true);
  process.exit(0);
})();
