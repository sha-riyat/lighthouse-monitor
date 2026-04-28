-- ┌────────────────────────────────────────────────────────────┐
-- │ SPURT! Lighthouse Monitoring · PostgreSQL Schema (lean)   │
-- └────────────────────────────────────────────────────────────┘

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- --- AUDIT RUNS -------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_runs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_label     TEXT        NOT NULL,                -- e.g. "2026-05"
  triggered_by  TEXT        NOT NULL DEFAULT 'github-actions',
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ,
  total_urls    INT,
  successful    INT,
  failed        INT
);

-- --- AUDIT RESULTS (ESSENTIALS ONLY) ---------------------------

CREATE TABLE IF NOT EXISTS audit_results (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID        NOT NULL REFERENCES audit_runs(id) ON DELETE CASCADE,

  url             TEXT        NOT NULL,
  site_group      TEXT        NOT NULL,   -- e.g. 'spurtx.tools', 'spurt.group'
  audited_at      TIMESTAMPTZ NOT NULL,
  device          TEXT        NOT NULL CHECK (device IN ('mobile', 'desktop')),
  lighthouse_ver  TEXT,

  -- Scores 0-100
  performance     SMALLINT CHECK (performance BETWEEN 0 AND 100),
  accessibility   SMALLINT CHECK (accessibility BETWEEN 0 AND 100),
  best_practices  SMALLINT CHECK (best_practices BETWEEN 0 AND 100),
  seo             SMALLINT CHECK (seo BETWEEN 0 AND 100),

  -- Core Web Vitals (numeric)
  lcp_ms          NUMERIC(10,2),   -- Largest Contentful Paint (ms)
  tbt_ms          NUMERIC(10,2),   -- Total Blocking Time (ms)
  cls_value       NUMERIC(6,4),    -- Cumulative Layout Shift
  fcp_ms          NUMERIC(10,2),   -- First Contentful Paint (ms)

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- --- INDEXES ----------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_results_run_id    ON audit_results(run_id);
CREATE INDEX IF NOT EXISTS idx_results_url       ON audit_results(url);
CREATE INDEX IF NOT EXISTS idx_results_site      ON audit_results(site_group);
CREATE INDEX IF NOT EXISTS idx_results_device    ON audit_results(device);
CREATE INDEX IF NOT EXISTS idx_results_audited   ON audit_results(audited_at DESC);
CREATE INDEX IF NOT EXISTS idx_results_perf      ON audit_results(performance);
CREATE INDEX IF NOT EXISTS idx_runs_label        ON audit_runs(run_label);

-- --- VIEW: LATEST SCORES PER PAGE (for Metabase) --------------

CREATE OR REPLACE VIEW latest_scores AS
SELECT DISTINCT ON (url, device)
  r.url,
  r.site_group,
  r.device,
  r.audited_at,
  r.performance,
  r.accessibility,
  r.best_practices,
  r.seo,
  r.lcp_ms,
  r.tbt_ms,
  r.cls_value,
  r.fcp_ms,
  run.run_label
FROM audit_results r
JOIN audit_runs run ON r.run_id = run.id
ORDER BY url, device, audited_at DESC;

-- --- VIEW: MONTHLY PROGRESS (for Metabase charts) -------------

CREATE OR REPLACE VIEW monthly_progress AS
SELECT
  run.run_label,
  r.site_group,
  r.device,
  run.started_at::DATE AS audit_date,
  ROUND(AVG(r.performance))     AS avg_performance,
  ROUND(AVG(r.accessibility))   AS avg_accessibility,
  ROUND(AVG(r.best_practices))  AS avg_best_practices,
  ROUND(AVG(r.seo))             AS avg_seo,
  ROUND(AVG(r.lcp_ms))          AS avg_lcp_ms,
  ROUND(AVG(r.tbt_ms))          AS avg_tbt_ms,
  ROUND(AVG(r.cls_value)::NUMERIC, 4) AS avg_cls,
  COUNT(*)                      AS pages_audited,
  COUNT(*) FILTER (WHERE r.performance >= 95) AS pages_at_target
FROM audit_results r
JOIN audit_runs run ON r.run_id = run.id
GROUP BY run.run_label, r.site_group, r.device, run.started_at::DATE
ORDER BY audit_date DESC, r.site_group, r.device;

-- --- VIEW: PAGES BELOW 95 (mobile) ----------------------------

CREATE OR REPLACE VIEW critical_pages AS
SELECT
  url,
  site_group,
  audited_at,
  performance,
  lcp_ms,
  tbt_ms,
  cls_value
FROM latest_scores
WHERE device = 'mobile' AND performance < 95
ORDER BY performance ASC;

-- --- VIEW: SITE SUMMARY ----------------------------------------

CREATE OR REPLACE VIEW site_summary AS
SELECT
  site_group,
  device,
  ROUND(AVG(performance))    AS avg_performance,
  ROUND(AVG(accessibility))  AS avg_accessibility,
  ROUND(AVG(best_practices)) AS avg_best_practices,
  ROUND(AVG(seo))            AS avg_seo,
  MIN(performance)           AS min_performance,
  MAX(performance)           AS max_performance,
  COUNT(*)                   AS total_pages,
  COUNT(*) FILTER (WHERE performance >= 95) AS pages_at_target,
  MAX(audited_at)            AS last_audited
FROM latest_scores
GROUP BY site_group, device
ORDER BY site_group, device;