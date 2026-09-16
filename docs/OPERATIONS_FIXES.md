# Voltava Fleet — How to Fix What the Audit Found

**Written:** 16 September 2026
**Companion to:** `docs/PRODUCTION_READINESS.md`
**Language:** plain English, with commands you can paste.

---

## Before anything else: a correction

The readiness audit said the Parent, Driver and Super Admin apps did not exist,
because `docs/frontend/OVERVIEW.md` lists all three repos as **TBD**.

**The owner has confirmed those apps are built.** They simply live outside the two
repositories this audit could see. So that blocker is withdrawn.

**Do this:** update `docs/frontend/OVERVIEW.md` with the real repo names. A stale
table is how the next person — or the next audit — reaches the same wrong conclusion.

That leaves the real list, in the order they will hurt you:

| # | Problem | Severity | Effort |
|---|---|---|---|
| 1 | No database backup | 🔴 Critical | 1 day |
| 2 | Hardware port 5000 authenticates nothing | 🔴 Critical | 2 days |
| 3 | Nobody would know if it broke | 🔴 Critical | 1 day |
| 4 | Shared parent password | 🟠 High | 2 days |
| 5 | Signed telemetry can be replayed | 🟠 High | 1 day |
| 6 | Cannot run a second server | 🟡 Medium | 1 week |
| 7 | Database shares the app's VM | 🟡 Medium | 1 day + window |
| 8 | Manual deploys, no rollback | 🟡 Medium | 2 days |
| 9 | Frontend tests dead, no CI | 🟡 Medium | 1 day |
| 10 | Dependency CVEs | 🟡 Medium | half a day |

---

# 1. Backups

## 1.1 What the industry actually does

I looked this up rather than guessing. The consensus for a self-hosted Postgres in
2026 is **two tiers, not one**:

| Tier | Tool | Answers | Recovery point |
|---|---|---|---|
| **Logical** | `pg_dump` nightly | "The VM is gone. Rebuild it anywhere." | Up to 24 hours lost |
| **Physical + WAL** | `pgBackRest` | "Someone deleted a school at 14:12. Put it back to 14:11." | Minutes |

`pg_dump` gives you a portable file that restores into any Postgres, on any host,
across versions — which is exactly what you want when the disaster is "the VM, the
zone, or the project is gone". What it cannot do is point-in-time recovery.

`pgBackRest` continuously archives the write-ahead log, which is what makes
point-in-time recovery possible. It also does block-level incrementals, parallel
restore, page-checksum validation, client-side encryption, and speaks GCS natively
(since version 2.33).

The recommendation everywhere is **run both**. Neither replaces the other.

> One thing worth knowing: pgBackRest nearly died in April 2026 when its
> maintainer stepped back after Crunchy Data was sold. A sponsor coalition funded
> its revival and releases resumed — 2.59.0 in July, 2.59.1 in August 2026. It is
> maintained again, but it is worth watching. WAL-G and Barman are the alternatives
> if you would rather not carry that risk.

**And the rule that matters more than the tool:** the best backup system is the one
that has met a *written* recovery-point and recovery-time objective **in an actual
restore drill**. A backup nobody has restored is a hope, not a backup.

## 1.2 Tier 1 — do this today

Everything needed is now committed at `deploy/backup/`:

```
deploy/backup/
  voltava-backup.sh              nightly pg_dump → verify → upload → verify again
  restore-drill.sh               download newest → restore → count rows → drop
  voltava-backup.service/.timer  systemd, 02:15 IST nightly
  voltava-restore-drill.*        systemd, first Sunday monthly
  backup.env.example             config template
  pgbackrest.conf.example        tier 2, for later
```

The backup script does four things most hand-written ones skip:

- **It verifies the dump before uploading.** `pg_restore --list` parses the archive's
  table of contents, and the script refuses to upload anything listing fewer than 10
  data tables (the schema has 18). A dump cut off mid-write fails here, not six
  months from now.
- **It verifies the upload after.** It compares the stored object's hash against the
  local file. An upload that reported success and stored something else is exactly
  how people come to trust a backup they do not have.
- **It never deletes anything remote.** Remote retention is the bucket's lifecycle
  policy. A bug in the script must not be able to remove backups.
- **It runs at `Nice=10`, `IOSchedulingClass=idle`.** The school run is the product.
  A backup finishing twenty minutes later costs nothing.

### Create the bucket

```bash
export PROJECT_ID="voltava-fleet-prod"
export BUCKET="voltava-fleet-backups"

# Dual-region so the backup survives losing asia-south1 entirely.
gcloud storage buckets create "gs://$BUCKET" \
  --project="$PROJECT_ID" \
  --location=ASIA \
  --default-storage-class=NEARLINE \
  --uniform-bucket-level-access \
  --public-access-prevention

# Versioning: a bad object cannot silently replace a good one.
gcloud storage buckets update "gs://$BUCKET" --versioning
```

### Make the backups immutable

This is the part people skip, and it is what separates a backup from a backup that
survives a compromise. If the VM is breached, whatever can reach the bucket can
delete it — unless the bucket refuses.

Google Cloud Storage offers a **retention policy** which forbids deleting or
overwriting any object until it reaches a set age, and **Bucket Lock**, which makes
that policy permanent — once locked, the retention period cannot be shortened by
anyone, including you.

```bash
# 35 days: longer than the 30-day GpsLog retention, so a restore always has
# matching GPS history.
gcloud storage buckets update "gs://$BUCKET" --retention-period=35d

# Lifecycle: delete at 90 days (retention still forbids early deletion),
# and cool older objects down to save money.
cat > /tmp/lifecycle.json <<'JSON'
{"lifecycle":{"rule":[
  {"action":{"type":"SetStorageClass","storageClass":"COLDLINE"},
   "condition":{"age":35,"matchesPrefix":["daily/"]}},
  {"action":{"type":"Delete"},
   "condition":{"age":90,"matchesPrefix":["daily/"]}},
  {"action":{"type":"Delete"},
   "condition":{"daysSinceNoncurrentTime":30,"isLive":false}}
]}}
JSON
gcloud storage buckets update "gs://$BUCKET" --lifecycle-file=/tmp/lifecycle.json
```

> ⚠️ **Do not run `buckets update --lock-retention-period` until you are certain
> about the number.** Locking is irreversible: you can raise the retention period
> afterwards but never lower it, and you cannot delete the bucket until every
> object has aged out. Run unlocked for a month, confirm the cost and the shape are
> right, then lock it.

### Give the VM the narrowest possible access

The backup job needs to **write** objects. It does not need to delete them. Splitting
those two is what stops a compromised VM from wiping the bucket.

```bash
export VM_SA="$(gcloud compute instances describe voltava-api --zone=asia-south1-a \
  --format='value(serviceAccounts[0].email)')"

# Create and read only. No storage.objects.delete.
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:$VM_SA" \
  --role=roles/storage.objectCreator
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:$VM_SA" \
  --role=roles/storage.objectViewer
```

The lifecycle policy handles deletion, and lifecycle runs as the service, not as the
VM. The VM literally cannot delete a backup.

### Install

```bash
sudo install -m 755 ~voltava/app/deploy/backup/voltava-backup.sh /usr/local/bin/
sudo install -m 755 ~voltava/app/deploy/backup/restore-drill.sh  /usr/local/bin/

sudo mkdir -p /etc/voltava /var/backups/voltava /var/tmp/voltava-drill
sudo cp ~voltava/app/deploy/backup/backup.env.example /etc/voltava/backup.env
sudo nano /etc/voltava/backup.env          # set GCS_BUCKET
sudo chown root:voltava /etc/voltava/backup.env && sudo chmod 640 /etc/voltava/backup.env
sudo chown voltava:voltava /var/backups/voltava /var/tmp/voltava-drill

# Password in .pgpass, never in the env file — an env file shows up in process
# listings and crash dumps.
sudo -u voltava bash -c 'echo "localhost:5432:voltava_fleet:voltava:THE_PASSWORD" > ~/.pgpass; chmod 600 ~/.pgpass'

sudo cp ~voltava/app/deploy/backup/voltava-*.service /etc/systemd/system/
sudo cp ~voltava/app/deploy/backup/voltava-*.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now voltava-backup.timer voltava-restore-drill.timer
```

### Prove it works — do not skip this

```bash
sudo systemctl start voltava-backup.service      # run it now
journalctl -u voltava-backup.service -n 50 --no-pager
gcloud storage ls "gs://$BUCKET/daily/"

sudo systemctl start voltava-restore-drill.service
journalctl -u voltava-restore-drill.service -n 60 --no-pager
```

The drill prints the restore time. **Write that number down — it is your RTO.**
Guessing it is how a 40-minute outage becomes an afternoon.

## 1.3 Tier 2 — within the month

`deploy/backup/pgbackrest.conf.example` is a complete annotated config for GCS,
including client-side AES-256 encryption (this is a database of children's home
addresses — Google encrypting it at rest protects you from a stolen disk, not from
anyone who can read the bucket), retention that keeps WAL only as far back as the
oldest full backup, and asynchronous archiving so a WAL switch during the morning
run does not wait on a round trip to Cloud Storage.

It needs a **Postgres restart** — `archive_mode` cannot be reloaded — so it needs a
maintenance window, which is precisely why tier 1 goes first.

One detail from the file that is easy to get wrong: a point-in-time restore target
must be written with the offset, `--target="2026-09-16 14:11:00+05:30"`. Every
"today" boundary in this service is Asia/Kolkata. A target typed in UTC lands five
and a half hours off — on a school day, the difference between before and after the
morning run.

## 1.4 Write down the targets

Put these in the runbook and hold the system to them:

| | Target | What delivers it |
|---|---|---|
| **RPO** — how much data you can lose | 5 minutes | pgBackRest WAL (`archive_timeout = 300`) |
| **RPO** if only tier 1 exists | 24 hours | nightly `pg_dump` |
| **RTO** — how long to get back | measure it, then commit to it | the monthly restore drill prints it |
| Backup retention | 90 days | bucket lifecycle |
| Drill frequency | monthly, and after every migration | `voltava-restore-drill.timer` |

---

# 2. The hardware port authenticates nothing

Right now a known or guessed IMEI is the whole credential on port 5000. Fix it in
three layers, outermost first — each one is useful on its own.

### Layer 1 — the firewall (today, 10 minutes)

```bash
gcloud compute firewall-rules update voltava-hardware \
  --source-ranges=OPERATOR_RANGE_1,OPERATOR_RANGE_2
```

Ask the SIM provider for the egress ranges of the AIS-140 APN. This is the single
highest-value change in this whole document per minute spent.

### Layer 2 — turn the checksum on (this week)

`blackbox-parser.js` already computes CRC32 and already has a `verifyCrc` option.
`tcp-server.js:62` calls it without that option, so it defaults to `false` and the
checksum is never checked.

**Do not flip it straight to enforcing.** If the CRC implementation disagrees with
what the real TM-100 sends — a different polynomial, a different field range — every
bus goes dark at once. Roll it out in two steps:

```js
// Step 1, this week — observe only. Log mismatches, drop nothing.
const parsed = parseBlackboxPacket(rawPacket, { verifyCrc: true });
if (parsed?.__crcFailed) {
  logger.warn({ imei: parsed.imei, expected: parsed.expected, received: parsed.received },
    'TCP: CRC mismatch (observing, not dropping)');
  // fall through and process the packet as before
}
```

Let that run a week across every device model in the fleet. If the mismatch rate is
near zero, promote the `continue` back in and drop failing packets. If it is not,
you have learned something important about the parser before it cost you a morning.

### Layer 3 — give the TCP path a real secret (this month)

The CRC stops corruption, not forgery — anyone can compute a CRC. The HTTP telemetry
endpoint already does this properly with a per-device HMAC and `Bus.deviceSecret`,
and `POST /api/devices/:id/rotate-secret` already exists.

What to do depends on the hardware:

- **If the TM-100 firmware can send a custom field**, append
  `HMAC-SHA256(deviceSecret, imei.timestamp.lat.lng.speed)` to the packet and verify
  it exactly as `middleware/telemetryHmac.js` does. Same helper, same secret column.
- **If it cannot** — which is common with AIS-140 units — then the firewall is the
  control, and you should say so in writing rather than assume a secret exists.
  Additionally: rate-limit per IMEI, alert when one IMEI arrives from two IP
  addresses at once, and reject positions that imply an impossible speed since the
  device's last fix. None of these are authentication, but each makes a forged
  stream visible.

---

# 3. Nobody would know if it broke

`REVIEW_LOG.md` records a deploy that crash-looped **about 190 times before anyone
noticed**. That is not a monitoring gap, it is the absence of monitoring.

The 2026 consensus for a Node service: **start with error tracking plus structured
logs, add OpenTelemetry only once there are several services and queues.** You
already have excellent structured logs (pino JSON, request IDs, correct log levels).
You are missing the two things that turn logs into a phone call.

### 3.1 Sentry — half a day

```bash
npm install @sentry/node
```

```js
// Top of index.js — BEFORE requiring ./server, so instrumentation is in place first.
require('@sentry/node').init({
  dsn: process.env.SENTRY_DSN,           // unset = silently disabled, like FIREBASE_SERVICE_ACCOUNT
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.1,
  // This service handles children's locations. Nothing identifying goes to a
  // third party: no request bodies, no headers, no IPs.
  sendDefaultPii: false,
  beforeSend(event) {
    delete event.request?.data;
    delete event.request?.cookies;
    delete event.request?.headers;
    return event;
  },
});
```

Add `SENTRY_DSN` to `config.js` as `z.string().optional()`, matching the existing
"unset means disabled" contract used by `FIREBASE_SERVICE_ACCOUNT` and the SMTP
settings. The `uncaughtException` and `unhandledRejection` handlers already in
`index.js` will then report instead of dying quietly.

### 3.2 Alerts that would have caught the real incidents

The Ops Agent is already shipping pino JSON to Cloud Logging. Build log-based
metrics on it and alert. These four come straight from incidents in `REVIEW_LOG.md`
and `DEPLOY.md`:

| Alert | Condition | The incident it catches |
|---|---|---|
| **Process restarting** | more than 3 boot log lines in 10 minutes | the 190-restart crash loop, and the OOM loop |
| **Error rate** | `level >= 50` more than 10/min for 5 min | anything failing in bulk |
| **Telemetry silence** | zero `TCP packet` lines for 15 min between 06:00–19:00 IST | the whole fleet gone dark — SIM, firewall or ingest |
| **Backup failed** | `BACKUP FAILED` appears at all | §1, which is worthless if it fails silently |

The telemetry-silence one is the most valuable and the least obvious. Every other
alert tells you the server is unhealthy. This one tells you the server is perfectly
healthy and receiving nothing, which is what a wrong firewall rule or an unpaid SIM
bill looks like.

```bash
gcloud logging metrics create voltava_fatal_errors \
  --description="Voltava API error-or-worse log lines" \
  --log-filter='resource.type="gce_instance" jsonPayload.level>=50'
```

Then Console → Monitoring → Alerting → create a policy on that metric, notifying a
channel that actually reaches a person at 07:00.

### 3.3 Make the uptime check honest

`DEPLOY.md` §9 checks `/healthz`, which returns OK as long as the process is
running. `/readyz` is the one that actually queries the database. **Point the uptime
check at `/readyz`.** And note the warning already in `DEPLOY.md`: use `curl -i`,
never `curl -s`, because `curl -s` prints nothing on connection-refused — which is
how a total outage came to look like silence.

---

# 4. The shared parent password

## 4.1 The legal position, corrected

The readiness audit implied India's DPDP Act makes this a consent problem. Having
read the rules, that framing was too simple, and the correction matters because it
changes what you have to build.

The **DPDP Rules 2025, Fourth Schedule** carve out exemptions from Section 9(1) and
9(3) — verifiable parental consent, and the ban on tracking and behavioural
monitoring of children — for specific classes of data fiduciary. Educational
institutions are named, for academic activity, tracking and monitoring, and for
ensuring the safety of enrolled students; the carve-out extends to **transport
providers engaged by such institutions**, strictly for safety during school hours
and the commute.

**A school bus tracking product sits inside that exemption**, provided processing
stays limited to child safety. So you are very probably not required to build
verifiable parental consent flows.

What is **not** exempted is Section 8(5) — the obligation to take *reasonable
security safeguards* — where penalties run to ₹250 crore per instance. A single
shared password protecting live locations of children is difficult to argue as a
reasonable safeguard.

So the issue is real, but it is a **security** issue, not a consent one. Fix it as
security. *(This is a reading of the rules, not legal advice — have your counsel
confirm the Fourth Schedule applies to your exact arrangement with each school.)*

## 4.2 Three options

**Option A — turn it off (safest, and already supported).** Leave
`PARENT_DEFAULT_PASSWORD` unset. Every parent gets a generated 12-character
password, returned once in `parentCredentials[]` on the import response. This
already works; the school just has to distribute 300 slips.

**Option B — enforce the reset (recommended: keeps the onboarding story, closes the
hole).** Keep the shared password, but make `mustResetPassword` mean something.
Right now it is advisory: the login response carries it, the token is valid anyway,
and no middleware enforces it, so a family that never changes it stays open forever.

```js
// middleware/auth.js — after verifyAccessToken succeeds
const MUST_RESET_ALLOWLIST = new Set([
  'POST /api/auth/change-password',
  'POST /api/auth/logout',
  'GET /api/users/me',
]);

function enforcePasswordReset(req, res, next) {
  if (!req.user?.mustResetPassword) return next();
  if (MUST_RESET_ALLOWLIST.has(`${req.method} ${req.route?.path ?? req.path}`)) return next();
  return res.status(403).json({
    error: 'Password reset required',
    code: 'MUST_RESET_PASSWORD',
  });
}
```

Include `mustResetPassword` in the JWT claims at login, and clear it on a successful
password change (which already revokes existing tokens, so the next token is clean).
Add a socket-side check too, or a parent could skip the REST API and still receive
live positions over Socket.IO.

Then add an expiry the shared password cannot outlive: refuse it more than N days
after the account was created, so an un-rotated string cannot accumulate open
accounts indefinitely.

**Option C — no password at all.** Onboard parents with a one-time magic link or an
SMS OTP to the number already stored in `User.phone` / `Student.guardianPhone`. Best
outcome, most work, and it needs an SMS provider — so treat it as the direction of
travel rather than this month's task.

**Whichever you choose:** parents imported before the random-password change still
hold the literal `password123` (`REVIEW_LOG.md`, open item 8). Find and reset them.

```sql
-- How many accounts are still on a shared opening password?
SELECT count(*) FROM "User" WHERE role = 'PARENT' AND "mustResetPassword" = true;
```

---

# 5. Telemetry replay

Open item 5 in `REVIEW_LOG.md`. A captured signed packet can be replayed inside the
300-second skew window.

The standard fix is **timestamp plus nonce, together**: the timestamp bounds how
long a captured packet is useful, and the nonce cache makes each one usable exactly
once inside that window. The cache needs a TTL matching the window so it cannot grow
forever and so legitimate retries work again afterwards.

```js
// middleware/telemetryHmac.js — after the signature check passes.
// Same shape as gpsWriteGate/liveFixGuard: a bounded in-memory Map, single process.
const seen = new Map();                       // signature → expiry ms
const NONCE_TTL_MS = config.TELEMETRY_MAX_SKEW_SECONDS * 1000;

function alreadySeen(sig) {
  const now = Date.now();
  if (seen.size > 20000) {                    // sweep, do not grow without bound
    for (const [k, exp] of seen) if (exp < now) seen.delete(k);
  }
  const exp = seen.get(sig);
  if (exp && exp > now) return true;
  seen.set(sig, now + NONCE_TTL_MS);
  return false;
}

if (alreadySeen(String(sig))) {
  return res.status(409).json({ error: 'Duplicate telemetry signature' });
}
```

The signature itself is the nonce here — it already covers device, timestamp,
position and speed, so two identical signatures mean the same signed packet twice.
No protocol change and no device firmware change, which is what makes it shippable.

Two caveats to write down:

- **It is per-process.** Same limitation as the token denylist. When you go
  multi-instance (§6) this moves to Redis with `SET key NX EX 300`, which is one
  line and atomic.
- **Tighten the window.** 300 seconds is generous. The AIS-140 units report every
  ~8 seconds; 60 seconds would still absorb real clock skew and shrink the attack
  window fivefold. Measure the actual skew distribution in your logs first.

Also finish **open item 7** while you are in this file: bulk telemetry is half-wired.
The middleware reads a `logs[]` array but signs only `logs[0]`, while `S.telemetry`
in `schemas.js` still requires top-level `lat`/`lng` and has no `logs` — so a bulk
payload 400s at validation. Either complete it (sign the whole batch, accept `logs`
in the schema, `createMany` in the handler) or remove the half. Half-wired security
code is worse than none, because it reads as finished.

---

# 6. Running more than one server

This is the change that turns a single point of failure into a system. It is also
the largest, and correctly ordered after everything above.

## 6.1 What has to move to Redis

Five things live in process memory today and would disagree between two copies:

| What | Where it lives now | Redis replacement |
|---|---|---|
| Revoked tokens | `Set` in `middleware/auth.js` | `SET revoked:<jti> 1 EX <ttl>` |
| Per-user invalidation cutoff | `Map` in `middleware/auth.js` | `SET uinv:<userId> <ts>` — or better, a `tokenVersion` column on `User`, which also survives a Redis flush |
| Bus presence + write throttle | `busPresence.js` | `SET bus:on:<id> 1 EX 900` |
| Live-fix watermark | `liveFixGuard.js` | `SET fix:<busId> <ms>` with a compare in Lua |
| Rate-limit counters | `express-rate-limit` memory store | `rate-limit-redis` |

`tokenVersion` deserves a moment. A column on the user row is better than Redis for
revocation because it is durable — a Redis restart silently un-revokes every token,
which is the same bug the current in-memory version has, just with more moving
parts. Bump the column on logout, delete, role change and password change; put the
version in the JWT; compare on every request.

## 6.2 Socket.IO across instances

Two separate requirements, and skipping either one produces the same symptom of
"sometimes it works":

1. **The Redis adapter** — `@socket.io/redis-adapter` — so an event emitted on
   server A reaches a client connected to server B. Without it, half your parents
   get no live position and no SOS.
2. **Sticky sessions** — every HTTP request in one Socket.IO session must land on
   the same server, because the long-polling fallback carries session state on the
   connection. In nginx that is `ip_hash` on the upstream block. The adapter does
   **not** remove this requirement; they solve different problems.

```nginx
upstream voltava_api {
    ip_hash;                       # sticky — required for the polling fallback
    server 127.0.0.1:3000;
    server 127.0.0.1:3001;
}
```

Also worth knowing before you build on it: at very high fan-out Redis Pub/Sub
becomes the bottleneck, and the adapter does not handle failure recovery or state
resynchronisation — that stays yours. At 500 buses you are nowhere near that
ceiling, but do not design as though the adapter makes the problem disappear.

## 6.3 Split the TCP listener into its own process

`ecosystem.config.js` already names this as the eventual shape. Two reasons it is
worth doing even before you scale out:

- A flood of hardware packets currently competes with the dashboard for the same
  event loop. Separate processes mean a hardware problem stays a hardware problem.
- You can then restart the API for a deploy without dropping every device
  connection, and restart ingest without logging every admin out.

Once Redis is in place for §6.1, the TCP process publishes `location_update` to
Redis and the API processes relay it to their sockets — which is the same adapter
you just installed, so the marginal cost is small.

---

# 7. Get the database off the app VM

Today Postgres and Node share a 2-vCPU, 4 GB e2-medium. During the morning run they
compete for the same CPU, the same memory and the same disk. The OOM restart loop in
`REVIEW_LOG.md` is what that looks like when it goes wrong.

Two routes:

- **Cloud SQL** — managed backups, point-in-time recovery, automatic failover, a
  maintenance window you do not operate. It is the line item that was cut, and the
  honest question is whether it costs less than one lost school.
- **A second VM running Postgres**, private IP only, with `deploy/backup/` moved
  onto it. Cheaper, and you keep operating it yourself.

Either way the application change is one line — `DATABASE_URL` — because Prisma
does not care where the database lives. Do it in a window with a fresh dump in hand.

One rule from `DEPLOY.md` that must survive the move: **never run `prisma db push`
against this database again.** It was created that way, which left it with no
`_prisma_migrations` history, and `migrate deploy` refused with P3005 until it was
baselined by hand on 28 August. `migrate deploy` only, always.

---

# 8. Deploys and rollback

Today: `git pull && npm ci && npm run build && npm run migrate:deploy && pm2 reload`,
typed over SSH, with no way back.

Minimum viable improvement, in order:

1. **Tag every release.** `git tag -a v1.4.0 -m ...` before deploying. Rollback
   becomes "check out the previous tag and `pm2 reload`" instead of archaeology.
2. **Write the rollback procedure down and test it once**, on a quiet afternoon,
   before you need it at 07:10 on a Monday.
3. **Never skip `npm ci`.** `DEPLOY.md` already records what happened the one time
   it was skipped on a deploy that added a dependency: the API crash-looped ~190
   times.
4. **Migrations need their own answer.** Code rolls back; a migration that dropped a
   column does not. The rule that makes rollback safe is **expand, then contract**:
   a release only adds nullable columns and new tables; the release that removes the
   old ones ships a week later, once the new code is proven. The schema comments
   show this instinct is already there — `3_parent_driver_contact_and_schedule`
   added four nullable columns and dropped nothing. Make it the written rule.
5. **A staging environment** pointing at a staging database. Today the first
   execution of any migration against real data happens in production.

---

# 9. The frontend

From the audit, in `school-`:

```bash
npm i -D @testing-library/jest-dom @testing-library/react @testing-library/user-event
npx vitest run          # ~41 tests run for the first time — expect some failures
```

Then stop the two test runners fighting over the same directory:

```ts
// vitest.config.mts
test: {
  environment: 'jsdom',
  globals: true,
  setupFiles: ['./vitest.setup.ts'],
  include: ['**/*.test.{ts,tsx}'],        // leave tests/*.spec.ts to Playwright
  exclude: ['node_modules', 'tests/**'],
}
```

Add CI — copy `.github/workflows/ci.yml` from this repo and swap the steps for
`tsc --noEmit`, `eslint`, `vitest run`, `next build`. Without it, the next dead test
suite goes unnoticed for just as long.

Then fix the 8 real lint errors (mostly `setState` called directly inside an effect,
on the screens that re-render most) and set `eslint.ignoreDuringBuilds: false`, so
lint has teeth. And delete the 26 leftover scratch files.

---

# 10. Dependency CVEs

```bash
# Backend — 9 issues, 2 high
npm audit fix && npm test

# Frontend — 8 issues, 1 critical
npm i next@latest && npm audit fix && npx tsc --noEmit && npm run build
```

The high-severity `nodemailer` findings matter most on the backend: one is a
recipient-domain validation bypass, in a service that sends mail to parents.

Keep the audit honest about the frontend "critical": the dashboard is a static
export on Firebase Hosting with image optimisation off, so the Next.js server-side
RCEs have no server to run on. Upgrade anyway — it protects `next dev` and the build
machine — but do not let the word "critical" reorder your priorities above backups.

Then make it not recur: turn on Dependabot or Renovate on both repos, weekly, so
this is a small pull request rather than an annual audit finding.

---

# Suggested order

| Week | Do | Result |
|---|---|---|
| **1** | §1 tier-1 backups + restore drill · §2 layer 1 firewall · §3 Sentry + 4 alerts | You can survive losing the VM, and you would know within minutes |
| **2** | §4 enforce `mustResetPassword` · §5 replay nonce · §2 layer 2 CRC observe-mode · §10 CVEs | The named security holes are closed |
| **3** | §9 frontend tests + CI · §8 tags, rollback, staging | Changes stop being able to break things silently |
| **4** | §1 tier-2 pgBackRest · §7 database onto its own host | RPO drops from 24 hours to 5 minutes |
| **5–8** | §6 Redis, Socket.IO adapter, split TCP, second instance | Genuinely horizontally scalable |

After weeks 1–3 this is a system you can responsibly sell to a school. After week 4
it is one you can responsibly sell to fifty.

---

## Sources

Backups and storage
- [PostgreSQL backup strategy: pg_dump, pg_basebackup, and pgBackRest compared — Netdata](https://www.netdata.cloud/guides/postgres/postgres-backup-strategy/)
- [PostgreSQL Backup Best Practices — Stormatics](https://stormatics.tech/blogs/postgresql-backup-best-practices)
- [PostgreSQL Backup 2026: pg_dump vs pgBackRest — Vucense](https://vucense.com/dev-corner/postgresql-backup-guide-2026/)
- [pgBackRest vs Barman vs WAL-G Compared (2026)](https://www.kunalganglani.com/blog/postgresql-backup-tools-compared)
- [Back Up PostgreSQL to S3: pg_dump vs pgBackRest (2026) — DanubeData](https://danubedata.ro/blog/postgres-backup-s3-pgdump-pgbackrest-2026)
- [Announcing Google Cloud Storage (GCS) Support for pgBackRest — Crunchy Data](https://www.crunchydata.com/blog/announcing-google-cloud-storage-gcs-support-for-pgbackrest)
- [pgBackRest Configuration Reference](https://pgbackrest.org/configuration.html) · [User Guide](https://pgbackrest.org/user-guide.html)
- [Object Retention Lock — Google Cloud Storage docs](https://docs.cloud.google.com/storage/docs/object-lock)
- [Use and lock retention policies — Google Cloud Storage docs](https://docs.cloud.google.com/storage/docs/using-bucket-lock)
- [Introducing Cloud Storage object retention lock — Google Cloud Blog](https://cloud.google.com/blog/products/storage-data-transfer/introducing-cloud-storage-object-retention-lock)
- [Data protection, backup, and recovery options — Google Cloud](https://docs.cloud.google.com/storage/docs/protection-backup-recovery-overview)

Scaling Socket.IO
- [Scaling horizontally — Socket.IO official tutorial](https://socket.io/docs/v4/tutorial/step-9)
- [Scaling Socket.IO in production — Ably](https://ably.com/topic/scaling-socketio)
- [How to Configure Socket.io with Multiple Servers — OneUptime](https://oneuptime.com/blog/post/2026-01-24-socketio-multiple-servers/view)

Replay protection
- [Prevent Replay Attacks with Nonces, Timestamps, and HMAC (2026) — ADHDecode](https://adhdecode.com/articles/cryptography/cryptography-replay-attack-prevention/)
- [Strongly securing public APIs with HMAC — Sajjad Rad](https://theredrad.medium.com/strongly-securing-public-apis-6b79c9de75c8)

Monitoring
- [The Node.js Observability Stack in 2026 — DEV](https://dev.to/axiom_agent/the-nodejs-observability-stack-in-2026-opentelemetry-prometheus-and-distributed-tracing-229b)
- [Node.js + Sentry in 2026: Production Error Monitoring](https://www.hirenodejs.com/blog/nodejs-sentry-error-monitoring-2026)
- [Best Node.js Application Monitoring Tools in 2026 — Better Stack](https://betterstack.com/community/comparisons/nodejs-application-monitoring-tools/)

India DPDP
- [Schedule 4, Digital Personal Data Protection Rules 2025](https://www.dpdpa.com/schedule/schedule4.html) · [Rule 12](https://www.dpdpa.com/dpdparules/rule12.html)
- [DPDP Rules carve out key exemptions for healthcare providers, schools and childcare services — Storyboard18](https://www.storyboard18.com/digital/dpdp-rules-carve-out-key-exemptions-for-healthcare-providers-schools-and-childcare-services-processing-childrens-data-84208.htm)
- [Impact of DPDP Rules on Educational Institutions — Pacta](https://www.pacta.in/post/impact-of-dpdp-rules-on-educational-institutions-part-ii-of-a-3-part-series)
- [Children's Data Protection Under India's DPDP Rules — King Stubb & Kasiva](https://ksandk.com/data-protection-and-data-privacy/childrens-data-protection-under-indias-dpdp-rules/)
