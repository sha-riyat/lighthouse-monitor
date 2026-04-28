/**
 * ┌────────────────────────────────────────────────────────────┐
 * │ SPURTX! & SPURT! — Lighthouse Batch Auditor (simplified)  │
 * │ Mobile + Desktop · essential metrics · no PWA / CruX      │
 * └────────────────────────────────────────────────────────────┘
 *
 * PREREQUISITES:
 *   1. Run crawler.js -> generate urls-to-audit.txt
 *   2. Google PageSpeed Insights API key (free)
 *      -> https://console.cloud.google.com
 *
 * USAGE:
 *   PSI_API_KEY=your_key node audit.js               -> mobile + desktop
 *   PSI_API_KEY=your_key node audit.js --max=10      -> limit URLs
 *   PSI_API_KEY=your_key node audit.js --concurrency=2
 *
 * OUTPUT:
 *   audit-results.json     -> complete results (mobile + desktop)
 *   audit-results.csv      -> spreadsheet (one row per URL+strategy)
 *   audit-summary.md       -> readable report
 *   dashboard-data.json    -> for the React dashboard (minimal)
 */

import fetch from "node-fetch";
import fs from "fs";

// --- CONFIGURATION -------------------------------------------------

const API_KEY     = process.env.PSI_API_KEY;
const STRATEGIES  = ["mobile", "desktop"];
const MAX_URLS    = parseInt(process.argv.find(a => a.startsWith("--max="))?.split("=")[1]) || Infinity;
const CONCURRENCY = parseInt(process.argv.find(a => a.startsWith("--concurrency="))?.split("=")[1]) || 2;
const DELAY_MS    = 1800;  // avoid rate limiting (~400 req/100s)

const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"];

// --- HELPERS -------------------------------------------------------

const C = {
  reset:"\x1b[0m", bright:"\x1b[1m", dim:"\x1b[2m",
  green:"\x1b[32m", yellow:"\x1b[33m", red:"\x1b[31m",
  cyan:"\x1b[36m", gray:"\x1b[90m", magenta:"\x1b[35m", blue:"\x1b[34m",
};
const c      = (col, str) => `${C[col]}${str}${C.reset}`;
const scCol  = s => s >= 90 ? "green" : s >= 70 ? "yellow" : "red";
const scBar  = s => c(scCol(s), "#".repeat(Math.round((s||0)/10)) + ".".repeat(10 - Math.round((s||0)/10)));
const fmtMs  = ms => ms < 1000 ? `${ms}ms` : `${(ms/1000).toFixed(1)}s`;
const sleep  = ms => new Promise(r => setTimeout(r, ms));

function getSite(url) {
  try {
    const h = new URL(url).hostname;
    if (h.includes("spurtx")) return "spurtx.tools";
    if (h.includes("spurt"))  return "spurt.group";
    return h;
  } catch { return "unknown"; }
}

// --- PSI API - ONE URL + ONE STRATEGY ----------------------------

async function auditOne(url, strategy) {
  const params = new URLSearchParams({
    url,
    strategy,
    ...(API_KEY ? { key: API_KEY } : {}),
  });
  CATEGORIES.forEach(cat => params.append("category", cat));

  const endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`;
  const start    = Date.now();

  try {
    const res  = await fetch(endpoint);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || "PSI API error");

    const lhr    = data.lighthouseResult;
    const cats   = lhr.categories;
    const audits = lhr.audits;

    const score = key => {
      const s = cats[key]?.score;
      return s !== undefined ? Math.round(s * 100) : null;
    };

    const metric = key => ({
      value:   audits[key]?.numericValue ?? null,
      display: audits[key]?.displayValue ?? "--",
    });

    return {
      strategy,
      auditDurationMs: Date.now() - start,
      lighthouseVersion: lhr.lighthouseVersion,
      scores: {
        performance:   score("performance"),
        accessibility: score("accessibility"),
        bestPractices: score("best-practices"),
        seo:           score("seo"),
      },
      coreWebVitals: {
        lcp: metric("largest-contentful-paint"),
        tbt: metric("total-blocking-time"),
        cls: metric("cumulative-layout-shift"),
        fcp: metric("first-contentful-paint"),
        si:  metric("speed-index"),
        tti: metric("interactive"),
      },
    };
  } catch (err) {
    return { strategy, error: err.message };
  }
}

// --- AUDIT ONE URL (mobile + desktop in parallel) ---------------

async function auditUrl(url) {
  const [mobile, desktop] = await Promise.all([
    auditOne(url, "mobile"),
    auditOne(url, "desktop"),
  ]);
  return {
    url,
    site:      getSite(url),
    auditedAt: new Date().toISOString(),
    mobile,
    desktop,
  };
}

// --- BATCH RUNNER -------------------------------------------------

async function runBatch(urls) {
  const results  = [];
  const startAll = Date.now();
  let completed  = 0;

  async function worker(chunk) {
    for (const url of chunk) {
      const result = await auditUrl(url);
      results.push(result);
      completed++;

      const pct = Math.round((completed / urls.length) * 100);
      const bar = "#".repeat(Math.floor(pct/5)) + ".".repeat(20 - Math.floor(pct/5));
      const m   = result.mobile;
      const d   = result.desktop;
      const siteTag = result.site === "spurtx.tools" ? c("cyan","[SpurtX!]") : c("magenta","[Spurt! ]");

      if (m.error && d.error) {
        console.log(`  ${c("red","[ERR]")} ${url.replace(/^https?:\/\//,"").slice(0,60)}`);
      } else {
        const ms = m.scores || {};
        const ds = d.scores || {};
        console.log(
          `  ${siteTag} ` +
          `${c("dim","mob")} P:${c(scCol(ms.performance||0), String(ms.performance??"-"))} ` +
          `A:${c(scCol(ms.accessibility||0), String(ms.accessibility??"-"))} ` +
          `SEO:${c(scCol(ms.seo||0), String(ms.seo??"-"))} ` +
          `${c("dim","| dsk")} P:${c(scCol(ds.performance||0), String(ds.performance??"-"))} ` +
          `A:${c(scCol(ds.accessibility||0), String(ds.accessibility??"-"))} ` +
          `SEO:${c(scCol(ds.seo||0), String(ds.seo??"-"))} ` +
          `${c("gray", url.replace(/^https?:\/\//,"").slice(0,40))}`
        );
      }

      process.stdout.write(`\r  ${c("gray",`[${bar}] ${pct}% — ${completed}/${urls.length} URLs (x2 strategies)`)}   `);
      await sleep(DELAY_MS);
    }
  }

  const chunkSize = Math.ceil(urls.length / CONCURRENCY);
  const chunks    = Array.from({ length: CONCURRENCY }, (_, i) =>
    urls.slice(i * chunkSize, (i + 1) * chunkSize).filter(Boolean)
  );
  await Promise.all(chunks.map(worker));
  console.log();

  return { results, totalMs: Date.now() - startAll };
}

// --- SIMPLE MARKDOWN REPORT (no emojis) -------------------------

function generateMarkdown(results, totalMs) {
  const valid  = results.filter(r => !r.mobile?.error || !r.desktop?.error);
  const failed = results.filter(r => r.mobile?.error && r.desktop?.error);

  const avgStrategy = (strategy, key) => {
    const pages = valid.filter(r => r[strategy]?.scores?.[key] != null);
    return pages.length
      ? Math.round(pages.reduce((s, r) => s + r[strategy].scores[key], 0) / pages.length)
      : "--";
  };

  const date = new Date().toLocaleDateString("en-GB", { year:"numeric", month:"long", day:"numeric" });

  let md = `# Lighthouse report — SpurtX! & Spurt!
> ${date} · ${valid.length} pages · Mobile + Desktop · Target: 95

---

## Average scores

| Category | [MOBILE] | [DESKTOP] | Target |
|---|---|---|---|
| Performance | **${avgStrategy("mobile","performance")}** | **${avgStrategy("desktop","performance")}** | 95 |
| Accessibility | **${avgStrategy("mobile","accessibility")}** | **${avgStrategy("desktop","accessibility")}** | 95 |
| Best practices | **${avgStrategy("mobile","bestPractices")}** | **${avgStrategy("desktop","bestPractices")}** | 95 |
| SEO | **${avgStrategy("mobile","seo")}** | **${avgStrategy("desktop","seo")}** | 95 |

---

## Per site

| Site | Device | Perf | Access. | BP | SEO |
|---|---|---|---|---|---|
| SpurtX! | Mobile | ${avgStrategy("mobile","performance")} | ${avgStrategy("mobile","accessibility")} | ${avgStrategy("mobile","bestPractices")} | ${avgStrategy("mobile","seo")} |
| SpurtX! | Desktop | ${avgStrategy("desktop","performance")} | ${avgStrategy("desktop","accessibility")} | ${avgStrategy("desktop","bestPractices")} | ${avgStrategy("desktop","seo")} |
| Spurt! | Mobile | ${avgStrategy("mobile","performance")} | ${avgStrategy("mobile","accessibility")} | ${avgStrategy("mobile","bestPractices")} | ${avgStrategy("mobile","seo")} |
| Spurt! | Desktop | ${avgStrategy("desktop","performance")} | ${avgStrategy("desktop","accessibility")} | ${avgStrategy("desktop","bestPractices")} | ${avgStrategy("desktop","seo")} |

---

## Core Web Vitals

| Device | Metric | Average |
|---|---|---|
| Mobile | LCP | ${fmtMs(Math.round(valid.reduce((acc,r)=>acc+(r.mobile?.coreWebVitals?.lcp?.value||0),0)/valid.length))} |
| Mobile | TBT | ${fmtMs(Math.round(valid.reduce((acc,r)=>acc+(r.mobile?.coreWebVitals?.tbt?.value||0),0)/valid.length))} |
| Mobile | CLS | ${valid.reduce((acc,r)=>acc+(r.mobile?.coreWebVitals?.cls?.value||0),0)/valid.length} |
| Desktop | LCP | ${fmtMs(Math.round(valid.reduce((acc,r)=>acc+(r.desktop?.coreWebVitals?.lcp?.value||0),0)/valid.length))} |
| Desktop | TBT | ${fmtMs(Math.round(valid.reduce((acc,r)=>acc+(r.desktop?.coreWebVitals?.tbt?.value||0),0)/valid.length))} |
| Desktop | CLS | ${valid.reduce((acc,r)=>acc+(r.desktop?.coreWebVitals?.cls?.value||0),0)/valid.length} |

---

## Pages below 95 (mobile performance)

${valid.filter(r => (r.mobile?.scores?.performance||0) < 95).length} pages:

| Page | Mobile Perf | Desktop Perf | Mobile LCP | Mobile TBT | Mobile CLS |
|---|---|---|---|---|---|
${valid.filter(r=>(r.mobile?.scores?.performance||0)<95).map(r=>`| \`${r.url.replace(/^https?:\/\//,"")}\` | ${r.mobile.scores.performance} | ${r.desktop.scores.performance} | ${r.mobile.coreWebVitals.lcp.display} | ${r.mobile.coreWebVitals.tbt.display} | ${r.mobile.coreWebVitals.cls.display} |`).join("\n")}

${failed.length ? `\n## Errors (${failed.length})\n${failed.map(r=>`- \`${r.url}\``).join("\n")}` : ""}

---

*Report generated in ${fmtMs(totalMs)} · PageSpeed Insights API · Mobile + Desktop*
`;
  return md;
}

// --- MAIN ---------------------------------------------------------

async function main() {
  console.log("\n" + c("bright","┌────────────────────────────────────────────────────────────┐"));
  console.log(c("bright","│ SpurtX! & Spurt! — Lighthouse Auditor (simplified)            │"));
  console.log(c("bright","│ [MOBILE] + [DESKTOP] · essential metrics                       │"));
  console.log(c("bright","└────────────────────────────────────────────────────────────┘") + "\n");

  if (!API_KEY) {
    console.log(c("yellow","[WARN] PSI_API_KEY not set — limited to ~25 requests/hour"));
    console.log(c("gray","   -> Get a free key: https://console.cloud.google.com\n"));
  }

  // Load URLs
  let urls = [];
  if (fs.existsSync("urls-to-audit.txt")) {
    urls = fs.readFileSync("urls-to-audit.txt","utf-8")
      .split("\n").map(u => u.trim()).filter(u => u.startsWith("http"));
    const spurtxCount = urls.filter(u => u.includes("spurtx")).length;
    const spurtCount  = urls.filter(u => u.includes("spurt.group")).length;
    console.log(`${c("green","[OK]")} ${urls.length} URLs loaded`);
    console.log(`  ${c("cyan","[SpurtX!]")} : ${spurtxCount} pages   ${c("magenta","[Spurt!]")} : ${spurtCount} pages`);
  } else {
    urls = ["https://www.spurtx.tools/", "https://spurt.group/"];
    console.log(c("yellow","[WARN] urls-to-audit.txt not found -> using only base URLs"));
  }

  if (MAX_URLS < Infinity) {
    urls = urls.slice(0, MAX_URLS);
    console.log(c("gray", `  (limited to ${MAX_URLS} URLs via --max)`));
  }

  const totalCalls    = urls.length * 2;
  const estimatedMin  = Math.ceil(totalCalls * DELAY_MS / CONCURRENCY / 60000);
  console.log(`\n  Strategies    : ${c("cyan","[MOBILE]")} + ${c("blue","[DESKTOP]")} (parallel per URL)`);
  console.log(`  URLs          : ${urls.length}   Total API calls : ${totalCalls}`);
  console.log(`  Concurrency   : ${CONCURRENCY}   Estimated time : ~${estimatedMin} min\n`);
  console.log(c("dim","─".repeat(70)));

  const { results, totalMs } = await runBatch(urls);

  console.log("\n" + c("dim","─".repeat(70)));

  const valid = results.filter(r => !r.mobile?.error || !r.desktop?.error);
  const avgS  = (strategy, key) => {
    const pages = valid.filter(r => r[strategy]?.scores?.[key] != null);
    return pages.length
      ? Math.round(pages.reduce((s,r) => s + r[strategy].scores[key], 0) / pages.length)
      : 0;
  };

  console.log(`\n${c("bright","FINAL RESULTS")} — ${valid.length}/${results.length} URLs\n`);
  console.log(`  ${c("dim","Category            ")}  ${c("cyan","[MOBILE]")}   ${c("blue","[DESKTOP]")}`);
  console.log(`  ${"─".repeat(50)}`);
  [
    ["Performance   ", "performance"],
    ["Accessibility ", "accessibility"],
    ["Best Practices", "bestPractices"],
    ["SEO           ", "seo"],
  ].forEach(([label, key]) => {
    const m = avgS("mobile",  key);
    const d = avgS("desktop", key);
    console.log(
      `  ${label}  ` +
      `${c(scCol(m), String(m).padStart(3))} ${scBar(m)}  ` +
      `${c(scCol(d), String(d).padStart(3))} ${scBar(d)}`
    );
  });

  const below95mob = valid.filter(r => (r.mobile?.scores?.performance||0) < 95).length;
  const below95dsk = valid.filter(r => (r.desktop?.scores?.performance||0) < 95).length;
  console.log(`\n  Pages below 95 : [MOBILE] ${c("red", String(below95mob))}   [DESKTOP] ${c("red", String(below95dsk))}\n`);

  // --- EXPORTS -----------------------------------------------------

  // Full JSON
  fs.writeFileSync("audit-results.json", JSON.stringify({
    auditedAt:  new Date().toISOString(),
    strategies: STRATEGIES,
    categories: CATEGORIES,
    stats: {
      total:  results.length,
      valid:  valid.length,
      failed: results.filter(r => r.mobile?.error && r.desktop?.error).length,
      avgScores: {
        mobile:  { performance: avgS("mobile","performance"), accessibility: avgS("mobile","accessibility"), bestPractices: avgS("mobile","bestPractices"), seo: avgS("mobile","seo") },
        desktop: { performance: avgS("desktop","performance"), accessibility: avgS("desktop","accessibility"), bestPractices: avgS("desktop","bestPractices"), seo: avgS("desktop","seo") },
      },
    },
    results,
  }, null, 2));

  // CSV
  const csvHeaders = "url,site,strategy,performance,accessibility,bestPractices,seo,lcp_ms,tbt_ms,cls,fcp_ms,lcp_display,tbt_display,cls_display";
  const csvRows = [];
  valid.forEach(r => {
    STRATEGIES.forEach(s => {
      const d = r[s];
      if (!d || d.error) return;
      csvRows.push([
        r.url, r.site, s,
        d.scores.performance, d.scores.accessibility, d.scores.bestPractices, d.scores.seo,
        Math.round(d.coreWebVitals?.lcp?.value || 0),
        Math.round(d.coreWebVitals?.tbt?.value || 0),
        (d.coreWebVitals?.cls?.value || 0).toFixed(3),
        Math.round(d.coreWebVitals?.fcp?.value || 0),
        d.coreWebVitals?.lcp?.display,
        d.coreWebVitals?.tbt?.display,
        d.coreWebVitals?.cls?.display,
      ].join(","));
    });
  });
  fs.writeFileSync("audit-results.csv", [csvHeaders, ...csvRows].join("\n"));

  // Markdown
  fs.writeFileSync("audit-summary.md", generateMarkdown(results, totalMs));

  // Dashboard data (minimal)
  const dashboardData = valid.map(r => ({
    id:    r.url.replace(/^https?:\/\//,"").replace(/\//g,"_").slice(0,40),
    label: r.url.replace(/^https?:\/\//,"").slice(0,55),
    url:   r.url,
    site:  r.site,
    performance:   r.mobile?.scores?.performance,
    accessibility: r.mobile?.scores?.accessibility,
    bestPractices: r.mobile?.scores?.bestPractices,
    seo:           r.mobile?.scores?.seo,
    desktop: {
      performance:   r.desktop?.scores?.performance,
      accessibility: r.desktop?.scores?.accessibility,
      bestPractices: r.desktop?.scores?.bestPractices,
      seo:           r.desktop?.scores?.seo,
    },
    lcp: r.mobile?.coreWebVitals?.lcp?.display,
    tbt: r.mobile?.coreWebVitals?.tbt?.display,
    cls: r.mobile?.coreWebVitals?.cls?.display,
    fcp: r.mobile?.coreWebVitals?.fcp?.display,
    desktopCwv: {
      lcp: r.desktop?.coreWebVitals?.lcp?.display,
      tbt: r.desktop?.coreWebVitals?.tbt?.display,
      cls: r.desktop?.coreWebVitals?.cls?.display,
    },
    auditedAt: r.auditedAt,
  }));
  fs.writeFileSync("dashboard-data.json", JSON.stringify(dashboardData, null, 2));

  console.log(`${c("bright","FILES GENERATED:")}`);
  console.log(`  ${c("green","[OK]")} audit-results.json   — complete mobile+desktop`);
  console.log(`  ${c("green","[OK]")} audit-results.csv    — 2 rows per URL`);
  console.log(`  ${c("green","[OK]")} audit-summary.md     — consolidated report`);
  console.log(`  ${c("green","[OK]")} dashboard-data.json  — for React dashboard\n`);
}

main().catch(console.error);