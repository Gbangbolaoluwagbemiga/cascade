// Close every open position now. Used to convert a floating book into a
// realised number before a deadline, or to reset.
//   node scripts/flatten.mjs            # dry run
//   node scripts/flatten.mjs --live     # actually closes

import { positions, closePosition, account } from "../src/market/alpaca.mjs";
import * as ledger from "../src/engine/ledger.mjs";

const live = process.argv.includes("--live");
const optionsOnly = process.argv.includes("--options");
const all = await positions();
const held = optionsOnly ? all.filter((p) => p.asset_class === "us_option") : all;
if (optionsOnly) console.log(`options only — ${held.length} of ${all.length} positions\n`);
const a = await account();

if (!held.length) { console.log("no open positions"); process.exit(0); }

const total = held.reduce((s, p) => s + Number(p.unrealized_pl), 0);
console.log(`equity $${Number(a.equity).toLocaleString()} · ${held.length} positions · unrealised $${total.toFixed(2)}\n`);

for (const p of held) {
  const line = `  ${p.symbol.padEnd(22)} ${p.asset_class.padEnd(10)} qty ${String(p.qty).padStart(6)}  P/L $${Number(p.unrealized_pl).toFixed(2).padStart(9)}`;
  if (!live) { console.log(line + "  (dry run)"); continue; }
  try {
    await closePosition(p.symbol);
    ledger.forget(p.symbol);
    console.log(line + "  CLOSED");
  } catch (err) {
    console.log(line + `  FAILED — ${err.message.slice(0, 80)}`);
  }
}
console.log(live ? "\nclosed — P/L is now realised" : "\ndry run. Re-run with --live to close.");
