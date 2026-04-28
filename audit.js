/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║   SPURTX! & SPURT! — Lighthouse Batch Auditor           ║
 * ║   Mobile + Desktop · 6 catégories · CWV · PWA          ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * PRÉREQUIS :
 *   1. Avoir lancé crawler.js → urls-to-audit.txt généré
 *   2. Clé API PageSpeed Insights (gratuite)
 *      → https://console.cloud.google.com → PageSpeed Insights API
 *
 * USAGE :
 *   PSI_API_KEY=VOTRE_CLE node audit.js               → mobile + desktop (défaut)
 *   PSI_API_KEY=VOTRE_CLE node audit.js --max=10      → limiter à 10 URLs
 *   PSI_API_KEY=VOTRE_CLE node audit.js --concurrency=2
 *
 * OUTPUT :
 *   audit-results.json     → résultats complets (mobile + desktop) par URL
 *   audit-results.csv      → import tableur — une ligne mobile, une ligne desktop par URL
 *   audit-summary.md       → rapport consolidé lisible
 *   dashboard-data.json    → données pour le dashboard React
 */

import fetch from "node-fetch";
import fs from "fs";

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const API_KEY     = process.env.PSI_API_KEY;
const STRATEGIES  = ["mobile", "desktop"];   // Les deux en une seule commande
const MAX_URLS    = parseInt(process.argv.find(a => a.startsWith("--max="))?.split("=")[1]) || Infinity;
const CONCURRENCY = parseInt(process.argv.find(a => a.startsWith("--concurrency="))?.split("=")[1]) || 2;
// Délai entre chaque appel API — PSI limite à ~400 req/100s
// Avec 2 stratégies × N URLs, on espace bien pour éviter le rate limit
const DELAY_MS    = 1800;

const CATEGORIES = ["performance", "accessibility", "best-practices", "seo", "pwa"];

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const C = {
  reset:"\x1b[0m", bright:"\x1b[1m", dim:"\x1b[2m",
  green:"\x1b[32m", yellow:"\x1b[33m", red:"\x1b[31m",
  cyan:"\x1b[36m", gray:"\x1b[90m", magenta:"\x1b[35m", blue:"\x1b[34m",
};
const c      = (col, str) => `${C[col]}${str}${C.reset}`;
const scCol  = s => s >= 90 ? "green" : s >= 70 ? "yellow" : "red";
const scBar  = s => c(scCol(s), "█".repeat(Math.round((s||0)/10)) + "░".repeat(10 - Math.round((s||0)/10)));
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

// ─── PSI API — audit UNE URL pour UNE stratégie ───────────────────────────────

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

    const score  = key => { const s = cats[key]?.score; return s != null ? Math.round(s * 100) : null; };
    const metric = key => ({
      value:   audits[key]?.numericValue ?? null,
      display: audits[key]?.displayValue ?? "—",
      score:   audits[key]?.score        ?? null,
    });

    const cwv = {
      lcp: metric("largest-contentful-paint"),
      tbt: metric("total-blocking-time"),
      cls: metric("cumulative-layout-shift"),
      fcp: metric("first-contentful-paint"),
      si:  metric("speed-index"),
      tti: metric("interactive"),
    };

    const cwvStatus = {
      lcp: cwv.lcp.value  != null ? (cwv.lcp.value < 2500 ? "good" : cwv.lcp.value < 4000 ? "needs-improvement" : "poor") : "unknown",
      tbt: cwv.tbt.value  != null ? (cwv.tbt.value < 200  ? "good" : cwv.tbt.value < 600  ? "needs-improvement" : "poor") : "unknown",
      cls: cwv.cls.value  != null ? (cwv.cls.value < 0.1  ? "good" : cwv.cls.value < 0.25 ? "needs-improvement" : "poor") : "unknown",
    };

    const pwaChecks = {
      httpsRedirect:  audits["redirects-http"]?.score === 1,
      serviceWorker:  audits["service-worker"]?.score === 1,
      webAppManifest: audits["installable-manifest"]?.score === 1,
      maskableIcon:   audits["maskable-icon"]?.score === 1,
      splashScreen:   audits["splash-screen"]?.score === 1,
      themeColor:     audits["themed-omnibox"]?.score === 1,
      offlineSupport: audits["offline-start-url"]?.score === 1,
      viewport:       audits["viewport"]?.score === 1,
    };

    const opportunities = Object.values(audits)
      .filter(a => a.details?.type === "opportunity" && (a.numericValue || 0) > 0)
      .sort((a, b) => (b.numericValue || 0) - (a.numericValue || 0))
      .slice(0, 10)
      .map(a => ({
        id: a.id, title: a.title,
        savingsMs: Math.round(a.numericValue || 0),
        displayValue: a.displayValue || "",
      }));

    const diagnostics = Object.values(audits)
      .filter(a => a.score !== null && a.score < 1 && a.details?.type !== "opportunity")
      .sort((a, b) => (a.score ?? 1) - (b.score ?? 1))
      .slice(0, 8)
      .map(a => ({ id: a.id, title: a.title, score: a.score, displayValue: a.displayValue || "" }));

    const crux = data.loadingExperience?.metrics ? {
      overallCategory: data.loadingExperience.overall_category,
      lcp: data.loadingExperience.metrics.LARGEST_CONTENTFUL_PAINT_MS,
      fid: data.loadingExperience.metrics.FIRST_INPUT_DELAY_MS,
      cls: data.loadingExperience.metrics.CUMULATIVE_LAYOUT_SHIFT_SCORE,
      fcp: data.loadingExperience.metrics.FIRST_CONTENTFUL_PAINT_MS,
      inp: data.loadingExperience.metrics.INTERACTION_TO_NEXT_PAINT,
    } : null;

    return {
      strategy,
      auditDurationMs:   Date.now() - start,
      lighthouseVersion: lhr.lighthouseVersion,
      scores: {
        performance:   score("performance"),
        accessibility: score("accessibility"),
        bestPractices: score("best-practices"),
        seo:           score("seo"),
        pwa:           score("pwa"),
      },
      coreWebVitals: cwv,
      cwvStatus,
      pwaChecks,
      opportunities,
      diagnostics,
      crux,
    };

  } catch (err) {
    return { strategy, error: err.message };
  }
}

// ─── AUDIT UNE URL — mobile + desktop en parallèle ────────────────────────────

async function auditUrl(url) {
  // Lancer mobile et desktop en parallèle pour la même URL
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

// ─── BATCH RUNNER ─────────────────────────────────────────────────────────────

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
      const bar = "█".repeat(Math.floor(pct/5)) + "░".repeat(20 - Math.floor(pct/5));
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

      process.stdout.write(`\r  ${c("gray",`[${bar}] ${pct}% — ${completed}/${urls.length} URLs (×2 stratégies)`)}   `);
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

// ─── RAPPORT MARKDOWN ─────────────────────────────────────────────────────────

function generateMarkdown(results, totalMs) {
  const valid  = results.filter(r => !r.mobile?.error || !r.desktop?.error);
  const failed = results.filter(r => r.mobile?.error && r.desktop?.error);

  const avgStrategy = (strategy, key) => {
    const pages = valid.filter(r => r[strategy]?.scores?.[key] != null);
    return pages.length
      ? Math.round(pages.reduce((s, r) => s + r[strategy].scores[key], 0) / pages.length)
      : "—";
  };

  const avgSiteStrategy = (site, strategy, key) => {
    const pages = valid.filter(r => r.site === site && r[strategy]?.scores?.[key] != null);
    return pages.length
      ? Math.round(pages.reduce((s, r) => s + r[strategy].scores[key], 0) / pages.length)
      : "—";
  };

  const date = new Date().toLocaleDateString("fr-FR", { year:"numeric", month:"long", day:"numeric" });

  let md = `# 🔦 Rapport Lighthouse Consolidé — SpurtX! & Spurt!
> ${date} · ${valid.length} pages · Mobile + Desktop · Cible : **95**

---

## 📊 Scores moyens globaux

| Catégorie | 📱 Mobile | 🖥 Desktop | Cible |
|---|---|---|---|
| ⚡ Performance | **${avgStrategy("mobile","performance")}** | **${avgStrategy("desktop","performance")}** | 95 |
| ♿ Accessibilité | **${avgStrategy("mobile","accessibility")}** | **${avgStrategy("desktop","accessibility")}** | 95 |
| 🔒 Bonnes pratiques | **${avgStrategy("mobile","bestPractices")}** | **${avgStrategy("desktop","bestPractices")}** | 95 |
| 🔍 SEO | **${avgStrategy("mobile","seo")}** | **${avgStrategy("desktop","seo")}** | 95 |
| 📱 PWA | **${avgStrategy("mobile","pwa") || "N/A"}** | **${avgStrategy("desktop","pwa") || "N/A"}** | 95 |

---

## 🏢 Comparaison par site

| Site | Stratégie | Perf | Access. | BP | SEO | PWA |
|---|---|---|---|---|---|---|
| SpurtX! | 📱 Mobile | ${avgSiteStrategy("spurtx.tools","mobile","performance")} | ${avgSiteStrategy("spurtx.tools","mobile","accessibility")} | ${avgSiteStrategy("spurtx.tools","mobile","bestPractices")} | ${avgSiteStrategy("spurtx.tools","mobile","seo")} | ${avgSiteStrategy("spurtx.tools","mobile","pwa")} |
| SpurtX! | 🖥 Desktop | ${avgSiteStrategy("spurtx.tools","desktop","performance")} | ${avgSiteStrategy("spurtx.tools","desktop","accessibility")} | ${avgSiteStrategy("spurtx.tools","desktop","bestPractices")} | ${avgSiteStrategy("spurtx.tools","desktop","seo")} | ${avgSiteStrategy("spurtx.tools","desktop","pwa")} |
| Spurt! | 📱 Mobile | ${avgSiteStrategy("spurt.group","mobile","performance")} | ${avgSiteStrategy("spurt.group","mobile","accessibility")} | ${avgSiteStrategy("spurt.group","mobile","bestPractices")} | ${avgSiteStrategy("spurt.group","mobile","seo")} | ${avgSiteStrategy("spurt.group","mobile","pwa")} |
| Spurt! | 🖥 Desktop | ${avgSiteStrategy("spurt.group","desktop","performance")} | ${avgSiteStrategy("spurt.group","desktop","accessibility")} | ${avgSiteStrategy("spurt.group","desktop","bestPractices")} | ${avgSiteStrategy("spurt.group","desktop","seo")} | ${avgSiteStrategy("spurt.group","desktop","pwa")} |

---

## 📐 Core Web Vitals

### Seuils Google
| Métrique | ✅ Bon | ⚠ À améliorer | 🔴 Mauvais |
|---|---|---|---|
| LCP (affichage contenu) | < 2.5s | < 4s | ≥ 4s |
| TBT ≈ FID (réactivité) | < 200ms | < 600ms | ≥ 600ms |
| CLS (stabilité visuelle) | < 0.1 | < 0.25 | ≥ 0.25 |

`;

  // CWV stats par stratégie
  ["mobile","desktop"].forEach(strategy => {
    const cwvPages = valid.filter(r => r[strategy]?.coreWebVitals?.lcp?.value != null);
    if (cwvPages.length === 0) return;
    const count = (m, status) => cwvPages.filter(r => r[strategy].cwvStatus?.[m] === status).length;
    md += `### ${strategy === "mobile" ? "📱 Mobile" : "🖥 Desktop"}\n\n`;
    md += `| Métrique | ✅ Bon | ⚠ À améliorer | 🔴 Mauvais |\n|---|---|---|---|\n`;
    ["lcp","tbt","cls"].forEach(m => {
      md += `| ${m.toUpperCase()} | ${count(m,"good")} pages | ${count(m,"needs-improvement")} pages | ${count(m,"poor")} pages |\n`;
    });
    md += "\n";
  });

  // Pages sous 95 (mobile performance comme référence principale)
  const below95 = valid
    .filter(r => (r.mobile?.scores?.performance || 0) < 95)
    .sort((a,b) => (a.mobile?.scores?.performance||0) - (b.mobile?.scores?.performance||0));

  md += `---\n\n## 🔴 Pages sous 95 — Performance mobile (${below95.length} pages)\n\n`;
  md += `| Site | Page | 📱 Perf | 🖥 Perf | 📱 LCP | 🖥 LCP | 📱 TBT | CLS |\n|---|---|---|---|---|---|---|---|\n`;
  below95.forEach(r => {
    const ms = r.mobile?.scores || {};
    const ds = r.desktop?.scores || {};
    const mc = r.mobile?.coreWebVitals || {};
    const dc = r.desktop?.coreWebVitals || {};
    md += `| ${r.site} | \`${r.url.replace(/^https?:\/\//,"").slice(0,40)}\` | **${ms.performance??"-"}** | ${ds.performance??"-"} | ${mc.lcp?.display||"-"} | ${dc.lcp?.display||"-"} | ${mc.tbt?.display||"-"} | ${mc.cls?.display||"-"} |\n`;
  });

  // Top opportunités (basé sur mobile, le plus strict)
  md += `\n---\n\n## 🛠 Top opportunités d'amélioration (mobile)\n\n`;
  const oppMap = {};
  valid.forEach(r => {
    (r.mobile?.opportunities || []).forEach(o => {
      if (!oppMap[o.id]) oppMap[o.id] = { title: o.title, count: 0, totalSavings: 0, urls: [] };
      oppMap[o.id].count++;
      oppMap[o.id].totalSavings += o.savingsMs;
      oppMap[o.id].urls.push(r.url);
    });
  });
  Object.entries(oppMap)
    .sort((a,b) => b[1].totalSavings - a[1].totalSavings)
    .slice(0, 12)
    .forEach(([, opp]) => {
      const priority = opp.totalSavings > 5000 ? "🔴 HAUTE" : opp.totalSavings > 2000 ? "🟡 MOYENNE" : "🟢 FAIBLE";
      md += `### ${priority} — ${opp.title}\n`;
      md += `- **Pages concernées** : ${opp.count} / ${valid.length}\n`;
      md += `- **Économie estimée** : ~${fmtMs(opp.totalSavings)}\n`;
      md += `- **Exemples** : ${opp.urls.slice(0,3).map(u => `\`${u.replace(/^https?:\/\//,"")}\``).join(", ")}\n\n`;
    });

  // PWA checklist
  md += `---\n\n## 📱 État PWA\n\n`;
  const pwaLabels = {
    httpsRedirect:"Redirection HTTPS", serviceWorker:"Service Worker",
    webAppManifest:"Web App Manifest", maskableIcon:"Icône maskable",
    splashScreen:"Splash screen", themeColor:"Couleur thème",
    offlineSupport:"Support hors-ligne", viewport:"Meta viewport",
  };
  md += `| Critère | Pages OK (mobile) | Pages OK (desktop) |\n|---|---|---|\n`;
  Object.entries(pwaLabels).forEach(([k, label]) => {
    const mOk = valid.filter(r => r.mobile?.pwaChecks?.[k]).length;
    const dOk = valid.filter(r => r.desktop?.pwaChecks?.[k]).length;
    const mIcon = mOk === valid.length ? "✅" : mOk === 0 ? "❌" : "⚠";
    const dIcon = dOk === valid.length ? "✅" : dOk === 0 ? "❌" : "⚠";
    md += `| ${label} | ${mIcon} ${mOk}/${valid.length} | ${dIcon} ${dOk}/${valid.length} |\n`;
  });

  if (failed.length > 0) {
    md += `\n---\n\n## ⚠ Erreurs (${failed.length})\n\n`;
    failed.forEach(r => md += `- \`${r.url}\`\n`);
  }

  md += `\n---\n*Rapport généré en ${fmtMs(totalMs)} · PageSpeed Insights API · Mobile + Desktop*\n`;
  return md;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n" + c("bright","╔══════════════════════════════════════════════════════════╗"));
  console.log(c("bright",       "║   SpurtX! & Spurt! — Lighthouse Auditor                  ║"));
  console.log(c("bright",       "║   📱 Mobile + 🖥 Desktop · 6 catégories · CWV · PWA      ║"));
  console.log(c("bright",       "╚══════════════════════════════════════════════════════════╝") + "\n");

  if (!API_KEY) {
    console.log(c("yellow","⚠  PSI_API_KEY non définie — limité à ~25 req/heure"));
    console.log(c("gray",  "   → Clé gratuite : https://console.cloud.google.com\n"));
  }

  // Charger les URLs
  let urls = [];
  if (fs.existsSync("urls-to-audit.txt")) {
    urls = fs.readFileSync("urls-to-audit.txt","utf-8")
      .split("\n").map(u => u.trim()).filter(u => u.startsWith("http"));
    const spurtxCount = urls.filter(u => u.includes("spurtx")).length;
    const spurtCount  = urls.filter(u => u.includes("spurt.group")).length;
    console.log(`${c("green","✓")} ${urls.length} URLs chargées`);
    console.log(`  ${c("cyan","⬡")} SpurtX! : ${spurtxCount} pages   ${c("magenta","◆")} Spurt! : ${spurtCount} pages`);
  } else {
    urls = ["https://www.spurtx.tools/", "https://spurt.group/"];
    console.log(c("yellow","⚠  urls-to-audit.txt non trouvé → URLs de base seulement"));
  }

  if (MAX_URLS < Infinity) {
    urls = urls.slice(0, MAX_URLS);
    console.log(c("gray", `  (limité à ${MAX_URLS} URLs via --max)`));
  }

  // Chaque URL = 2 appels API (mobile + desktop)
  const totalCalls    = urls.length * 2;
  const estimatedMin  = Math.ceil(totalCalls * DELAY_MS / CONCURRENCY / 60000);
  console.log(`\n  Stratégies    : ${c("cyan","📱 mobile")} + ${c("blue","🖥 desktop")} (simultanées par URL)`);
  console.log(`  URLs          : ${urls.length}   Appels API totaux : ${totalCalls}`);
  console.log(`  Concurrence   : ${CONCURRENCY}   Durée estimée : ~${estimatedMin} min\n`);
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

  console.log(`\n${c("bright","📊 RÉSULTATS FINAUX")} — ${valid.length}/${results.length} URLs\n`);
  console.log(`  ${c("dim","Catégorie         ")}  ${c("cyan","📱 Mobile")}   ${c("blue","🖥 Desktop")}`);
  console.log(`  ${"─".repeat(50)}`);
  [
    ["⚡ Performance   ", "performance"],
    ["♿ Accessibilité ", "accessibility"],
    ["🔒 Best Practices", "bestPractices"],
    ["🔍 SEO           ", "seo"],
    ["📱 PWA           ", "pwa"],
  ].forEach(([label, key]) => {
    const m = avgS("mobile",  key);
    const d = avgS("desktop", key);
    console.log(
      `  ${label}  ` +
      `${c(scCol(m), String(m).padStart(3))} ${scBar(m)}  ` +
      `${c(scCol(d), String(d).padStart(3))} ${scBar(d)}`
    );
  });

  // CWV moyens
  const cwvValid = valid.filter(r => r.mobile?.coreWebVitals?.lcp?.value != null);
  if (cwvValid.length > 0) {
    const avg = (s, m) => cwvValid.reduce((acc,r) => acc + (r[s]?.coreWebVitals?.[m]?.value||0), 0) / cwvValid.length;
    const mLcp = Math.round(avg("mobile","lcp")), dLcp = Math.round(avg("desktop","lcp"));
    const mTbt = Math.round(avg("mobile","tbt")), dTbt = Math.round(avg("desktop","tbt"));
    const mCls = avg("mobile","cls").toFixed(3),  dCls = avg("desktop","cls").toFixed(3);
    console.log(`\n  ${c("bright","Core Web Vitals moyens :")}`);
    console.log(`  ${"─".repeat(50)}`);
    console.log(`  LCP  📱 ${c(mLcp<2500?"green":mLcp<4000?"yellow":"red", fmtMs(mLcp))}  🖥 ${c(dLcp<2500?"green":dLcp<4000?"yellow":"red", fmtMs(dLcp))}`);
    console.log(`  TBT  📱 ${c(mTbt<200?"green":mTbt<600?"yellow":"red", fmtMs(mTbt))}  🖥 ${c(dTbt<200?"green":dTbt<600?"yellow":"red", fmtMs(dTbt))}`);
    console.log(`  CLS  📱 ${c(parseFloat(mCls)<0.1?"green":parseFloat(mCls)<0.25?"yellow":"red", mCls)}  🖥 ${c(parseFloat(dCls)<0.1?"green":parseFloat(dCls)<0.25?"yellow":"red", dCls)}`);
  }

  const below95mob = valid.filter(r => (r.mobile?.scores?.performance||0) < 95).length;
  const below95dsk = valid.filter(r => (r.desktop?.scores?.performance||0) < 95).length;
  console.log(`\n  Pages sous 95 : 📱 ${c("red", String(below95mob))} mobile   🖥 ${c("red", String(below95dsk))} desktop\n`);

  // ─── EXPORTS ──────────────────────────────────────────────────────────────

  // JSON complet
  fs.writeFileSync("audit-results.json", JSON.stringify({
    auditedAt:  new Date().toISOString(),
    strategies: STRATEGIES,
    categories: CATEGORIES,
    stats: {
      total:  results.length,
      valid:  valid.length,
      failed: results.filter(r => r.mobile?.error && r.desktop?.error).length,
      avgScores: {
        mobile:  { performance: avgS("mobile","performance"), accessibility: avgS("mobile","accessibility"), bestPractices: avgS("mobile","bestPractices"), seo: avgS("mobile","seo"), pwa: avgS("mobile","pwa") },
        desktop: { performance: avgS("desktop","performance"), accessibility: avgS("desktop","accessibility"), bestPractices: avgS("desktop","bestPractices"), seo: avgS("desktop","seo"), pwa: avgS("desktop","pwa") },
      },
    },
    results,
  }, null, 2));

  // CSV — une ligne par URL×stratégie
  const csvHeaders = "url,site,strategy,performance,accessibility,bestPractices,seo,pwa,lcp_ms,tbt_ms,cls,fcp_ms,lcp_display,tbt_display,cls_display,cwv_lcp,cwv_tbt,cwv_cls";
  const csvRows = [];
  valid.forEach(r => {
    STRATEGIES.forEach(s => {
      const d = r[s];
      if (!d || d.error) return;
      csvRows.push([
        r.url, r.site, s,
        d.scores.performance, d.scores.accessibility, d.scores.bestPractices, d.scores.seo, d.scores.pwa ?? "",
        Math.round(d.coreWebVitals?.lcp?.value || 0),
        Math.round(d.coreWebVitals?.tbt?.value || 0),
        (d.coreWebVitals?.cls?.value || 0).toFixed(3),
        Math.round(d.coreWebVitals?.fcp?.value || 0),
        d.coreWebVitals?.lcp?.display,
        d.coreWebVitals?.tbt?.display,
        d.coreWebVitals?.cls?.display,
        d.cwvStatus?.lcp, d.cwvStatus?.tbt, d.cwvStatus?.cls,
      ].join(","));
    });
  });
  fs.writeFileSync("audit-results.csv", [csvHeaders, ...csvRows].join("\n"));

  // Markdown
  fs.writeFileSync("audit-summary.md", generateMarkdown(results, totalMs));

  // Dashboard data
  const dashboardData = valid.map(r => ({
    id:    r.url.replace(/^https?:\/\//,"").replace(/\//g,"_").slice(0,40),
    label: r.url.replace(/^https?:\/\//,"").slice(0,55),
    url:   r.url,
    site:  r.site,
    // Scores mobile
    performance:   r.mobile?.scores?.performance,
    accessibility: r.mobile?.scores?.accessibility,
    bestPractices: r.mobile?.scores?.bestPractices,
    seo:           r.mobile?.scores?.seo,
    pwa:           r.mobile?.scores?.pwa,
    // Scores desktop séparés
    desktop: {
      performance:   r.desktop?.scores?.performance,
      accessibility: r.desktop?.scores?.accessibility,
      bestPractices: r.desktop?.scores?.bestPractices,
      seo:           r.desktop?.scores?.seo,
      pwa:           r.desktop?.scores?.pwa,
    },
    // CWV mobile (référence principale)
    lcp: r.mobile?.coreWebVitals?.lcp?.display,
    tbt: r.mobile?.coreWebVitals?.tbt?.display,
    cls: r.mobile?.coreWebVitals?.cls?.display,
    fcp: r.mobile?.coreWebVitals?.fcp?.display,
    cwvStatus: r.mobile?.cwvStatus,
    // CWV desktop
    desktopCwv: {
      lcp: r.desktop?.coreWebVitals?.lcp?.display,
      tbt: r.desktop?.coreWebVitals?.tbt?.display,
      cls: r.desktop?.coreWebVitals?.cls?.display,
    },
    crux:      r.mobile?.crux,
    auditedAt: r.auditedAt,
    issues: (r.mobile?.opportunities || []).map(o => ({
      priority: o.savingsMs > 500 ? "HIGH" : o.savingsMs > 200 ? "MED" : "LOW",
      type:     o.id,
      fix:      o.title,
      impact:   `+${Math.min(20, Math.round(o.savingsMs / 100))}pts`,
    })),
  }));
  fs.writeFileSync("dashboard-data.json", JSON.stringify(dashboardData, null, 2));

  console.log(`${c("bright","💾 FICHIERS GÉNÉRÉS :")}`);
  console.log(`  ${c("green","✓")} audit-results.json   — mobile + desktop complets`);
  console.log(`  ${c("green","✓")} audit-results.csv    — 2 lignes par URL (mobile + desktop)`);
  console.log(`  ${c("green","✓")} audit-summary.md     — rapport consolidé`);
  console.log(`  ${c("green","✓")} dashboard-data.json  — pour le dashboard React\n`);
}

main().catch(console.error);
