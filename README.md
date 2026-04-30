# Spurt! Lighthouse Monitoring Pipeline

Automated monthly Lighthouse audits for all Spurt! properties.  
**Stack:** PageSpeed Insights API → Node.js → PostgreSQL → Metabase (Docker)

---

## How it works

```
GitHub Actions (cron: 1st of every month, 06:00 UTC)
        │
        │  Encrypted SSH tunnel
        ▼
   Ubuntu Server
        │
        ├── audit.js ──────────── calls PageSpeed Insights API for each URL
        │       │                 saves results to audit-results.json
        │       ▼
        ├── db/insert.js ──────── reads audit-results.json
        │       │                 inserts rows into PostgreSQL
        │       ▼
        └── PostgreSQL (port 5432 – never exposed publicly)
                │
                ├── lighthouse_monitor   ← audit data (our DB)
                └── metabaseappdb        ← Metabase internal DB (do not touch)

Metabase Docker container (port 3000)
        └── reads lighthouse_monitor → displays dashboard
```

---

## Two databases — important

There are two separate databases on the same PostgreSQL server.

| Database | Purpose |
|---|---|
| `lighthouse_monitor` | Stores all audit results. This is our data. |
| `metabaseappdb` | Used by Metabase internally. Never use this for audits. |

Metabase uses `metabaseappdb` to store its own settings, users, and questions.  
Metabase connects to `lighthouse_monitor` as a data source to read audit results.

---

## GitHub Secrets required

Go to your repository → **Settings → Secrets and variables → Actions**

| Secret | Description |
|---|---|
| `PSI_API_KEY` | Google PageSpeed Insights API key |
| `SSH_HOST` | Public IP of your server |
| `SSH_PORT` | SSH port (usually `22`) |
| `SSH_USER` | SSH username on the server |
| `SSH_PRIVATE_KEY` | Private key used by GitHub Actions |
| `DB_NAME` | `lighthouse_monitor` |
| `DB_USER` | `lighthouse_user` |
| `DB_PASSWORD` | PostgreSQL password |

> `DB_HOST` is **not** a secret — GitHub Actions always uses `127.0.0.1` via the SSH tunnel.

---

## Step 1 — Install system dependencies

Connect to your server via SSH and run:

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# PostgreSQL 16
sudo apt install -y postgresql postgresql-contrib

# Docker
sudo apt install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io

# Allow your user to run Docker without sudo
sudo usermod -aG docker $USER
newgrp docker

# Git
sudo apt install -y git

# Verify
node --version      # v20.x.x
psql --version      # psql (PostgreSQL) 16.x
docker --version    # Docker version 24.x+
```

---

## Step 2 — Generate a dedicated SSH key for GitHub Actions

This key is only for GitHub Actions. It does not replace your personal SSH key.

Run this on your server (or any machine):

```bash
ssh-keygen -t ed25519 -C "github-actions-lighthouse" -f ~/.ssh/github_actions -N ""
```

This creates:
- `~/.ssh/github_actions` → **private key** — goes into GitHub Secrets
- `~/.ssh/github_actions.pub` → **public key** — goes on the server

---

## Step 3 — Install the public key on the server

```bash
cat ~/.ssh/github_actions.pub >> ~/.ssh/authorized_keys
chmod 700 ~/.ssh
chmod 600 ~/.ssh/authorized_keys
```

### Test the connection

```bash
ssh -i ~/.ssh/github_actions -p 22 sha@localhost "echo 'SSH OK'"
# → SSH OK
```

---

## Step 4 — Set up PostgreSQL

### Create the lighthouse_monitor database

```bash
sudo -u postgres psql <<EOF
CREATE DATABASE lighthouse_monitor;
CREATE USER lighthouse_user WITH ENCRYPTED PASSWORD 'CHANGE_THIS_PASSWORD';
GRANT ALL PRIVILEGES ON DATABASE lighthouse_monitor TO lighthouse_user;
\c lighthouse_monitor
GRANT ALL ON SCHEMA public TO lighthouse_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO lighthouse_user;
EOF
```

### Create the tables

```bash
PGPASSWORD=CHANGE_THIS_PASSWORD psql \
  -h localhost -U lighthouse_user -d lighthouse_monitor \
  -f db/schema.sql
```

### Verify

```bash
PGPASSWORD=CHANGE_THIS_PASSWORD psql \
  -h localhost -U lighthouse_user -d lighthouse_monitor -c "\dt"
# → audit_runs, audit_results
```

---

## Step 5 — Clone the repo and install Node dependencies

```bash
cd ~
git clone https://github.com/YOUR_ORG/YOUR_REPO.git lighthouse-monitor
cd lighthouse-monitor
npm install
```

---

## Step 6 — Configure environment variables

```bash
cd ~/lighthouse-monitor

cat > .env <<EOF
# PageSpeed Insights API
PSI_API_KEY=YOUR_GOOGLE_API_KEY

# PostgreSQL
DB_HOST=localhost
DB_PORT=5432
DB_NAME=lighthouse_monitor
DB_USER=lighthouse_user
DB_PASSWORD=CHANGE_THIS_PASSWORD
DB_SSL=false
EOF

chmod 600 .env
```

> **Get a free PSI key:**  
> https://console.cloud.google.com → Library → "PageSpeed Insights API" → Enable → Credentials → Create API key

---

## Step 7 — Test the pipeline locally

```bash
cd ~/lighthouse-monitor
export $(grep -v '^#' .env | grep -v '^$' | xargs)

# Quick test on 3 URLs
npm run audit:test

# Insert into database
npm run db:insert

# Verify
PGPASSWORD=$DB_PASSWORD psql -h localhost -U lighthouse_user -d lighthouse_monitor \
  -c "SELECT run_label, total_urls, successful, failed FROM audit_runs ORDER BY started_at DESC LIMIT 5;"
```

---

## Step 8 — Run a full audit

```bash
cd ~/lighthouse-monitor
export $(grep -v '^#' .env | grep -v '^$' | xargs)

# ~35 pages x 2 strategies ≈ 20–25 minutes
npm run run:full
```

---

## Step 9 — Install Metabase with Docker

Metabase runs as a Docker container. It stores its own data in `metabaseappdb` and reads audit data from `lighthouse_monitor`.

### Allow PostgreSQL to accept connections from Docker

The Docker container connects to PostgreSQL using the Docker bridge IP (`172.17.0.1`). You need to allow this in PostgreSQL config.

```bash
# Step 1 — Allow PostgreSQL to listen on all interfaces
sudo nano /etc/postgresql/16/main/postgresql.conf
```

Find this line and change it:
```
# Before
listen_addresses = 'localhost'

# After
listen_addresses = '*'
```

```bash
# Step 2 — Allow connections from the Docker network
sudo nano /etc/postgresql/16/main/pg_hba.conf
```

Add this line at the end:
```
host  all  all  172.17.0.0/16  scram-sha-256
```

```bash
# Step 3 — Restart PostgreSQL
sudo systemctl restart postgresql
```

### Find the Docker bridge IP

```bash
ip route | grep docker0 | awk '{print $9}'
# Typical result: 172.17.0.1
```

### Create the Metabase internal database

```bash
sudo -u postgres psql <<EOF
CREATE DATABASE metabaseappdb;
CREATE USER metabase_user WITH ENCRYPTED PASSWORD 'CHANGE_THIS_PASSWORD';
GRANT ALL PRIVILEGES ON DATABASE metabaseappdb TO metabase_user;
\c metabaseappdb
GRANT ALL ON SCHEMA public TO metabase_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO metabase_user;
EOF
```

> **Note:** On PostgreSQL 15+, the `GRANT ALL ON SCHEMA public` line is required.  
> Without it, Metabase cannot create its internal tables and will restart in a loop.

### Start the Metabase container

Replace `172.17.0.1` with the IP you found above if it is different.

```bash
docker run -d \
  --name metabase \
  --restart unless-stopped \
  -p 3000:3000 \
  -e MB_DB_TYPE=postgres \
  -e MB_DB_DBNAME=metabaseappdb \
  -e MB_DB_PORT=5432 \
  -e MB_DB_USER=metabase_user \
  -e MB_DB_PASS=CHANGE_THIS_PASSWORD \
  -e MB_DB_HOST=172.17.0.1 \
  metabase/metabase:latest
```

### Check startup logs

```bash
docker logs -f metabase
# Wait for: INFO metabase.core :: Metabase Initialization COMPLETE
```

Metabase is now available at **`http://YOUR_SERVER_IP:3000`**

---

## Step 10 — Connect Metabase to lighthouse_monitor

1. Open `http://YOUR_SERVER_IP:3000`
2. Create the admin account on first start
3. Go to **Admin → Databases → Add database**

| Field | Value |
|---|---|
| Database type | PostgreSQL |
| Display name | Lighthouse Monitor |
| Host | `172.17.0.1` |
| Port | `5432` |
| Database name | `lighthouse_monitor` |
| Username | `lighthouse_user` |
| Password | your PostgreSQL password |

4. Click **Save**

> This is the **data source** connection — separate from `metabaseappdb` which Metabase manages itself.

---

## Step 11 — Configure GitHub Secrets

```bash
# Copy the full content of the private key
cat ~/.ssh/github_actions
# Copy everything including:
# -----BEGIN OPENSSH PRIVATE KEY-----
# ...
# -----END OPENSSH PRIVATE KEY-----
```

Add each value as a secret in **Settings → Secrets and variables → Actions → New repository secret**

> **Find your server's public IP:** `curl ifconfig.me`

---

## Step 12 — Trigger a test run from GitHub Actions

1. Go to your repo → **Actions → Monthly Lighthouse Audit → Run workflow**
2. Enter `max_urls = 3` for a quick test
3. Watch the run — verify the SSH tunnel opens and the insert succeeds

The automatic cron runs on the **1st of every month at 06:00 UTC**.

---

## Database schema

### `audit_runs` — one row per monthly audit

| Column | Description |
|---|---|
| `id` | Auto-generated ID |
| `run_label` | Month label, e.g. `2026-04` |
| `triggered_by` | `github-actions` or `manual` |
| `started_at` | When the audit started |
| `completed_at` | When the insert finished |
| `total_urls` | Number of URLs audited |
| `successful` | Rows inserted without error |
| `failed` | Rows skipped due to audit errors |

### `audit_results` — one row per URL per device

| Column | Description |
|---|---|
| `run_id` | Links to `audit_runs.id` |
| `url` | The audited URL |
| `site_group` | Site name / group |
| `device` | `mobile` or `desktop` |
| `performance` | Score 0–100 |
| `accessibility` | Score 0–100 |
| `best_practices` | Score 0–100 |
| `seo` | Score 0–100 |
| `lcp_ms` | Largest Contentful Paint (ms) |
| `tbt_ms` | Total Blocking Time (ms) |
| `cls_value` | Cumulative Layout Shift |
| `fcp_ms` | First Contentful Paint (ms) |

---

## Speed targets

| Metric | Target |
|---|---|
| Performance score | ≥ 95 |
| LCP | < 2,500 ms |
| TBT | < 200 ms |
| CLS | < 0.1 |

---

## Project structure

```
lighthouse-monitor/
├── audit.js                      # Main audit script
├── urls-to-audit.txt             # List of URLs (not committed)
├── package.json
├── .env                          # Local variables (never committed)
├── .gitignore
├── db/
│   ├── schema.sql                # PostgreSQL schema
│   └── insert.js                 # Inserts audit-results.json into PostgreSQL
└── .github/
    └── workflows/
        └── monthly-audit.yml     # Cron + SSH tunnel + insert
```

---

## Troubleshooting

### Test the SSH tunnel manually

```bash
ssh -f -N \
  -L 5432:localhost:5432 \
  -i ~/.ssh/github_actions \
  -p 22 \
  sha@YOUR_SERVER_IP

PGPASSWORD=YOUR_PASSWORD psql \
  -h 127.0.0.1 -U lighthouse_user -d lighthouse_monitor -c "SELECT 1;"
# → 1
```

### Test PostgreSQL connection from Docker

```bash
docker run --rm postgres:16 \
  psql -h 172.17.0.1 -U lighthouse_user -d lighthouse_monitor -c "SELECT 1;"
# → 1
```

### PostgreSQL keeps restarting

If `sudo journalctl -u postgresql -n 30` shows repeated stop/start cycles, check the log:

```bash
sudo tail -50 /var/log/postgresql/postgresql-16-main.log
```

If you see `permission denied for schema public` for `metabase_user`, run:

```bash
sudo -u postgres psql
\c metabaseappdb
GRANT ALL ON SCHEMA public TO metabase_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO metabase_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO metabase_user;
```

Then restart both services:

```bash
sudo systemctl restart postgresql@16-main
docker restart metabase
```

### Check service status

```bash
# PostgreSQL
sudo systemctl status postgresql@16-main

# Metabase
docker ps
docker logs metabase --tail 50
```

### Restart everything

```bash
sudo systemctl restart postgresql@16-main
docker restart metabase
```

### Verify recent insertions

```bash
PGPASSWORD=$DB_PASSWORD psql -h localhost -U lighthouse_user -d lighthouse_monitor -c "
  SELECT run_label, successful, failed, started_at
  FROM audit_runs
  ORDER BY started_at DESC LIMIT 5;
"
```

---

## Notes

- The audit collects **performance, accessibility, best practices, SEO** scores and Core Web Vitals (LCP, TBT, CLS, FCP).
- PWA metrics have been removed — Lighthouse no longer provides PWA scores.
- `run_label` is generated automatically as `YYYY-MM` (e.g. `2026-04`). You can override it with `--label=` when running manually.
- `DB_HOST` is always `127.0.0.1` in GitHub Actions because the SSH tunnel forwards the remote PostgreSQL port to localhost on the runner.
- Metabase Docker uses `172.17.0.1` (the Docker bridge IP) to reach PostgreSQL on the host machine.
