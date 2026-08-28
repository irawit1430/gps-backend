# Voltava Fleet — GCP Deployment Runbook

Greenfield deploy to a Google Cloud Compute Engine VM running a self-hosted
PostgreSQL on the same VM.
Target scale: 10–50 schools / ~500 buses. **Hard cut** from the Render staging URL.

> **Architecture note (current):** Cloud SQL is **no longer used** — Postgres now
> runs directly on the Compute Engine VM to remove the managed-DB cost line item.
> Section 3 ("Cloud SQL Postgres") and the Cloud SQL Auth Proxy steps are kept
> **for reference only**. For the self-hosted setup, install PostgreSQL on the VM
> (`sudo apt-get install -y postgresql`), create the `voltava` DB/user, and set
> `DATABASE_URL=postgresql://voltava:<PASS>@localhost:5432/voltava_fleet?schema=public`.
> Cost now tracks the **VM size + disk** — keep the 30-day `GpsLog` retention cron
> (Section 10, "Ongoing operations") enabled so disk usage stays bounded.

> **Ops prerequisite for the hard cut:** every Blackbox TM-100 SIM must be
> reconfigured to point its Secondary IP (SIP) at the new static IP **before**
> Render is shut down, via SMS:
> `#1234#SET:SIP#<NEW_STATIC_IP>,5000;`
> Devices that are not reconfigured go dark. Plan this with your SIM provider.

---

## 0. Prerequisites (local machine)

- `gcloud` CLI authenticated: `gcloud auth login`
- A billing account ID: `gcloud billing accounts list`
- A domain you control (for TLS) — e.g. `api.voltava.app`

Set shell variables used throughout:

```bash
export PROJECT_ID="voltava-fleet-prod"
export REGION="asia-south1"          # Mumbai — closest to India fleet
export ZONE="asia-south1-a"
export VM_NAME="voltava-api"
export SQL_INSTANCE="voltava-pg"
export DB_NAME="voltava_fleet"
export DB_USER="voltava"
```

---

## 1. Project + APIs

```bash
gcloud projects create "$PROJECT_ID"
gcloud config set project "$PROJECT_ID"
gcloud billing projects link "$PROJECT_ID" --billing-account=YOUR_BILLING_ID

gcloud services enable \
  compute.googleapis.com \
  sqladmin.googleapis.com \
  secretmanager.googleapis.com \
  logging.googleapis.com \
  monitoring.googleapis.com
```

---

## 2. Networking: static IP + firewall

```bash
# Reserve a regional static external IP
gcloud compute addresses create voltava-ip --region="$REGION"
gcloud compute addresses describe voltava-ip --region="$REGION" --format='value(address)'
# → note this IP; it's what the TM-100 SIP + your DNS A record point to.

# Firewall: SSH (lock to your office IP), HTTP/HTTPS (world), TCP 5000 (hardware only)
gcloud compute firewall-rules create voltava-ssh \
  --allow=tcp:22 --source-ranges=YOUR_OFFICE_IP/32 --target-tags=voltava

gcloud compute firewall-rules create voltava-web \
  --allow=tcp:80,tcp:443 --source-ranges=0.0.0.0/0 --target-tags=voltava

# TCP 5000: START restricted. Replace RANGES with your SIM operator's egress
# ranges (Airtel/Jio/BSNL AIS-140 APN). 0.0.0.0/0 is a last resort ONLY because
# telemetry is HMAC-authenticated — still prefer narrowing it.
gcloud compute firewall-rules create voltava-hardware \
  --allow=tcp:5000 --source-ranges=OPERATOR_RANGE_1,OPERATOR_RANGE_2 --target-tags=voltava
```

---

## 3. Cloud SQL Postgres

```bash
gcloud sql instances create "$SQL_INSTANCE" \
  --database-version=POSTGRES_15 \
  --tier=db-custom-2-7680 \
  --region="$REGION" \
  --storage-size=50GB --storage-auto-increase \
  --backup --backup-start-time=19:00 \
  --enable-point-in-time-recovery \
  --maintenance-window-day=SUN --maintenance-window-hour=20

gcloud sql databases create "$DB_NAME" --instance="$SQL_INSTANCE"

# Strong password — store in Secret Manager, not in shell history
DB_PASS="$(openssl rand -base64 24)"
gcloud sql users create "$DB_USER" --instance="$SQL_INSTANCE" --password="$DB_PASS"
printf '%s' "$DB_PASS" | gcloud secrets create voltava-db-pass --data-file=-

# Also stash JWT secret
openssl rand -base64 48 | tr -d '\n' | gcloud secrets create voltava-jwt-secret --data-file=-
```

We connect the app to Cloud SQL via the **Cloud SQL Auth Proxy** (no public DB IP).

---

## 4. Create the VM

```bash
gcloud compute instances create "$VM_NAME" \
  --zone="$ZONE" \
  --machine-type=e2-medium \
  --image-family=ubuntu-2204-lts --image-project=ubuntu-os-cloud \
  --tags=voltava \
  --address=voltava-ip \
  --scopes=cloud-platform \
  --boot-disk-size=30GB

gcloud compute ssh "$VM_NAME" --zone="$ZONE"
```

---

## 5. VM bootstrap (run on the VM)

```bash
# System user
sudo adduser --system --group --home /home/voltava voltava

# Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs nginx certbot python3-certbot-nginx git
sudo npm install -g pm2

# Cloud SQL Auth Proxy
curl -o cloud-sql-proxy https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.11.0/cloud-sql-proxy.linux.amd64
chmod +x cloud-sql-proxy && sudo mv cloud-sql-proxy /usr/local/bin/

# Run the proxy as a service (Unix socket or TCP 127.0.0.1:5432)
# INSTANCE_CONNECTION_NAME = PROJECT:REGION:INSTANCE
sudo tee /etc/systemd/system/cloud-sql-proxy.service >/dev/null <<'EOF'
[Unit]
Description=Cloud SQL Auth Proxy
After=network.target
[Service]
ExecStart=/usr/local/bin/cloud-sql-proxy --address 127.0.0.1 --port 5432 PROJECT:REGION:voltava-pg
Restart=always
User=voltava
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now cloud-sql-proxy

# Log dir
sudo mkdir -p /var/log/voltava && sudo chown voltava:voltava /var/log/voltava
```

---

## 6. Deploy the app (run on the VM as `voltava`)

```bash
sudo -u voltava -i
git clone https://github.com/irawit1430/gps-backend.git app && cd app
git checkout claude/production-readiness-audit-ku3200   # or the merged branch

npm ci
npm run build          # prisma generate against Postgres schema

# Write .env from .env.example
cp .env.example .env
# Fill in:
#   DATABASE_URL=postgresql://voltava:<DB_PASS>@localhost:5432/voltava_fleet?schema=public
#   JWT_SECRET=<from Secret Manager>
#   CORS_ORIGINS=https://admin.voltava.app,https://school.voltava.app,https://app.voltava.app
#   FIREBASE_SERVICE_ACCOUNT=<base64 of prod service-account JSON>
#   TELEMETRY_HMAC_ENFORCE=1
#   NODE_ENV=production
nano .env

# Pull secrets from Secret Manager (optional, instead of pasting)
gcloud secrets versions access latest --secret=voltava-db-pass
gcloud secrets versions access latest --secret=voltava-jwt-secret

# First-time DB schema
npm run migrate:deploy

# Seed the ONE super admin (no demo fixtures in prod)
ALLOW_SEED=1 SEED_ADMIN_EMAIL='you@voltava.app' SEED_ADMIN_PASSWORD='<strong-pass>' \
  SEED_INCLUDE_DEMO=0 npm run seed
```

Start under PM2:

```bash
pm2 start ecosystem.config.js
pm2 save
exit   # back to sudo-capable user
```

Install the PM2 systemd unit (so it survives reboots):

```bash
sudo cp ~voltava/app/deploy/pm2-voltava.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pm2-voltava
```

---

## 7. TLS + nginx

```bash
sudo cp ~voltava/app/deploy/nginx-voltava.conf /etc/nginx/sites-available/voltava
# Edit server_name to your domain
sudo ln -s /etc/nginx/sites-available/voltava /etc/nginx/sites-enabled/voltava
sudo rm -f /etc/nginx/sites-enabled/default

# DNS: point api.voltava.app A record → the reserved static IP (step 2) first!
sudo certbot --nginx -d api.voltava.app
sudo nginx -t && sudo systemctl reload nginx
```

---

## 8. Observability (GCP Ops Agent)

```bash
curl -sSO https://dl.google.com/cloudagents/add-google-cloud-ops-agent.sh
sudo bash add-google-cloud-ops-agent.sh --also-install
# Ops Agent ships stdout/stderr (our pino JSON) to Cloud Logging automatically.
```

Uptime check (from Cloud Console → Monitoring → Uptime checks):
- HTTPS `GET https://api.voltava.app/healthz` every 60s.

---

## 9. Cut-over checklist (hard cut)

1. GCP app is green: `curl https://api.voltava.app/healthz` → `{"status":"ok"}`,
   and `/readyz` → `200`.
2. Point all frontend builds (Super Admin, School Admin, Parent, Driver) at
   `https://api.voltava.app` and `wss://api.voltava.app`.
3. Send the SIP-reconfigure SMS to every TM-100 SIM (see top of doc).
4. Watch `pm2 logs` + Cloud Logging for incoming telemetry from real devices.
5. Once telemetry + logins confirmed from all client types → shut down Render.

---

## 10. Ongoing operations

- **GPS log retention** (unbounded table). Add a nightly cron on the VM:
  ```bash
  # crontab -u voltava -e
  0 3 * * * psql "$DATABASE_URL" -c "DELETE FROM \"GpsLog\" WHERE timestamp < now() - interval '30 days';"
  ```
  (Or move to Postgres native partitioning by month + drop old partitions.)
- **DB backups**: Cloud SQL automated backups + PITR are on (step 3). Verify a
  restore into a scratch instance quarterly.
- **Rotating a device secret**: `POST /api/devices/:id/rotate-secret` (SUPER_ADMIN),
  then re-flash the returned secret to the device.
- **Deploys**: `git pull && npm ci && npm run build && npm run migrate:deploy && pm2 reload voltava-fleet`.
- **Never skip `npm ci` on a deploy.** The GCP cheatsheet`s shorter sequence omits it,
  and the first deploy that added a dependency (nodemailer) crash-looped the API ~190
  times before anyone noticed — `curl -s` prints nothing on connection-refused, so it
  looked like silence rather than an outage. Use `curl -i` when verifying.
- **The database was created with `prisma db push`**, so it had no `_prisma_migrations`
  history and `migrate deploy` refused with **P3005**. Resolved 2026-08-28 by confirming
  `prisma migrate diff` was empty and baselining all five with `migrate resolve --applied`.
  It cannot recur. Do not `db push` against this database again — it desyncs the history
  and cannot express partial indexes the schema will need.
- **`TZ=Asia/Kolkata` lives in `ecosystem.config.js`, not `.env`.** Node fixes its timezone
  at process start, before dotenv runs, so a TZ line in `.env` changes nothing. Verify with
  `curl -i localhost:3000/healthz` — `utcOffsetMinutes` must read 330.
