# 🚦 Spurt! Lighthouse Monitoring Pipeline

Audit automatique mensuel des performances Lighthouse pour toutes les propriétés SpurtX! & Spurt!  
**Stack :** PageSpeed Insights API → Node.js → PostgreSQL → Metabase (Docker)

---

## Architecture

```
GitHub Actions (cron 1x/mois)
        │
        │  Tunnel SSH chiffré
        ▼
   Ubuntu Server
        │
        ├── audit.js ──── PageSpeed Insights API
        │       │
        │       ▼
        │  audit-results.json
        │       │
        │       ▼
        ├── db/insert.js
        │       │
        │       ▼
        ├── PostgreSQL (port 5432 — jamais exposé publiquement)
        │
        └── Metabase Docker (port 3000)
```

---

## Secrets GitHub requis

| Secret | Description |
|---|---|
| `PSI_API_KEY` | Clé API Google PageSpeed Insights |
| `SSH_HOST` | IP publique du serveur |
| `SSH_PORT` | Port SSH du serveur (souvent `22`) |
| `SSH_USER` | Username SSH (ex: `sha`) |
| `SSH_PRIVATE_KEY` | Clé privée SSH dédiée à GitHub Actions |
| `DB_NAME` | `lighthouse_monitor` |
| `DB_USER` | `lighthouse_user` |
| `DB_PASSWORD` | Mot de passe PostgreSQL |

> `DB_HOST` n'est **pas** un secret — GitHub Actions utilise toujours `127.0.0.1`
> via le tunnel SSH, peu importe le serveur.

---

## Étape 1 — Installer les dépendances système

Se connecter au serveur via SSH, puis :

```bash
# Mise à jour système
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

# Permettre à ton user de lancer Docker sans sudo
sudo usermod -aG docker $USER
newgrp docker

# Git
sudo apt install -y git

# Vérifications
node --version      # v20.x.x
psql --version      # psql (PostgreSQL) 16.x
docker --version    # Docker version 24.x+
```

---

## Étape 2 — Générer une clé SSH dédiée à GitHub Actions

Cette clé est uniquement pour GitHub Actions — elle ne remplace pas ta clé SSH personnelle.

**Sur ton serveur** (ou sur ta machine locale, peu importe) :

```bash
# Générer une paire de clés ED25519 sans passphrase
# (GitHub Actions ne peut pas saisir de passphrase interactivement)
ssh-keygen -t ed25519 -C "github-actions-lighthouse" -f ~/.ssh/github_actions -N ""
```

Cela crée deux fichiers :
- `~/.ssh/github_actions` → **clé privée** (ira dans GitHub Secrets)
- `~/.ssh/github_actions.pub` → **clé publique** (ira sur le serveur)

---

## Étape 3 — Installer la clé publique sur le serveur

**Sur le serveur**, ajouter la clé publique aux clés autorisées :

```bash
# Afficher la clé publique
cat ~/.ssh/github_actions.pub

# L'ajouter aux clés autorisées
cat ~/.ssh/github_actions.pub >> ~/.ssh/authorized_keys

# Vérifier les permissions (important — SSH refuse si trop permissif)
chmod 700 ~/.ssh
chmod 600 ~/.ssh/authorized_keys
```

### Vérifier que la connexion SSH fonctionne

Tester depuis la même machine avant d'aller plus loin :

```bash
ssh -i ~/.ssh/github_actions -p 22 sha@localhost "echo 'SSH OK'"
# → SSH OK
```

---

## Étape 4 — Configurer PostgreSQL

```bash
sudo -i -u postgres
psql <<EOF
CREATE DATABASE lighthouse_monitor;
CREATE USER lighthouse_user WITH ENCRYPTED PASSWORD 'CHANGER_CE_MOT_DE_PASSE';
GRANT ALL PRIVILEGES ON DATABASE lighthouse_monitor TO lighthouse_user;
\c lighthouse_monitor
GRANT ALL ON SCHEMA public TO lighthouse_user;
EOF
exit
```

---

## Étape 5 — Cloner le repo et installer les dépendances Node

```bash
cd ~
git clone https://github.com/VOTRE_ORG/VOTRE_REPO.git lighthouse-monitor
cd lighthouse-monitor
npm install
```

---

## Étape 6 — Appliquer le schéma PostgreSQL

```bash
# Tu dois être dans ~/lighthouse-monitor
cd ~/lighthouse-monitor

PGPASSWORD=CHANGER_CE_MOT_DE_PASSE psql \
  -h localhost \
  -U lighthouse_user \
  -d lighthouse_monitor \
  -f db/schema.sql
```

### Vérifier

```bash
PGPASSWORD=CHANGER_CE_MOT_DE_PASSE psql \
  -h localhost -U lighthouse_user -d lighthouse_monitor -c "\dt"
# → audit_runs, audit_results

PGPASSWORD=CHANGER_CE_MOT_DE_PASSE psql \
  -h localhost -U lighthouse_user -d lighthouse_monitor -c "\dv"
# → latest_scores, monthly_progress, critical_pages, site_summary
```

---

## Étape 7 — Configurer les variables d'environnement

```bash
cd ~/lighthouse-monitor

cat > .env <<EOF
# PageSpeed Insights API
PSI_API_KEY=VOTRE_CLE_API_GOOGLE

# PostgreSQL
DB_HOST=localhost
DB_PORT=5432
DB_NAME=lighthouse_monitor
DB_USER=lighthouse_user
DB_PASSWORD=CHANGER_CE_MOT_DE_PASSE
DB_SSL=false
EOF

chmod 600 .env
```

> **Obtenir la clé PSI gratuite :**  
> https://console.cloud.google.com → Bibliothèque → "PageSpeed Insights API"  
> → Activer → Identifiants → Créer une clé API

---

## Étape 8 — Tester le pipeline localement

```bash
cd ~/lighthouse-monitor
export $(grep -v '^#' .env | grep -v '^$' | xargs)

# Test rapide sur 3 URLs
npm run audit:test

# Vérifier les fichiers générés
ls -la audit-results.json audit-results.csv

# Insérer en base
npm run db:insert

# Vérifier l'insertion
PGPASSWORD=$DB_PASSWORD psql -h localhost -U lighthouse_user -d lighthouse_monitor \
  -c "SELECT run_label, total_urls, successful, failed FROM audit_runs ORDER BY started_at DESC LIMIT 5;"
```

---

## Étape 9 — Lancer l'audit complet

```bash
cd ~/lighthouse-monitor
export $(grep -v '^#' .env | grep -v '^$' | xargs)

# 35 pages × 2 stratégies ≈ 20–25 min
npm run run:full
```

---

## Étape 10 — Installer Metabase avec Docker

Metabase utilisera la base `lighthouse_monitor` déjà créée.

### Autoriser PostgreSQL à accepter les connexions Docker

```bash
# Éditer postgresql.conf
sudo nano /etc/postgresql/16/main/postgresql.conf
# Modifier :
#   listen_addresses = 'localhost'
# → listen_addresses = '*'

# Éditer pg_hba.conf
sudo nano /etc/postgresql/16/main/pg_hba.conf
# Ajouter à la fin :
#   host  all  all  172.17.0.0/16  scram-sha-256

sudo systemctl restart postgresql
```

### Trouver l'IP du bridge Docker

```bash
ip route | grep docker0 | awk '{print $9}'
# Résultat typique : 172.17.0.1
```

### Lancer le conteneur Metabase

```bash
docker run -d \
  -p 3000:3000 \
  --name metabase \
  --restart unless-stopped \
  -e "MB_DB_TYPE=postgres" \
  -e "MB_DB_DBNAME=lighthouse_monitor" \
  -e "MB_DB_PORT=5432" \
  -e "MB_DB_USER=lighthouse_user" \
  -e "MB_DB_PASS=CHANGER_CE_MOT_DE_PASSE" \
  -e "MB_DB_HOST=172.17.0.1" \
  metabase/metabase:latest
```

> ⚠️ Remplace `172.17.0.1` par l'IP obtenue à l'étape précédente.

### Suivre le démarrage

```bash
docker logs -f metabase
# Attendre : INFO metabase.core :: Metabase Initialization COMPLETE
```

Metabase accessible sur : **`http://IP_DE_TON_SERVEUR:3000`**

---

## Étape 11 — Connecter Metabase à la base lighthouse

1. Ouvrir `http://IP_SERVEUR:3000`
2. Créer le compte admin au premier démarrage
3. **Admin → Databases → Add database**

| Champ | Valeur |
|---|---|
| Database type | PostgreSQL |
| Display name | Lighthouse Monitor |
| Host | `172.17.0.1` |
| Port | `5432` |
| Database name | `lighthouse_monitor` |
| Username | `lighthouse_user` |
| Password | ton mot de passe |

4. Cliquer **Save**

### Questions Metabase recommandées

| Question | Vue | Graphique |
|---|---|---|
| Progression mensuelle | `monthly_progress` | Line chart — `avg_performance` par `audit_date`, groupé par `site_group` |
| Score actuel par page | `latest_scores` | Table — filtrer `device = mobile` |
| Pages critiques | `critical_pages` | Table — triée par `score_performance ASC` |
| Vue par site | `site_summary` | Bar chart — `avg_performance` par `site_group` |
| Gap à la cible | `latest_scores` | Table — colonne `gap_to_target` |

---

## Étape 12 — Configurer les GitHub Secrets

Dans le repo GitHub : **Settings → Secrets and variables → Actions → New repository secret**

### Récupérer la clé privée à copier

```bash
cat ~/.ssh/github_actions
# Copier TOUT le contenu, incluant les lignes :
# -----BEGIN OPENSSH PRIVATE KEY-----
# ...
# -----END OPENSSH PRIVATE KEY-----
```

### Ajouter les secrets

| Secret | Valeur |
|---|---|
| `PSI_API_KEY` | Clé API Google PageSpeed Insights |
| `SSH_HOST` | IP publique du serveur (ex: `192.168.1.x` en local) |
| `SSH_PORT` | `22` |
| `SSH_USER` | `sha` |
| `SSH_PRIVATE_KEY` | Contenu complet de `~/.ssh/github_actions` |
| `DB_NAME` | `lighthouse_monitor` |
| `DB_USER` | `lighthouse_user` |
| `DB_PASSWORD` | Ton mot de passe PostgreSQL |

> **Trouver l'IP du serveur :**
> ```bash
> # IP locale (réseau maison / entreprise)
> hostname -I | awk '{print $1}'
>
> # IP publique (internet)
> curl ifconfig.me
> ```
> En test à la maison → utilise l'IP locale.  
> En entreprise → utilise l'IP publique ou le hostname fourni par l'équipe infra.

---

## Étape 13 — Déclencher un audit test depuis GitHub Actions

1. Aller dans le repo → **Actions → Monthly Lighthouse Audit**
2. Cliquer **Run workflow**
3. Renseigner `max_urls=3` pour un test rapide
4. Suivre l'exécution — vérifier que le tunnel SSH s'ouvre et que l'insertion réussit

Le cron automatique tourne le **1er de chaque mois à 6h00 UTC**.

---

## Structure du projet

```
lighthouse-monitor/
├── audit.js                          # Script d'audit principal
├── urls-to-audit.txt                 # Liste des 35 URLs (non commitée)
├── package.json
├── .env                              # Variables locales (jamais commitée)
├── .gitignore
├── db/
│   ├── schema.sql                    # Schéma PostgreSQL + vues Metabase
│   └── insert.js                     # Insère audit-results.json → PostgreSQL
└── .github/
    └── workflows/
        └── monthly-audit.yml         # Cron GitHub Actions + tunnel SSH
```

---

## Dépannage

### Tester le tunnel SSH manuellement

```bash
# Depuis ta machine locale, simuler ce que GitHub Actions fait
ssh -f -N \
  -L 5432:localhost:5432 \
  -i ~/.ssh/github_actions \
  -p 22 \
  sha@IP_DU_SERVEUR

# Tester la connexion via le tunnel
PGPASSWORD=CHANGER_CE_MOT_DE_PASSE psql \
  -h 127.0.0.1 -U lighthouse_user -d lighthouse_monitor -c "SELECT 1;"
# → doit retourner : 1
```

### PostgreSQL — vérifier le statut

```bash
sudo systemctl status postgresql
sudo journalctl -u postgresql -n 30
```

### Metabase Docker — vérifier le statut

```bash
docker ps                         # Vérifier que le conteneur tourne
docker logs metabase --tail 50    # Voir les derniers logs
docker restart metabase           # Redémarrer si besoin
```

### Tester la connexion PostgreSQL depuis Docker

```bash
docker run --rm postgres:16 \
  psql -h 172.17.0.1 -U lighthouse_user -d lighthouse_monitor -c "SELECT 1;"
```

### Vérifier les dernières insertions

```bash
PGPASSWORD=$DB_PASSWORD psql -h localhost -U lighthouse_user -d lighthouse_monitor -c "
  SELECT run_label, successful, failed, started_at
  FROM audit_runs
  ORDER BY started_at DESC LIMIT 5;
"
```
