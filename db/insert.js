/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║   SPURT! — Lighthouse → PostgreSQL Inserter             ║
 * ║   Lit audit-results.json et insère en base              ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * USAGE :
 *   node db/insert.js                          → lit audit-results.json
 *   node db/insert.js --file=mon-fichier.json  → fichier custom
 *   node db/insert.js --label=2026-05          → label manuel
 */

import pg from "pg";
import fs from "fs";
import path from "path";

const { Pool } = pg;

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const DB_CONFIG = {
  host:     process.env.DB_HOST     || "localhost",
  port:     parseInt(process.env.DB_PORT || "5432"),
  database: process.env.DB_NAME     || "lighthouse_monitor",
  user:     process.env.DB_USER     || "lighthouse_user",
  password: process.env.DB_PASSWORD,
  ssl:      process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
};

const FILE_ARG  = process.argv.find(a => a.startsWith("--file="))?.split("=")[1]  || "audit-results.json";
const LABEL_ARG = process.argv.find(a => a.startsWith("--label="))?.split("=")[1];

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const C = {
  reset:"\x1b[0m", bright:"\x1b[1m",
  green:"\x1b[32m", yellow:"\x1b[33m", red:"\x1b[31m",
  cyan:"\x1b[36m", gray:"\x1b[90m",
};
const c = (col, str) => `${C[col]}${str}${C.reset}`;

// Génère un label depuis la date si non fourni : "2026-05"
function makeRunLabel() {
  if (LABEL_ARG) return LABEL_ARG;
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

// ─── INSERTION ────────────────────────────────────────────────────────────────

async function insertResults(pool, runId, results) {
  let inserted = 0;
  let skipped  = 0;

  for (const page of results) {
    const { url, site, auditedAt, mobile, desktop } = page;

    for (const [device, data] of [["mobile", mobile], ["desktop", desktop]]) {
      if (!data || data.error) {
        skipped++;
        continue;
      }

      const cwv  = data.coreWebVitals  || {};
      const crux = data.crux           || {};

      await pool.query(`
        INSERT INTO audit_results (
          run_id, url, site_group, audited_at, device, lighthouse_ver,
          score_performance, score_accessibility, score_best_practices, score_seo, score_pwa,
          lcp_ms, tbt_ms, cls_value, fcp_ms, si_ms, tti_ms,
          lcp_status, tbt_status, cls_status,
          crux_lcp_category, crux_cls_category, crux_fid_category,
          crux_inp_category, crux_overall,
          opportunities, diagnostics, pwa_checks
        ) VALUES (
          $1,  $2,  $3,  $4,  $5,  $6,
          $7,  $8,  $9,  $10, $11,
          $12, $13, $14, $15, $16, $17,
          $18, $19, $20,
          $21, $22, $23, $24, $25,
          $26, $27, $28
        )
      `, [
        runId, url, site || "unknown", auditedAt, device,
        data.lighthouseVersion || null,

        data.scores?.performance   ?? null,
        data.scores?.accessibility ?? null,
        data.scores?.bestPractices ?? null,
        data.scores?.seo           ?? null,
        data.scores?.pwa           ?? null,

        cwv.lcp?.value != null ? Math.round(cwv.lcp.value) : null,
        cwv.tbt?.value != null ? Math.round(cwv.tbt.value) : null,
        cwv.cls?.value != null ? parseFloat(cwv.cls.value.toFixed(4)) : null,
        cwv.fcp?.value != null ? Math.round(cwv.fcp.value) : null,
        cwv.si?.value  != null ? Math.round(cwv.si.value)  : null,
        cwv.tti?.value != null ? Math.round(cwv.tti.value) : null,

        data.cwvStatus?.lcp || null,
        data.cwvStatus?.tbt || null,
        data.cwvStatus?.cls || null,

        crux.lcp?.category || null,
        crux.cls?.category || null,
        crux.fid?.category || null,
        crux.inp?.category || null,
        crux.overallCategory || null,

        JSON.stringify(data.opportunities || []),
        JSON.stringify(data.diagnostics   || []),
        JSON.stringify(data.pwaChecks     || {}),
      ]);

      inserted++;
    }
  }

  return { inserted, skipped };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n" + c("bright", "╔══════════════════════════════════════════════════════════╗"));
  console.log(c("bright",        "║   Spurt! Lighthouse → PostgreSQL Inserter               ║"));
  console.log(c("bright",        "╚══════════════════════════════════════════════════════════╝") + "\n");

  // 1. Vérifier que le fichier JSON existe
  const filePath = path.resolve(FILE_ARG);
  if (!fs.existsSync(filePath)) {
    console.error(c("red", `✗ Fichier introuvable : ${filePath}`));
    console.error(c("gray", "  → Lance d'abord : PSI_API_KEY=xxx node audit.js"));
    process.exit(1);
  }

  // 2. Vérifier que le mot de passe DB est défini
  if (!DB_CONFIG.password) {
    console.error(c("red", "✗ DB_PASSWORD non défini — export DB_PASSWORD=xxx"));
    process.exit(1);
  }

  // 3. Lire le fichier JSON
  let auditData;
  try {
    auditData = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (e) {
    console.error(c("red", `✗ Impossible de lire ${filePath} : ${e.message}`));
    process.exit(1);
  }

  const results = auditData.results || [];
  console.log(`${c("green", "✓")} Fichier chargé : ${c("cyan", filePath)}`);
  console.log(`  ${results.length} pages à insérer\n`);

  // 4. Connexion PostgreSQL
  const pool = new Pool(DB_CONFIG);
  try {
    await pool.query("SELECT 1");
    console.log(`${c("green", "✓")} Connexion PostgreSQL OK → ${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}\n`);
  } catch (e) {
    console.error(c("red", `✗ Connexion PostgreSQL échouée : ${e.message}`));
    console.error(c("gray", "  Vérifier : DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD"));
    process.exit(1);
  }

  // 5. Créer un audit_run
  const runLabel = makeRunLabel();
  const triggeredBy = process.env.GITHUB_ACTIONS ? "github-actions" : "manual";

  const { rows } = await pool.query(`
    INSERT INTO audit_runs (run_label, triggered_by, started_at, total_urls)
    VALUES ($1, $2, $3, $4)
    RETURNING id
  `, [runLabel, triggeredBy, auditData.auditedAt || new Date().toISOString(), results.length]);

  const runId = rows[0].id;
  console.log(`${c("green", "✓")} Audit run créé`);
  console.log(`  Label    : ${c("cyan", runLabel)}`);
  console.log(`  Run ID   : ${c("gray", runId)}`);
  console.log(`  Déclenché par : ${triggeredBy}\n`);

  // 6. Insérer les résultats
  console.log(c("gray", "─".repeat(60)));
  console.log("Insertion en cours...\n");

  const startTime = Date.now();
  const { inserted, skipped } = await insertResults(pool, runId, results);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // 7. Mettre à jour le audit_run avec les stats finales
  await pool.query(`
    UPDATE audit_runs
    SET completed_at = NOW(), successful = $1, failed = $2
    WHERE id = $3
  `, [inserted, skipped, runId]);

  console.log(c("gray", "─".repeat(60)));
  console.log(`\n${c("bright", "✅ INSERTION TERMINÉE")} (${elapsed}s)\n`);
  console.log(`  ${c("green", "✓")} Insérés  : ${c("bright", String(inserted))} lignes`);
  if (skipped > 0) {
    console.log(`  ${c("yellow", "⚠")} Ignorés  : ${skipped} (erreurs d'audit)`);
  }
  console.log(`  Run ID   : ${c("gray", runId)}\n`);

  await pool.end();
}

main().catch(err => {
  console.error(c("red", `\n✗ Erreur fatale : ${err.message}`));
  process.exit(1);
});
