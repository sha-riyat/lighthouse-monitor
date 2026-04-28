-- ╔══════════════════════════════════════════════════════════╗
-- ║   SPURT! — Lighthouse Monitoring · PostgreSQL Schema    ║
-- ╚══════════════════════════════════════════════════════════╝

-- Extension pour les UUIDs
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── TABLE PRINCIPALE : RÉSULTATS D'AUDIT ──────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_runs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_label     TEXT        NOT NULL,                  -- ex: "2026-05", "manual-2026-04-27"
  triggered_by  TEXT        NOT NULL DEFAULT 'github-actions',  -- 'github-actions' | 'manual'
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ,
  total_urls    INT,
  successful    INT,
  failed        INT
);

-- ─── TABLE DES RÉSULTATS PAR PAGE ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_results (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID        NOT NULL REFERENCES audit_runs(id) ON DELETE CASCADE,

  -- Identification de la page
  url             TEXT        NOT NULL,
  site_group      TEXT        NOT NULL,   -- ex: 'spurtx.tools', 'spurt.group'
  audited_at      TIMESTAMPTZ NOT NULL,
  device          TEXT        NOT NULL CHECK (device IN ('mobile', 'desktop')),
  lighthouse_ver  TEXT,

  -- Scores Lighthouse (0–100)
  score_performance   SMALLINT CHECK (score_performance   BETWEEN 0 AND 100),
  score_accessibility SMALLINT CHECK (score_accessibility BETWEEN 0 AND 100),
  score_best_practices SMALLINT CHECK (score_best_practices BETWEEN 0 AND 100),
  score_seo           SMALLINT CHECK (score_seo           BETWEEN 0 AND 100),
  score_pwa           SMALLINT CHECK (score_pwa           BETWEEN 0 AND 100),

  -- Core Web Vitals (valeurs brutes)
  lcp_ms          NUMERIC(10,2),
  tbt_ms          NUMERIC(10,2),
  cls_value       NUMERIC(6,4),
  fcp_ms          NUMERIC(10,2),
  si_ms           NUMERIC(10,2),
  tti_ms          NUMERIC(10,2),

  -- Statuts CWV : 'good' | 'needs-improvement' | 'poor'
  lcp_status      TEXT,
  tbt_status      TEXT,
  cls_status      TEXT,

  -- Écart à la cible
  gap_to_target   SMALLINT GENERATED ALWAYS AS (
    GREATEST(0, 95 - COALESCE(score_performance, 0))
  ) STORED,

  -- Données CrUX (real-user data, peut être NULL si pas de données)
  crux_lcp_category   TEXT,
  crux_cls_category   TEXT,
  crux_fid_category   TEXT,
  crux_inp_category   TEXT,
  crux_overall        TEXT,

  -- Opportunités et diagnostics (JSON brut pour Metabase)
  opportunities   JSONB,   -- top 10 opportunités avec savings_ms
  diagnostics     JSONB,   -- top 8 diagnostics échoués
  pwa_checks      JSONB,   -- état des checks PWA

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── INDEX ─────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_results_run_id    ON audit_results(run_id);
CREATE INDEX IF NOT EXISTS idx_results_url       ON audit_results(url);
CREATE INDEX IF NOT EXISTS idx_results_site      ON audit_results(site_group);
CREATE INDEX IF NOT EXISTS idx_results_device    ON audit_results(device);
CREATE INDEX IF NOT EXISTS idx_results_audited   ON audit_results(audited_at DESC);
CREATE INDEX IF NOT EXISTS idx_results_perf      ON audit_results(score_performance);
CREATE INDEX IF NOT EXISTS idx_results_run_label ON audit_runs(run_label);

-- ─── VUE : DERNIERS SCORES PAR PAGE (pour Metabase) ───────────────────────

CREATE OR REPLACE VIEW latest_scores AS
SELECT DISTINCT ON (url, device)
  r.url,
  r.site_group,
  r.device,
  r.audited_at,
  r.score_performance,
  r.score_accessibility,
  r.score_best_practices,
  r.score_seo,
  r.score_pwa,
  r.lcp_ms,
  r.tbt_ms,
  r.cls_value,
  r.lcp_status,
  r.tbt_status,
  r.cls_status,
  r.gap_to_target,
  r.crux_overall,
  run.run_label
FROM audit_results r
JOIN audit_runs run ON r.run_id = run.id
ORDER BY url, device, audited_at DESC;

-- ─── VUE : PROGRESSION MENSUELLE (pour graphiques Metabase) ───────────────

CREATE OR REPLACE VIEW monthly_progress AS
SELECT
  run.run_label,
  r.site_group,
  r.device,
  run.started_at::DATE                                        AS audit_date,
  ROUND(AVG(r.score_performance))                             AS avg_performance,
  ROUND(AVG(r.score_accessibility))                          AS avg_accessibility,
  ROUND(AVG(r.score_best_practices))                         AS avg_best_practices,
  ROUND(AVG(r.score_seo))                                    AS avg_seo,
  ROUND(AVG(r.lcp_ms))                                       AS avg_lcp_ms,
  ROUND(AVG(r.tbt_ms))                                       AS avg_tbt_ms,
  ROUND(AVG(r.cls_value)::NUMERIC, 4)                        AS avg_cls,
  COUNT(*)                                                    AS pages_audited,
  COUNT(*) FILTER (WHERE r.score_performance >= 95)          AS pages_at_target,
  COUNT(*) FILTER (WHERE r.lcp_status = 'good')              AS pages_lcp_good,
  COUNT(*) FILTER (WHERE r.cls_status  = 'poor')             AS pages_cls_poor
FROM audit_results r
JOIN audit_runs run ON r.run_id = run.id
GROUP BY run.run_label, r.site_group, r.device, run.started_at::DATE
ORDER BY audit_date DESC, r.site_group, r.device;

-- ─── VUE : PAGES CRITIQUES (score < 50 mobile) ────────────────────────────

CREATE OR REPLACE VIEW critical_pages AS
SELECT
  r.url,
  r.site_group,
  r.audited_at,
  r.score_performance,
  r.gap_to_target,
  r.lcp_ms,
  r.tbt_ms,
  r.cls_value,
  r.lcp_status,
  r.tbt_status,
  r.cls_status
FROM latest_scores r
WHERE r.device = 'mobile'
  AND r.score_performance < 50
ORDER BY r.score_performance ASC;

-- ─── VUE : RÉSUMÉ PAR SITE (pour la vue d'ensemble Metabase) ──────────────

CREATE OR REPLACE VIEW site_summary AS
SELECT
  site_group,
  device,
  ROUND(AVG(score_performance))    AS avg_performance,
  ROUND(AVG(score_accessibility))  AS avg_accessibility,
  ROUND(AVG(score_best_practices)) AS avg_best_practices,
  ROUND(AVG(score_seo))            AS avg_seo,
  MIN(score_performance)           AS min_performance,
  MAX(score_performance)           AS max_performance,
  ROUND(AVG(lcp_ms))               AS avg_lcp_ms,
  ROUND(AVG(tbt_ms))               AS avg_tbt_ms,
  COUNT(*)                         AS total_pages,
  COUNT(*) FILTER (WHERE score_performance >= 95) AS pages_at_target,
  MAX(audited_at)                  AS last_audited
FROM latest_scores
GROUP BY site_group, device
ORDER BY site_group, device;
