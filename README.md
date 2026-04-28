
# Spurt! Lighthouse Monitoring Pipeline

Automated monthly Lighthouse audits for all SpurtX! & Spurt! properties.  
**Stack:** PageSpeed Insights API -> Node.js -> PostgreSQL -> Metabase (Docker)

---

## Architecture

```
GitHub Actions (cron 1x/month)
        |
        |  Encrypted SSH tunnel
        v
   Ubuntu Server
        |
        +-- audit.js ---------- PageSpeed Insights API
        |       |
        |       v
        |  audit-results.json
        |       |
        |       v
        +-- db/insert.js
        |       |
        |       v
        +-- PostgreSQL (port 5432 – never exposed publicly)
        |
        +-- Metabase Docker (port 3000)
```

---
```
## GitHub Secrets required

| Secret | Description |
|--------|-------------|
| `PSI_API_KEY` | Google PageSpeed Insights API key |
| `SSH_HOST` | Public IP of your server |
| `SSH_PORT` | SSH port (usually 22) |
| `SSH_USER` | SSH username (e.g. sha) |
| `SSH_PRIVATE_KEY` | SSH private key for GitHub Actions |
| `DB_NAME` | lighthouse_monitor |
| `DB_USER` | lighthouse_user |
| `DB_PASSWORD` | PostgreSQL password |

> `DB_HOST` is **not** a secret – GitHub Actions always uses 127.0.0.1 via the SSH tunnel.
```
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

# Verify installations
node --version      # v20.x.x
psql --version      # psql (PostgreSQL) 16.x
docker --version    # Docker version 24.x+
```

---

## Step 2 — Generate a dedicated SSH key for GitHub Actions

This key is only for GitHub Actions – it does not replace your personal SSH key.

**On your server** (or any machine):

```bash
ssh-keygen -t ed25519 -C "github-actions-lighthouse" -f ~/.ssh/github_actions -N ""
```

This creates:
- `~/.ssh/github_actions` -> **private key** (goes into GitHub Secrets)
- `~/.ssh/github_actions.pub` -> **public key** (goes on the server)

---

## Step 3 — Install the public key on the server

**On the server**, add the public key to authorised keys:

```bash
cat ~/.ssh/github_actions.pub >> ~/.ssh/authorized_keys
chmod 700 ~/.ssh
chmod 600 ~/.ssh/authorized_keys
```

### Test the SSH connection

```bash
ssh -i ~/.ssh/github_actions -p 22 sha@localhost "echo 'SSH OK'"
# -> SSH OK
```

---

## Step 4 — Set up PostgreSQL

```bash
sudo -i -u postgres
psql <<EOF
CREATE DATABASE lighthouse_monitor;
CREATE USER lighthouse_user WITH ENCRYPTED PASSWORD 'CHANGE_THIS_PASSWORD';
GRANT ALL PRIVILEGES ON DATABASE lighthouse_monitor TO lighthouse_user;
\c lighthouse_monitor
GRANT ALL ON SCHEMA public TO lighthouse_user;
EOF
exit
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

## Step 6 — Apply the PostgreSQL schema

```bash
cd ~/lighthouse-monitor

PGPASSWORD=CHANGE_THIS_PASSWORD psql \
  -h localhost \
  -U lighthouse_user \
  -d lighthouse_monitor \
  -f db/schema.sql
```

### Verify

```bash
PGPASSWORD=CHANGE_THIS_PASSWORD psql \
  -h localhost -U lighthouse_user -d lighthouse_monitor -c "\dt"
# -> audit_runs, audit_results

PGPASSWORD=CHANGE_THIS_PASSWORD psql \
  -h localhost -U lighthouse_user -d lighthouse_monitor -c "\dv"
# -> latest_scores, monthly_progress, critical_pages, site_summary
```

---

## Step 7 — Configure environment variables

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

> **Get your free PSI key:**  
> https://console.cloud.google.com -> Library -> "PageSpeed Insights API"  
> -> Enable -> Credentials -> Create API key

---

## Step 8 — Test the pipeline locally

```bash
cd ~/lighthouse-monitor
export $(grep -v '^#' .env | grep -v '^$' | xargs)

# Quick test on 3 URLs
npm run audit:test

# Check generated files
ls -la audit-results.json audit-results.csv

# Insert into database
npm run db:insert

# Verify insertion
PGPASSWORD=$DB_PASSWORD psql -h localhost -U lighthouse_user -d lighthouse_monitor \
  -c "SELECT run_label, total_urls, successful, failed FROM audit_runs ORDER BY started_at DESC LIMIT 5;"
```

---

## Step 9 — Run a full audit

```bash
cd ~/lighthouse-monitor
export $(grep -v '^#' .env | grep -v '^$' | xargs)

# ~35 pages x 2 strategies ≈ 20-25 minutes
npm run run:full
```

---

## Step 10 — Install Metabase with Docker

Metabase will connect to the existing `lighthouse_monitor` database.

### Allow PostgreSQL to accept Docker connections

```bash
# Edit postgresql.conf
sudo nano /etc/postgresql/16/main/postgresql.conf
# Change:
#   listen_addresses = 'localhost'
# -> listen_addresses = '*'

# Edit pg_hba.conf
sudo nano /etc/postgresql/16/main/pg_hba.conf
# Add at the end:
#   host  all  all  172.17.0.0/16  scram-sha-256

sudo systemctl restart postgresql
```

### Find the Docker bridge IP

```bash
ip route | grep docker0 | awk '{print $9}'
# Typical result: 172.17.0.1
```

### Start the Metabase container

```bash
docker run -d \
  -p 3000:3000 \
  --name metabase \
  --restart unless-stopped \
  -e "MB_DB_TYPE=postgres" \
  -e "MB_DB_DBNAME=lighthouse_monitor" \
  -e "MB_DB_PORT=5432" \
  -e "MB_DB_USER=lighthouse_user" \
  -e "MB_DB_PASS=CHANGE_THIS_PASSWORD" \
  -e "MB_DB_HOST=172.17.0.1" \
  metabase/metabase:latest
```

> Replace `172.17.0.1` with the IP you found above.

### Check logs

```bash
docker logs -f metabase
# Wait for: INFO metabase.core :: Metabase Initialization COMPLETE
```

Metabase is now available at **`http://YOUR_SERVER_IP:3000`**

---

## Step 11 — Connect Metabase to the database

1. Open `http://YOUR_SERVER_IP:3000`
2. Create the admin account on first start
3. **Admin -> Databases -> Add database**

| Field | Value |
|-------|-------|
| Database type | PostgreSQL |
| Display name | Lighthouse Monitor |
| Host | 172.17.0.1 |
| Port | 5432 |
| Database name | lighthouse_monitor |
| Username | lighthouse_user |
| Password | your PostgreSQL password |

4. Click **Save**

### Recommended Metabase questions

| Question | View | Chart |
|----------|------|-------|
| Monthly progress | monthly_progress | Line chart – avg_performance by audit_date, grouped by site_group |
| Latest scores per page | latest_scores | Table – filter device = mobile |
| Critical pages | critical_pages | Table – sorted by performance ASC |
| Site summary | site_summary | Bar chart – avg_performance by site_group |

---

## Step 12 — Configure GitHub Secrets

In your GitHub repo: **Settings -> Secrets and variables -> Actions -> New repository secret**

### To get the private key content

```bash
cat ~/.ssh/github_actions
# Copy everything, including:
# -----BEGIN OPENSSH PRIVATE KEY-----
# ...
# -----END OPENSSH PRIVATE KEY-----
```

### Add these secrets

| Secret | Value |
|--------|-------|
| `PSI_API_KEY` | Your Google PageSpeed Insights API key |
| `SSH_HOST` | Public IP of your server |
| `SSH_PORT` | 22 |
| `SSH_USER` | sha |
| `SSH_PRIVATE_KEY` | Full content of ~/.ssh/github_actions |
| `DB_NAME` | lighthouse_monitor |
| `DB_USER` | lighthouse_user |
| `DB_PASSWORD` | Your PostgreSQL password |

> **Find your server IP:**  
> Local IP (home/office): `hostname -I | awk '{print $1}'`  
> Public IP: `curl ifconfig.me`

---

## Step 13 — Trigger a test audit from GitHub Actions

1. Go to your repo -> **Actions -> Monthly Lighthouse Audit**
2. Click **Run workflow**
3. Enter `max_urls=3` for a quick test
4. Watch the run – verify SSH tunnel and database insertion succeed

The automatic cron runs on the **1st day of each month at 06:00 UTC**.

---

## Project structure

```
lighthouse-monitor/
+-- audit.js                          # Main audit script (simplified)
+-- urls-to-audit.txt                 # List of URLs (not committed)
+-- package.json
+-- .env                              # Local variables (never committed)
+-- .gitignore
+-- db/
|   +-- schema.sql                    # PostgreSQL schema + Metabase views
|   +-- insert.js                     # Inserts audit-results.json into PostgreSQL
+-- .github/
    +-- workflows/
        +-- monthly-audit.yml         # Cron + SSH tunnel
```

---

## Troubleshooting

### Test the SSH tunnel manually

```bash
# From your local machine, simulate what GitHub Actions does
ssh -f -N \
  -L 5432:localhost:5432 \
  -i ~/.ssh/github_actions \
  -p 22 \
  sha@YOUR_SERVER_IP

# Test connection through the tunnel
PGPASSWORD=YOUR_PASSWORD psql \
  -h 127.0.0.1 -U lighthouse_user -d lighthouse_monitor -c "SELECT 1;"
# -> should return: 1
```

### Check PostgreSQL status

```bash
sudo systemctl status postgresql
sudo journalctl -u postgresql -n 30
```

### Check Metabase status

```bash
docker ps
docker logs metabase --tail 50
docker restart metabase
```

### Test PostgreSQL connection from Docker

```bash
docker run --rm postgres:16 \
  psql -h 172.17.0.1 -U lighthouse_user -d lighthouse_monitor -c "SELECT 1;"
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

- The audit script collects only **performance, accessibility, best practices, SEO** scores plus Core Web Vitals (LCP, TBT, CLS, FCP).  
- PWA metrics and CruX data have been removed because Lighthouse no longer provides PWA scores and we focus on lab data.  
- All code uses simple British English and is deliberately minimal for easy maintenance.
