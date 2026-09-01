// Full agent pass: event -> cascade -> gates -> sizing -> orders.
//   node scripts/trade.mjs HD 2026-08-25 down "headline"        (dry run)
//   node scripts/trade.mjs HD 2026-08-25 down "headline" --live  (submits)

import fs from "node:fs";
import { runCascade } from "../src/engine/cascade.mjs";
import { sizePositions, execute, SIZING } from "../src/engine/execute.mjs";
import { account, credentials } from "../src/market/alpaca.mjs";

const args = process.argv.slice(2);
const live = args.includes("--live");
const [hub, eventAt, dir = "down", ...rest] = args.filter((a) => a !== "--live");
const headline = rest.join(" ") || null;

if (!hub || !eventAt) { console.error("usage: node scripts/trade.mjs <HUB> <date> [down|up] [headline] [--live]"); process.exit(1); }
const cred = credentials();
if (!cred.ok) { console.error(`\n  ${cred.reason}\n`); process.exit(2); }

const graph = JSON.parse(fs.readFileSync("data/graph.json", "utf8"));
const direction = dir === "up" ? 1 : -1;

let acct, result;
try {
  acct = await account();
  result = await runCascade({ graph, hub, eventAt, direction, feed: "sip", headline });
} catch (err) {
  console.error(`\n  Failed: ${err.message}\n`);
  process.exit(3);
}
if (result.error) { console.error(`\n  ${result.error}\n`); process.exit(4); }

const equity = Number(acct.equity);
const sized = sizePositions(result.positions.map((p) => ({ ...p, direction })), equity);

console.log(`\n=== ${hub} ${direction < 0 ? "▼" : "▲"} ${eventAt.slice(0, 10)} ===`);
if (headline) console.log(`"${headline}"`);
console.log(`equity $${equity.toLocaleString()} · risk budget ${SIZING.portfolioRisk * 100}% · cap ${SIZING.maxPerPosition * 100}%/name`);
console.log(`${result.considered.length} exposed · ${result.positions.length} passed gates · ${sized.length} sized\n`);

console.log(`${"ticker".padEnd(8)}${"exposure".padStart(9)}${"z".padStart(8)}${"conf".padStart(7)}${"notional".padStart(11)}   thesis`);
for (const s of sized) {
  console.log(
    s.ticker.padEnd(8) +
    `${(s.exposure * 100).toFixed(1)}%`.padStart(9) +
    s.z.toFixed(2).padStart(8) +
    s.confidence.toFixed(2).padStart(7) +
    `$${s.notional.toLocaleString()}`.padStart(11) +
    `   ${hub} ${direction < 0 ? "▼" : "▲"} → ${s.ticker} ${(s.exposure * 100).toFixed(0)}% exposed, unmoved`
  );
}

const orders = await execute(sized, { direction, dryRun: !live });
console.log(`\n--- ORDERS (${live ? "LIVE — submitted to Alpaca paper" : "dry run"}) ---`);
for (const o of orders) {
  if (o.instrument === "option") {
    console.log(
      `  OPTION ${o.ticker.padEnd(6)} ${o.contracts}x ${o.contract}  strike ${o.strike} exp ${o.expiry} (${o.daysToExpiry}d)` +
      `  premium $${o.premium.toFixed(2)}  cost $${o.notional.toLocaleString()}  ${o.status} via ${o.via ?? "rest"}${o.error ? " — " + o.error.slice(0, 60) : ""}`
    );
    console.log(`         thesis expects ${(o.expectedMovePct * 100).toFixed(1)}% further move from $${o.spot?.toFixed(2)}`);
  } else {
    console.log(
      `  SHARE  ${o.ticker.padEnd(6)} ${o.side.toUpperCase()} ${o.shares ? String(o.shares) + " sh @ $" + o.price.toFixed(2) : "$" + o.notional.toLocaleString()}` +
      `  ${o.status} via ${o.via ?? "rest"}${o.error ? " — " + o.error.slice(0, 60) : ""}`
    );
    if (o.optionNote) console.log(`         no option: ${o.optionNote.slice(0, 96)}`);
  }
}

console.log(`\n--- REFUSED (${result.refusals.length}) ---`);
for (const r of result.refusals) console.log(`  ${r.ticker.padEnd(6)} [${String(r.gate).padEnd(17)}] ${r.reason}`);

fs.writeFileSync("data/last-trade.json", JSON.stringify({ hub, eventAt, headline, direction, equity, sized, orders, refusals: result.refusals }, null, 2));
