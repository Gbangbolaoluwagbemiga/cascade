// The UI has no build step and no framework, so nothing catches a missing
// function until a click does nothing. This runs the page script against a
// stub DOM and calls every render path with real cascade data.
//
// It exists because optionRow was silently absent for hours: a patch failed to
// apply, detail() threw on every call, and the panel simply stayed empty.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(fileURLToPath(new URL("../", import.meta.url)));
const html = fs.readFileSync(path.join(ROOT, "src/web/public/index.html"), "utf8");
const script = html.split("<script>")[1]?.split("</script>")[0];

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS  ${name}`); }
  catch (err) { failed++; console.log(`FAIL  ${name}\n        ${err.message}`); }
};

const store = {};
const stubEl = () => ({
  set innerHTML(v) { store.out = v; }, get innerHTML() { return store.out ?? ""; },
  set textContent(v) { store.text = v; }, get textContent() { return store.text ?? ""; },
  addEventListener() {}, setAttribute() {}, appendChild() {}, append() {}, style: {},
});
global.document = { getElementById: stubEl, querySelectorAll: () => [], createElementNS: stubEl };
global.fetch = async () => ({ json: async () => ({}) });
global.requestAnimationFrame = () => {};

let api;
check("page script parses and every referenced function exists", () => {
  api = new Function(script + "; return { detail, optionRow, colour, radiusFor, pct };")();
});
if (!api) process.exit(1);

const base = {
  ticker: "STRT", hub: "F", exposure: 0.23, z: -0.76, betaMarket: 0.75, betaSector: 0.1,
  dollarVolume: 7_124_617, periods: 3, relationshipType: "customer", typeSource: "llm",
  fiscalPeriodEnd: "2025-06-29", disclosedAs: "Ford Motor Company",
  accession: "0000950170-25-111218", sourceUrl: "https://sec.gov/x", tradeable: true,
  state: "unpriced", reason: "exposed and unmoved",
};

check("detail() renders and keeps the citation", () => {
  api.detail(base, "F");
  if (!store.out.includes("0000950170-25-111218")) throw new Error("accession missing from the card");
  if (!store.out.includes("23.0%")) throw new Error("exposure missing");
});

check("detail() renders a tradeable option contract", () => {
  api.detail({ ...base, option: { type: "put", symbol: "SWK260918P00095000", strike: 95, expiry: "2026-09-18", daysOut: 16, mid: 1.8, spreadFraction: 0.2, expectedMovePct: 0.06 } }, "F");
  if (!store.out.includes("long put")) throw new Error("contract not rendered");
});

check("detail() explains why there is no option", () => {
  api.detail({ ...base, option: { unavailable: true, gate: "option_chain", reason: "no listed puts" } }, "F");
  if (!store.out.includes("option_chain")) throw new Error("gate not shown");
  if (!store.out.includes("falls back to shares")) throw new Error("fallback not explained");
});

check("detail() survives a candidate with no market data", () => {
  api.detail({ ticker: "X", hub: "F", exposure: 0.1 }, "F");
});

check("colour() maps every state", () => {
  const seen = new Set(["unpriced", "priced", "partial", "contradicted", "refused", "pending"].map((state) => api.colour({ state })));
  if (seen.size < 4) throw new Error(`states collapse to ${seen.size} colours`);
});

check("radiusFor() puts higher exposure closer to the epicentre", () => {
  if (!(api.radiusFor(0.35) < api.radiusFor(0.05))) throw new Error("radius is not inverted with exposure");
});

check("pct() formats a share", () => {
  if (api.pct(0.234) !== "23.4%") throw new Error(`got ${api.pct(0.234)}`);
});

console.log(`\n${failed ? failed + " FAILED" : "all passed"}`);
process.exit(failed ? 1 : 0);
