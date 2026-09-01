// In-degree distribution over counterparties.
//
// Total edge count does not predict how much cascade the graph can produce.
// Events happen at hubs: a supplier with one named customer contributes nothing
// until that specific customer has news. What predicts capability is how many
// named dependents each hub accumulates.

import fs from "node:fs";

const rows = fs
  .readFileSync(new URL("../data/survey.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const inDegree = new Map(); // counterparty -> [{ ticker, sector }]
for (const r of rows) {
  for (const cp of r.counterparties || []) {
    if (!inDegree.has(cp)) inDegree.set(cp, []);
    inDegree.get(cp).push({ ticker: r.ticker, sector: r.sector });
  }
}

const ranked = [...inDegree.entries()].sort((a, b) => b[1].length - a[1].length);
const degrees = ranked.map(([, v]) => v.length);
const edges = degrees.reduce((a, b) => a + b, 0);

console.log(`counterparties named: ${ranked.length}   named edges: ${edges}`);
console.log(`filers contributing:  ${rows.filter((r) => (r.counterparties || []).length).length} of ${rows.length}`);

const top = ranked.slice(0, 20);
const topAvg = top.reduce((a, [, v]) => a + v.length, 0) / Math.min(10, top.length);
console.log(`\ntop-10 mean in-degree: ${(ranked.slice(0, 10).reduce((a, [, v]) => a + v.length, 0) / 10).toFixed(1)}`);
console.log(`singletons (in-degree 1): ${degrees.filter((d) => d === 1).length} of ${ranked.length} (${((100 * degrees.filter((d) => d === 1).length) / ranked.length).toFixed(0)}%)`);

console.log(`\n--- top counterparties by inbound named edges ---`);
for (const [cp, deps] of top) {
  const sectors = [...new Set(deps.map((d) => d.sector.replace(/^CONTROL: /, "")))];
  console.log(
    `  ${String(deps.length).padStart(3)}  ${cp.slice(0, 34).padEnd(36)} ${deps.map((d) => d.ticker).slice(0, 8).join(",")}` +
      (deps.length > 8 ? ` +${deps.length - 8}` : "") +
      `   [${sectors.length} sector${sectors.length > 1 ? "s" : ""}]`
  );
}

// Hub concentration per sector: does this sector feed existing hubs, or spray?
console.log(`\n--- by sector: edges, distinct counterparties, hub reuse ---`);
const bySector = new Map();
for (const r of rows) {
  if (!bySector.has(r.sector)) bySector.set(r.sector, { edges: 0, cps: new Map(), filers: 0 });
  const g = bySector.get(r.sector);
  const cps = r.counterparties || [];
  if (cps.length) g.filers++;
  for (const cp of cps) {
    g.edges++;
    g.cps.set(cp, (g.cps.get(cp) || 0) + 1);
  }
}
for (const [name, g] of [...bySector.entries()].sort((a, b) => b[1].edges - a[1].edges)) {
  const reused = [...g.cps.values()].filter((v) => v > 1).length;
  console.log(
    `  ${name.slice(0, 29).padEnd(31)} edges=${String(g.edges).padStart(3)}  distinct=${String(g.cps.size).padStart(3)}  reused>=2=${String(reused).padStart(2)}  edges/filer=${(g.edges / (g.filers || 1)).toFixed(1)}`
  );
}
