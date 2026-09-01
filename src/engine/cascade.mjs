// The cascade engine: event at a hub -> exposed dependents -> which are unpriced.
//
// Every candidate produces a verdict, and a rejection is as much output as a
// trade. An agent that only reports what it bought is not legible; one that
// reports what it refused, and why, can be trusted.

import { dailyBars } from "../market/alpaca.mjs";
import { MARKET_PROXY, sectorEtf } from "../market/sectors.mjs";
import { fitFactorModel, residualZ, logReturns, pricedInVerdict } from "../market/residual.mjs";

export const GATES = {
  materialityFloor: 0.05, // 5% of revenue
  dollarVolumeFloor: 2_000_000, // median daily traded value
  estimationBars: 120,
  minEstimationBars: 60,
};

const closes = (bars) => bars.map((b) => b.c);
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Bars for every symbol a cascade needs, in one request. */
export async function loadMarketData(symbols, { start, end, feed = "sip" } = {}) {
  const unique = [...new Set(symbols)].filter(Boolean);
  const bars = await dailyBars(unique, { start, end, feed });
  const missing = unique.filter((s) => !(bars.get(s)?.length > 0));
  return { bars, missing };
}

/** Index of the first bar at or after a timestamp. */
function splitAt(bars, eventAt) {
  const t = new Date(eventAt).toISOString();
  const i = bars.findIndex((b) => b.t >= t);
  return i < 0 ? bars.length : i;
}

/**
 * Score one dependent against one event.
 *
 * Order matters: the cheap structural gates run before market data is touched,
 * so a refusal explains the first reason it failed rather than the last.
 */
export function scoreDependent(edge, { bars, eventAt, direction }) {
  const base = {
    ticker: edge.from,
    hub: edge.to,
    exposure: edge.magnitude,
    relationshipType: edge.relationshipType,
    disclosedAs: edge.disclosedAs,
    fiscalPeriodEnd: edge.fiscalPeriodEnd,
    accession: edge.accession,
    sourceUrl: edge.sourceUrl,
    direction,
  };
  const refuse = (gate, reason) => ({ ...base, tradeable: false, gate, reason });

  if (edge.relationshipType === "unknown")
    return refuse("relationship_type", "edge type is unknown — blocked until adjudicated");

  if (!edge.toPositionable && !edge.fromPositionable)
    return refuse("positionable", "neither endpoint is on a tradeable exchange");

  if (!edge.fromPositionable)
    return refuse("positionable", `${edge.from} is not on a tradeable exchange`);

  if (!(edge.magnitude >= GATES.materialityFloor))
    return refuse(
      "materiality",
      `exposure ${(edge.magnitude * 100).toFixed(1)}% is under the ${(GATES.materialityFloor * 100).toFixed(0)}% floor`
    );

  const assetBars = bars.get(edge.from);
  if (!assetBars?.length) return refuse("market_data", `no bars returned for ${edge.from}`);

  const dollarVolume = median(assetBars.slice(-30).map((b) => b.c * b.v));
  if (!(dollarVolume >= GATES.dollarVolumeFloor))
    return refuse(
      "liquidity",
      `median daily volume $${(dollarVolume / 1e6).toFixed(2)}M is under the $${(GATES.dollarVolumeFloor / 1e6).toFixed(0)}M floor`
    );

  const marketBars = bars.get(MARKET_PROXY);
  if (!marketBars?.length) return refuse("market_data", `no bars for ${MARKET_PROXY}`);

  const { etf } = sectorEtf(edge.fromSic);
  const sectorBars = etf ? bars.get(etf) : null;

  // Align on shared dates so a halted or newly listed name cannot silently
  // shift one series against another.
  const dates = assetBars.map((b) => b.t).filter((t) => marketBars.some((m) => m.t === t));
  const pick = (series) => dates.map((d) => series.find((b) => b.t === d)).filter(Boolean);
  const a = pick(assetBars);
  const m = pick(marketBars);
  const s = sectorBars ? pick(sectorBars) : null;
  if (a.length !== m.length || (s && s.length !== a.length))
    return refuse("market_data", "series could not be aligned on common dates");

  const cut = splitAt(a, eventAt);
  if (cut < GATES.minEstimationBars)
    return refuse("market_data", `only ${cut} bars before the event, need ${GATES.minEstimationBars}`);
  if (cut >= a.length) return refuse("market_data", "no bars after the event yet");

  const estStart = Math.max(0, cut - GATES.estimationBars);
  const model = fitFactorModel({
    asset: logReturns(closes(a.slice(estStart, cut))),
    market: logReturns(closes(m.slice(estStart, cut))),
    sector: s ? logReturns(closes(s.slice(estStart, cut))) : null,
    minObservations: GATES.minEstimationBars,
  });
  if (!model.ok) return refuse("model", model.reason);

  const windowReturn = (series) =>
    Math.log(series[series.length - 1].c / series[cut - 1].c);
  const periods = a.length - cut;

  const scored = residualZ(model, {
    assetReturn: windowReturn(a),
    marketReturn: windowReturn(m),
    sectorReturn: s ? windowReturn(s) : 0,
    periods,
  });
  const verdict = pricedInVerdict(scored.z, direction);

  return {
    ...base,
    tradeable: verdict.tradeable,
    gate: verdict.tradeable ? null : "priced_in",
    reason: verdict.reason,
    state: verdict.state,
    z: scored.z,
    residual: scored.residual,
    expected: scored.expected,
    actual: windowReturn(a),
    periods,
    dollarVolume,
    betaMarket: model.betaMarket,
    betaSector: model.betaSector,
    sectorEtf: etf,
    hasSector: model.hasSector,
  };
}

/**
 * Propagate one event across the graph.
 * `direction` is the sign the thesis predicts for dependents: -1 for bad news
 * at the hub, +1 for good.
 */
export async function runCascade({ graph, hub, eventAt, direction = -1, feed = "sip", headline = null }) {
  const edges = graph.edges.filter((e) => e.to === hub);
  if (!edges.length) {
    return { hub, eventAt, headline, error: `no edges into ${hub} in the graph`, considered: [], positions: [], refusals: [] };
  }

  const sectorEtfs = edges.map((e) => sectorEtf(e.fromSic).etf).filter(Boolean);
  const symbols = [...edges.map((e) => e.from), hub, MARKET_PROXY, ...sectorEtfs];

  const start = new Date(new Date(eventAt).getTime() - 400 * 24 * 3600 * 1000).toISOString();
  const end = new Date().toISOString();
  const { bars, missing } = await loadMarketData(symbols, { start, end, feed });

  const considered = edges
    .map((e) => scoreDependent(e, { bars, eventAt, direction }))
    .sort((a, b) => (b.exposure ?? 0) - (a.exposure ?? 0));

  return {
    hub,
    eventAt,
    headline,
    direction,
    feed,
    missingData: missing,
    considered,
    positions: considered.filter((c) => c.tradeable),
    refusals: considered.filter((c) => !c.tradeable),
  };
}

/**
 * The gates that need no market data — relationship type, positionability and
 * materiality. Used before Alpaca credentials exist, and by the UI to show the
 * shape of a cascade without pretending to know prices it has not fetched.
 */
export function structuralScreen(graph, hub) {
  const edges = graph.edges.filter((e) => e.to === hub);
  return edges
    .map((e) => {
      const base = {
        ticker: e.from,
        hub: e.to,
        exposure: e.magnitude,
        relationshipType: e.relationshipType,
        disclosedAs: e.disclosedAs,
        fiscalPeriodEnd: e.fiscalPeriodEnd,
        accession: e.accession,
        sourceUrl: e.sourceUrl,
        positionable: e.fromPositionable,
      };
      if (e.relationshipType === "unknown")
        return { ...base, state: "refused", gate: "relationship_type", reason: "edge type unknown — blocked until adjudicated" };
      if (!e.fromPositionable)
        return { ...base, state: "refused", gate: "positionable", reason: `${e.from} is not on a tradeable exchange` };
      if (!(e.magnitude >= GATES.materialityFloor))
        return { ...base, state: "refused", gate: "materiality",
          reason: `exposure ${(e.magnitude * 100).toFixed(1)}% is under the ${(GATES.materialityFloor * 100).toFixed(0)}% floor` };
      return { ...base, state: "pending", gate: null, reason: "passes structural gates — awaiting market data for the priced-in check" };
    })
    .sort((a, b) => b.exposure - a.exposure);
}
