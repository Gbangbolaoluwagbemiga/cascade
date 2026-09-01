// Engine test with synthetic bars — no Alpaca credentials needed.
//
// Proves the gates fire and that a refusal names the first gate it failed,
// not the last. Each dependent below is constructed to fail a different gate.

import { scoreDependent, GATES } from "../src/engine/cascade.mjs";

const DAYS = 200;
const EVENT_INDEX = 197; // a 3-day event window; a long window dilutes any shock
const eventAt = new Date(Date.UTC(2026, 0, 1) + EVENT_INDEX * 86400000).toISOString();

let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

/** Bars whose post-event drift is a controlled multiple of daily noise. */
function series({ beta = 1.0, vol = 0.012, shockSigmas = 0, price = 50, volume = 5_000_000 }, marketRets) {
  const bars = [];
  let p = price;
  for (let i = 0; i < DAYS; i++) {
    // Idiosyncratic noise only during the estimation window. After the event the
    // series is pure beta plus the deliberate shock, so the test measures the
    // shock rather than whatever the random walk happened to do.
    const idio = i < EVENT_INDEX ? (rnd() - 0.5) * 2 * vol : 0;
    let r = beta * marketRets[i] + idio;
    if (i === EVENT_INDEX) r += shockSigmas * vol * 0.577; // uniform sd = range/(2*sqrt3)
    p *= Math.exp(r);
    bars.push({ t: new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString(), c: p, v: volume / p });
  }
  return bars;
}

const marketRets = Array.from({ length: DAYS }, () => (rnd() - 0.5) * 0.016);
const bars = new Map();
bars.set("SPY", series({ beta: 1, vol: 0.0001, price: 500 }, marketRets));

const cases = [
  { ticker: "UNMOVED", edge: { magnitude: 0.31, relationshipType: "customer", fromPositionable: true, toPositionable: true },
    bars: series({ shockSigmas: 0 }, marketRets), expect: "unpriced", expectGate: null },
  { ticker: "ALREADY", edge: { magnitude: 0.22, relationshipType: "customer", fromPositionable: true, toPositionable: true },
    bars: series({ shockSigmas: -8 }, marketRets), expect: "priced", expectGate: "priced_in" },
  { ticker: "TINY", edge: { magnitude: 0.02, relationshipType: "customer", fromPositionable: true, toPositionable: true },
    bars: series({}, marketRets), expect: null, expectGate: "materiality" },
  { ticker: "ILLIQUID", edge: { magnitude: 0.4, relationshipType: "customer", fromPositionable: true, toPositionable: true },
    bars: series({ volume: 200_000 }, marketRets), expect: null, expectGate: "liquidity" },
  { ticker: "ANONHUB", edge: { magnitude: 0.5, relationshipType: "unknown", fromPositionable: true, toPositionable: true },
    bars: series({}, marketRets), expect: null, expectGate: "relationship_type" },
  { ticker: "OTCNAME", edge: { magnitude: 0.5, relationshipType: "customer", fromPositionable: false, toPositionable: true },
    bars: series({}, marketRets), expect: null, expectGate: "positionable" },
];

for (const c of cases) bars.set(c.ticker, c.bars);

let failed = 0;
console.log(`gates: materiality>=${GATES.materialityFloor * 100}%  volume>=$${GATES.dollarVolumeFloor / 1e6}M\n`);

for (const c of cases) {
  const edge = { from: c.ticker, to: "HUB", fromSic: null, disclosedAs: "Hub Inc", ...c.edge };
  const v = scoreDependent(edge, { bars, eventAt, direction: -1 });
  const gateOk = (v.gate ?? null) === c.expectGate;
  const stateOk = c.expect === null || v.state === c.expect;
  const pass = gateOk && stateOk;
  if (!pass) failed++;
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${c.ticker.padEnd(9)} gate=${String(v.gate).padEnd(18)} ` +
      `${v.z != null ? `z=${v.z.toFixed(2)} ` : ""}${v.tradeable ? "TRADE" : "refused"}\n        ${v.reason}`
  );
}

console.log(`\n${failed ? failed + " FAILED" : "all passed"}`);
process.exit(failed ? 1 : 0);
