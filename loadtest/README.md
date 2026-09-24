# Load test

Drives a whole fleet at a **staging** server: every bus sends signed GPS on the driver
app's 15-second cadence, parents hold the live map open, and parents refresh their
child's card. It reports how much GPS got in, how fast, and how late the live position
reached a parent — the launch criteria's "≥99% telemetry ingestion" measured directly.

**Never run it against production.** It writes GPS for buses that do not exist and needs
the server's JWT secret to sign parent tokens.

## Run

```bash
# 1. A scratch database (its name must contain "loadtest"), migrated
createdb voltava_loadtest
DATABASE_URL=postgresql://…/voltava_loadtest npx prisma migrate deploy

# 2. The fleet: 500 buses on running trips, 25 schools, 10 stops each, 2 children per stop
LOADTEST_ALLOW_SEED=1 DATABASE_URL=postgresql://…/voltava_loadtest node loadtest/seed.js

# 3. A staging server on that database (all traffic comes from one machine, so lift the
#    per-address ceiling for heavy runs: RATE_LIMIT_PER_IP_PER_MIN=1000000)

# 4. Go
TARGET=http://staging:3000 JWT_SECRET=<staging secret> node loadtest/run.js
```

Knobs: `DURATION_S` (180), `INTERVAL_S` (15; 3 = five times the GPS), `SOCKET_PARENTS`
(2000), `POLLING_PARENTS` (2000), `POLL_S` (60), `SERVER_PID` (sample the server's CPU
and memory when it runs on the same machine). Results land in `loadtest/result.json`.
Remove the fleet with `node loadtest/seed.js --clean`.

## Results, 24 September 2026

One 4-vCPU / 15 GB machine running the server (production mode, 5 database
connections), Postgres and the load generator together. The production VM is an
e2-medium (2 shared vCPUs), so expect roughly half this headroom there, and repeat the
test on a staging VM of the same size before a large rollout.

| Load | GPS accepted | GPS p95 / p99 | Parent refresh p95 | Live map p95 | Server CPU avg / peak | Memory |
|---|---|---|---|---|---|---|
| **1×**: 500 buses every 15 s, 2,000 live parents, 2,000 refreshing each minute | **100%** (5,915) | 15 / 27 ms | 17 ms | 15 ms | 33% / 91% of a core | 223 MB |
| **5×**: every 3 s, 5,000 live, 5,000 refreshing every 30 s | **100%** (18,569) | 174 / 757 ms | 183 ms | 174 ms | 138% / 222% | 553 MB |
| **10×**: every 1.5 s, 5,000 live, 10,000 refreshing every 15 s | 75% | 18.7 / 66 s | 27 s | 15.8 s | 154% / 252% | 673 MB |

- 500 buses are comfortable; the server holds up to about 5× before it slows, and is
  overloaded at 10× (the generator on the same machine contributes to that last row).
  No server errors at any level.
- **Found and fixed on the way:** every request was rate-limited per IP address, 300 a
  minute. Mobile operators put many phones behind one address, and with 500 buses on
  one address only 12% of GPS was accepted (the rest got 429). GPS is now limited per
  device, signed-in users per user, with a generous per-address ceiling as a backstop.
  Rerun with default limits: 100%.
