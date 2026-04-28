/**
 * ┌────────────────────────────────────────────────────────────┐
 * │ SPURT! Lighthouse -> PostgreSQL Inserter (simplified)     │
 * │ Reads audit-results.json and stores only essential fields │
 * └────────────────────────────────────────────────────────────┘
 *
 * USAGE:
 *   node db/insert.js                          -> uses audit-results.json
 *   node db/insert.js --file=custom.json
 *   node db/insert.js --label=2026-05
 */

import pg from "pg";
import fs from "fs";
import path from "path";

const { Pool } = pg;

// --- CONFIG ------------------------------------------------------

const DB_CONFIG = {
  host:                    process.env.DB_HOST     || "localhost",
  port:                    parseInt(process.env.DB_PORT || "5432"),
  database:                process.env.DB_NAME     || "lighthouse_monitor",
  user:                    process.env.DB_USER     || "lighthouse_user",
  password:                process.env.DB_PASSWORD,
  ssl:                     process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10_000,   // échec rapide si le tunnel n'est pas prêt
  idleTimeoutMillis:       30_000,
  max:                     5,
};

const FILE_ARG  = process.argv.find(a => a.startsWith("--file="))?.split("=")[1]  || "audit-results.json";
const LABEL_ARG = process.argv.find(a => a.startsWith("--label="))?.split("=")[1];

// --- HELPERS -----------------------------------------------------

const C = {
  reset:"\x1b[0m", bright:"\x1b[1m",
  green:"\x1b[32m", yellow:"\x1b[33m", red:"\x1b[31m",
  cyan:"\x1b[36m", gray:"\x1b[90m",
};
const c = (col, str) => `${C[col]}${str}${C.reset}`;

function makeRunLabel() {
  if (LABEL_ARG) return LABEL_ARG;
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

// --- INSERTION ---------------------------------------------------

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

      const cwv = data.coreWebVitals || {};

      await pool.query(`
        INSERT INTO audit_results (
          run_id, url, site_group, audited_at, device, lighthouse_ver,
          performance, accessibility, best_practices, seo,
          lcp_ms, tbt_ms, cls_value, fcp_ms
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      `, [
        runId, url, site || "unknown", auditedAt, device,
        data.lighthouseVersion || null,
        data.scores?.performance   ?? null,
        data.scores?.accessibility ?? null,
        data.scores?.bestPractices ?? null,
        data.scores?.seo           ?? null,
        cwv.lcp?.value != null ? Math.round(cwv.lcp.value) : null,
        cwv.tbt?.value != null ? Math.round(cwv.tbt.value) : null,
        cwv.cls?.value != null ? parseFloat(cwv.cls.value.toFixed(4)) : null,
        cwv.fcp?.value != null ? Math.round(cwv.fcp.value) : null,
      ]);

      inserted++;
    }
  }

  return { inserted, skipped };
}

// --- MAIN --------------------------------------------------------

async function main() {
  console.log("\n" + c("bright","┌────────────────────────────────────────────────────────────┐"));
  console.log(c("bright","│ Spurt! Lighthouse -> PostgreSQL Inserter (simplified)           │"));
  console.log(c("bright","└────────────────────────────────────────────────────────────┘") + "\n");

  const filePath = path.resolve(FILE_ARG);
  if (!fs.existsSync(filePath)) {
    console.error(c("red", `[ERR] File not found: ${filePath}`));
    console.error(c("gray", "  -> Run first: PSI_API_KEY=xxx node audit.js"));
    process.exit(1);
  }

  if (!DB_CONFIG.password) {
    console.error(c("red", "[ERR] DB_PASSWORD not set — export DB_PASSWORD=xxx"));
    process.exit(1);
  }

  let auditData;
  try {
    auditData = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (e) {
    console.error(c("red", `[ERR] Cannot read ${filePath}: ${e.message}`));
    process.exit(1);
  }

  const results = auditData.results || [];
  console.log(`${c("green","[OK]")} Loaded: ${c("cyan", filePath)}`);
  console.log(`  ${results.length} pages to insert\n`);

  const pool = new Pool(DB_CONFIG);

  // Retry jusqu'à 5 fois (utile si le tunnel SSH est lent à s'établir)
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await pool.query("SELECT 1");
      console.log(`${c("green","[OK]")} PostgreSQL connection OK -> ${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}\n`);
      break;
    } catch (e) {
      const isLast = attempt === 5;
      console.warn(c("yellow", `[WARN] Connection attempt ${attempt}/5 failed: ${e.message}`));
      if (isLast) {
        console.error(c("red", "[ERR] Could not connect to PostgreSQL after 5 attempts — is the SSH tunnel up?"));
        await pool.end().catch(() => {});
        process.exit(1);
      }
      // Backoff exponentiel : 2s, 4s, 6s, 8s
      await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }

  const runLabel = makeRunLabel();
  const triggeredBy = process.env.GITHUB_ACTIONS ? "github-actions" : "manual";

  const { rows } = await pool.query(`
    INSERT INTO audit_runs (run_label, triggered_by, started_at, total_urls)
    VALUES ($1, $2, $3, $4)
    RETURNING id
  `, [runLabel, triggeredBy, auditData.auditedAt || new Date().toISOString(), results.length]);

  const runId = rows[0].id;
  console.log(`${c("green","[OK]")} Audit run created`);
  console.log(`  Label    : ${c("cyan", runLabel)}`);
  console.log(`  Run ID   : ${c("gray", runId)}`);
  console.log(`  Trigger  : ${triggeredBy}\n`);

  console.log(c("gray","─".repeat(60)));
  console.log("Inserting...\n");

  const startTime = Date.now();
  const { inserted, skipped } = await insertResults(pool, runId, results);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  await pool.query(`
    UPDATE audit_runs
    SET completed_at = NOW(), successful = $1, failed = $2
    WHERE id = $3
  `, [inserted, skipped, runId]);

  console.log(c("gray","─".repeat(60)));
  console.log(`\n${c("bright","INSERTION COMPLETE")} (${elapsed}s)\n`);
  console.log(`  ${c("green","[OK]")} Inserted : ${c("bright", String(inserted))} rows`);
  if (skipped > 0) console.log(`  ${c("yellow","[WARN]")} Skipped  : ${skipped} (audit errors)`);
  console.log(`  Run ID   : ${c("gray", runId)}\n`);

  await pool.end();
}

main().catch(err => {
  console.error(c("red", `\n[ERR] Fatal error: ${err.message}`));
  process.exit(1);
});