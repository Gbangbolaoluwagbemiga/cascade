// Run one cascade against live market data.
//   node scripts/cascade.mjs WMT "2026-08-21" down "Walmart cuts full-year guidance"

import fs from "node:fs";
import { runCascade } from "../src/engine/cascade.mjs";
import { credentials, probeFeeds } from "../src/market/alpaca.mjs";

const [hub, eventAt, dir = "down", ...rest] = process.argv.slice(2);
if (!hub || !eventAt) {
  console.error('usage: node scripts/cascade.mjs <HUB> <event-date> [down|up] [headline]');
  process.exit(1);
}

const cred = credentials();
if (!cred.ok) {
  console.error(`\n  Cannot run: ${cred.reason}\n`);
  console.error("  The graph and the gates work without keys — see scripts/test-cascade.mjs.");
  console.error("  Only the live priced-in check needs market data.\n");
  process.exit(2);
}

const graph = JSON.parse(fs.readFileSync("data/graph.json", "utf8"));
const direction = dir === "up" ? 1 : -1;
const headline = rest.join(" ") || null;

// Which feed can this key actually read? The docs disagree; the API does not.
const feeds = await probeFeeds();
const feed = feeds.sip?.ok ? "sip" : feeds.iex?.ok ? "iex" : null;
if (!feed) {
  console.error("\n  No usable market data feed:");
  for (const [name, r] of Object.entries(feeds)) console.error(`    ${name}: ${r.reason || "no bars"}`);
  process.exit(3);
}
console.log(`feed: ${feed}${feed === "iex" ? "  (IEX only — thin for small caps)" : "  (consolidated)"}`);

let result;
try {
  result = await runCascade({ graph, hub, eventAt, direction, feed, headline });
} catch (err) {
  console.error(`\n  Cascade failed: ${err.message}\n`);
  if (err.status === 403) console.error("  That is a data-subscription limit, not a bug in the graph.\n");
  process.exit(5);
}

if (result.error) { console.error(`\n  ${result.error}\n`); process.exit(4); }

console.log(`\n=== CASCADE: ${hub} ${direction < 0 ? "▼" : "▲"} ${eventAt.slice(0, 10)} ===`);
if (headline) console.log(`"${headline}"`);
console.log(`${result.considered.length} exposed dependents · ${result.positions.length} tradeable · ${result.refusals.length} refused`);
if (result.missingData.length) console.log(`no data for: ${result.missingData.join(", ")}`);

if (result.positions.length) {
  console.log(`\n--- POSITIONS ---`);
  for (const p of result.positions) {
    console.log(`  ${p.ticker.padEnd(6)} ${(p.exposure * 100).toFixed(1).padStart(5)}% of revenue via ${p.hub}   z=${p.z.toFixed(2)}   ${p.reason}`);
    console.log(`         "${p.disclosedAs}" · FY ${p.fiscalPeriodEnd} · ${p.accession}`);
  }
}

console.log(`\n--- REFUSED ---`);
for (const r of result.refusals) {
  console.log(`  ${r.ticker.padEnd(6)} [${String(r.gate).padEnd(17)}] ${r.reason}`);
}

fs.writeFileSync("data/last-cascade.json", JSON.stringify(result, null, 2));
console.log(`\nwritten -> data/last-cascade.json`);
