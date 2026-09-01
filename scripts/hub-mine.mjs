// Hub-first mining.
//
// Supplier-first mining asks "what does this sector disclose" and lets hubs
// emerge, which bounds a hub's in-degree by how much of its supplier base
// happens to fall in the sample. Hub-first inverts it: name the hub, find every
// filer that mentions it, and count how many actually tag it as a named
// customer concentration.
//
// That is the measurement that says whether named edges are dense enough — the
// earlier in-degree figures were measuring the mining strategy, not the graph.

import fs from "node:fs";
import { getJSON, latestAnnualReport, getFilingCached, tickerMap } from "../src/mining/sec.mjs";
import { extractConcentrationFacts, factsToEdges } from "../src/mining/xbrl.mjs";
import { canonicalise } from "../src/mining/canonical.mjs";

// "Hub|Alias|Alias" — the legal name matters, since filers write "The Home
// Depot" and "Walmart Inc." rather than the colloquial name.
const HUBS = process.argv.slice(2);
if (!HUBS.length) {
  console.error('usage: node scripts/hub-mine.mjs "Walmart" "Amazon" …');
  process.exit(1);
}

const LIMIT = Number(process.env.HUB_LIMIT || 120);
const START = process.env.HUB_START || "2025-03-01";
const END = process.env.HUB_END || "2026-08-13";

// Searching the hub name alone fails: full-text relevance ranks by term
// frequency, so the filings that mention "Target Corporation" most are Target's
// own. Suppliers mention a hub once or twice and rank last, below any result
// budget. Requiring concentration language alongside the name inverts that —
// "Apple Inc." alone returned Apple; "Apple Inc." + "accounted for
// approximately" returns Qorvo, SiTime, Immersion and Globalstar.
const CONCENTRATION_PHRASES = [
  "accounted for approximately",
  "customer concentration",
  "of our net revenue",
  "of our total revenue",
  "of consolidated net sales",
  "of net sales",
];

/** Filers whose recent 10-K names this hub near concentration language. */
async function candidateCiks(hub, aliases = []) {
  const ciks = new Set();
  const names = [hub, ...aliases];

  for (const name of names) {
    for (const phrase of CONCENTRATION_PHRASES) {
      const q = `"${name}" "${phrase}"`;
      for (let from = 0; from < LIMIT; from += 100) {
        const url =
          `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(q)}` +
          `&forms=10-K&startdt=${START}&enddt=${END}&from=${from}`;
        let j;
        try {
          j = await getJSON(url);
        } catch (err) {
          console.error(`  FTS failed [${q}] from=${from}: ${err.message}`);
          break;
        }
        const hits = j?.hits?.hits || [];
        if (!hits.length) break;
        for (const h of hits) for (const c of h._source?.ciks || []) ciks.add(String(Number(c)));
        if (hits.length < 100) break;
      }
    }
  }
  return [...ciks];
}

const cikToTicker = new Map();
for (const [ticker, { cik }] of await tickerMap()) {
  const k = String(Number(cik));
  if (!cikToTicker.has(k)) cikToTicker.set(k, ticker);
}

const report = [];

for (const hub of HUBS) {
  const [primary, ...aliases] = hub.split("|");
  const target = await canonicalise(primary);
  const ciks = await candidateCiks(primary, aliases);
  const tickers = ciks.map((c) => cikToTicker.get(c)).filter(Boolean);

  console.error(`\n[${primary}] -> ${target.ticker || "UNRESOLVED"}  candidates=${ciks.length} listed=${tickers.length}`);

  const dependents = [];
  let checked = 0;

  for (const t of tickers) {
    try {
      const filing = await latestAnnualReport(t);
      if (!filing) continue;
      const x = extractConcentrationFacts(await getFilingCached(filing.url));
      checked++;
      for (const e of factsToEdges(x.facts, { from: t })) {
        const c = await canonicalise(e.counterparty);
        if (target.ticker && c.ticker === target.ticker && c.ticker !== t) {
          dependents.push({
            from: t,
            share: e.magnitude,
            asNamed: e.counterparty,
            fiscalPeriodEnd: e.fiscalPeriodEnd,
            accession: filing.accession,
            sourceUrl: filing.url,
          });
        }
      }
    } catch (err) {
      process.stderr.write(`    ${t} ERROR ${err.message}\n`);
    }
  }

  dependents.sort((a, b) => b.share - a.share);
  report.push({ hub: primary, ticker: target.ticker, positionable: target.positionable ?? false, mentions: ciks.length, checked, dependents });

  console.error(`  checked=${checked}  named dependents=${dependents.length}`);
}

console.log("\n=== HUB-FIRST RESULTS ===\n");
console.log("Hub".padEnd(20) + "ticker".padEnd(9) + "mentions".padStart(9) + "checked".padStart(9) + "in-degree".padStart(11));
for (const r of report) {
  console.log(
    String(r.hub).slice(0, 19).padEnd(20) +
      String(r.ticker || "—").padEnd(9) +
      String(r.mentions).padStart(9) +
      String(r.checked).padStart(9) +
      String(r.dependents.length).padStart(11)
  );
}

for (const r of report) {
  if (!r.dependents.length) continue;
  console.log(`\n--- ${r.hub} (${r.ticker}) — ${r.dependents.length} named dependents ---`);
  for (const d of r.dependents) {
    console.log(`  ${d.from.padEnd(6)} ${(d.share * 100).toFixed(1).padStart(5)}% of revenue   FY ${d.fiscalPeriodEnd}   as "${d.asNamed}"`);
  }
}

fs.mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
fs.writeFileSync(new URL("../data/hubs.json", import.meta.url), JSON.stringify(report, null, 2));
console.log(`\nwritten -> data/hubs.json`);
