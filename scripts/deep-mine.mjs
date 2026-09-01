// Full-universe mine of a sector group — no sampling.
//
// The survey's in-degree figure was bounded by sample density: a hub can only
// accumulate inbound edges from filers actually in the sample. This mines every
// listed filer across a group of related SIC codes, so in-degree measures the
// graph rather than the sample.
//
// The question it answers: do the top counterparties accumulate enough named
// dependents to generate cascade, or is this a directory?

import fs from "node:fs";
import { latestAnnualReport, getFilingCached } from "../src/mining/sec.mjs";
import { sectorUniverse } from "../src/mining/universe.mjs";
import { extractConcentrationFacts, factsToEdges, aggregateToSetEdges } from "../src/mining/xbrl.mjs";

const GROUPS = {
  auto: {
    label: "Auto & EV supply chain",
    sics: [3711, 3713, 3714, 3715, 3716, 3751, 3792, 3694, 3465],
  },
  aero: {
    label: "Aerospace & defence supply chain",
    sics: [3721, 3724, 3728, 3760, 3761, 3812],
  },
};

const which = process.argv[2] || "auto";
const group = GROUPS[which];
if (!group) {
  console.error(`unknown group "${which}". options: ${Object.keys(GROUPS).join(", ")}`);
  process.exit(1);
}

const tickers = new Set();
for (const sic of group.sics) {
  try {
    for (const t of await sectorUniverse(sic, { max: 300 })) tickers.add(t);
  } catch (err) {
    console.error(`  SIC ${sic} failed: ${err.message}`);
  }
}
console.error(`[${group.label}] listed filers across ${group.sics.length} SIC codes: ${tickers.size}`);

const edges = [];
const setEdges = [];
const fragility = [];
let mined = 0;
let named = 0;

for (const ticker of tickers) {
  try {
    const filing = await latestAnnualReport(ticker);
    if (!filing) continue;
    const html = await getFilingCached(filing.url);
    const x = extractConcentrationFacts(html);
    mined++;

    const e = factsToEdges(x.facts, { from: ticker }).map((edge) => ({
      ...edge,
      accession: filing.accession,
      sourceUrl: filing.url,
    }));
    if (e.length) named++;
    edges.push(...e);
    setEdges.push(...aggregateToSetEdges(x.aggregate, { from: ticker }));
    if (x.anonymous.length) {
      fragility.push({
        ticker,
        unnamedCounterparties: x.anonymous.length,
        maxUnnamedShare: Math.max(...x.anonymous.map((a) => a.fraction)),
      });
    }
    process.stderr.write(`  ${ticker.padEnd(6)} edges=${e.length} anon=${x.anonymous.length}\n`);
  } catch (err) {
    process.stderr.write(`  ${ticker.padEnd(6)} ERROR ${err.message}\n`);
  }
}

const inDeg = new Map();
for (const e of edges) {
  if (!inDeg.has(e.counterparty)) inDeg.set(e.counterparty, []);
  inDeg.get(e.counterparty).push(e);
}
const ranked = [...inDeg.entries()].sort((a, b) => b[1].length - a[1].length);
const top10 = ranked.slice(0, 10);

console.log(`\n=== ${group.label} — FULL UNIVERSE ===`);
console.log(`filers mined: ${mined}   naming at least one counterparty: ${named} (${((100 * named) / (mined || 1)).toFixed(0)}%)`);
console.log(`named edges: ${edges.length}   distinct counterparties: ${ranked.length}   set-edges: ${setEdges.length}`);
console.log(`fragility nodes (tagged but unnamed): ${fragility.length}`);
console.log(`\ntop-10 mean in-degree: ${(top10.reduce((a, [, v]) => a + v.length, 0) / (top10.length || 1)).toFixed(1)}`);
console.log(`singletons: ${ranked.filter(([, v]) => v.length === 1).length} of ${ranked.length}`);

console.log(`\n--- hubs by inbound named dependents ---`);
for (const [cp, deps] of ranked.slice(0, 18)) {
  const shares = deps.map((d) => `${d.from}:${(d.magnitude * 100).toFixed(0)}%`).join(" ");
  console.log(`  ${String(deps.length).padStart(2)}  ${cp.slice(0, 26).padEnd(28)} ${shares.slice(0, 96)}`);
}

fs.mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
fs.writeFileSync(
  new URL(`../data/graph-${which}.json`, import.meta.url),
  JSON.stringify({ group: group.label, mined, edges, setEdges, fragility }, null, 2)
);
console.log(`\nwritten -> data/graph-${which}.json`);
