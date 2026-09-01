// Merge every mined source into one canonical graph the daemon and UI consume.
//
// Each edge carries what it needs to be defended on stage: the direction, whose
// revenue the magnitude belongs to, the fiscal period, the accession number and
// a URL to the filing.

import fs from "node:fs";
import { canonicalise, lookupTicker } from "../src/mining/canonical.mjs";
import { relationshipTypeHint } from "../src/mining/xbrl.mjs";
import { latestAnnualReport } from "../src/mining/sec.mjs";

const read = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null);

const edges = new Map(); // `${from}->${to}` -> edge
const addEdge = (e) => {
  const key = `${e.from}->${e.to}`;
  const prev = edges.get(key);
  if (!prev || String(e.fiscalPeriodEnd) > String(prev.fiscalPeriodEnd)) edges.set(key, e);
};

// --- hub-first results -------------------------------------------------------
const hubs = read("data/hubs.json") || [];
for (const h of hubs) {
  if (!h.ticker) continue;
  for (const d of h.dependents || []) {
    addEdge({
      from: d.from,
      to: h.ticker,
      magnitude: d.share,
      magnitudeOf: d.from,
      reverseMagnitude: null,
      relationshipType: relationshipTypeHint(d.asNamed),
      typeSource: "hint",
      disclosedAs: d.asNamed,
      fiscalPeriodEnd: d.fiscalPeriodEnd,
      accession: d.accession,
      sourceUrl: d.sourceUrl,
      origin: "hub-first",
    });
  }
}

// --- supplier-first sector mine ---------------------------------------------
const auto = read("data/graph-auto.json");
for (const e of auto?.edges || []) {
  const c = await canonicalise(e.counterparty);
  if (!c.ticker) continue;
  addEdge({
    from: e.from,
    to: c.ticker,
    magnitude: e.magnitude,
    magnitudeOf: e.from,
    reverseMagnitude: null,
    relationshipType: relationshipTypeHint(e.counterparty),
    typeSource: "hint",
    disclosedAs: e.counterparty,
    fiscalPeriodEnd: e.fiscalPeriodEnd,
    accession: e.accession,
    sourceUrl: e.sourceUrl,
    origin: "sector-mine",
  });
}

// --- annotate both endpoints -------------------------------------------------
const nodes = new Map();
async function node(ticker) {
  if (nodes.has(ticker)) return nodes.get(ticker);
  const info = await lookupTicker(ticker);
  let sic = null;
  try { sic = (await latestAnnualReport(ticker))?.sic ?? null; } catch { /* non-fatal */ }
  const n = {
    ticker,
    company: info.company,
    exchange: info.exchange,
    positionable: info.positionable,
    sic,
    inDegree: 0,
    outDegree: 0,
  };
  nodes.set(ticker, n);
  return n;
}

for (const e of edges.values()) {
  const f = await node(e.from);
  const t = await node(e.to);
  f.outDegree++;
  t.inDegree++;
  e.fromPositionable = f.positionable;
  e.toPositionable = t.positionable;
  e.fromSic = f.sic;
}

const graph = {
  builtAt: new Date().toISOString(),
  edgeCount: edges.size,
  nodeCount: nodes.size,
  edges: [...edges.values()].sort((a, b) => b.magnitude - a.magnitude),
  nodes: [...nodes.values()].sort((a, b) => b.inDegree - a.inDegree),
};

fs.writeFileSync("data/graph.json", JSON.stringify(graph, null, 2));

console.log(`edges: ${graph.edgeCount}   nodes: ${graph.nodeCount}`);
console.log(`\ntop hubs by in-degree:`);
for (const n of graph.nodes.filter((n) => n.inDegree > 0).slice(0, 10)) {
  console.log(`  ${String(n.inDegree).padStart(2)}  ${n.ticker.padEnd(6)} ${String(n.company).slice(0, 34).padEnd(36)} ${n.positionable ? "" : "(unpositionable)"}`);
}
const byType = {};
for (const e of graph.edges) byType[e.relationshipType] = (byType[e.relationshipType] || 0) + 1;
console.log(`\nedges by relationship type:`, byType);
console.log(`\nwritten -> data/graph.json`);
