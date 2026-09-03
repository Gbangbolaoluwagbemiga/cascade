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
export async function loadMarketData(symbols, { start, end, feed = "sip", timeframe = "1Day" } = {}) {
  const unique = [...new Set(symbols)].filter(Boolean);

  // Bars come back in one batch for speed. If any symbol in the batch is
  // rejected the whole request 400s, so fall back to fetching individually and
  // simply omit whatever cannot be had — a dependent with no data is refused by
  // the market_data gate, which is a legible outcome. Aborting the cascade is
  // not.
  try {
    const bars = await dailyBars(unique, { start, end, feed, timeframe });
    return { bars, missing: unique.filter((s) => !(bars.get(s)?.length > 0)) };
  } catch (err) {
    const bars = new Map();
    const missing = [];
    for (const sym of unique) {
      try {
        const one = await dailyBars([sym], { start, end, feed, timeframe });
        const series = one.get(sym);
        if (series?.length) bars.set(sym, series); else missing.push(sym);
      } catch { missing.push(sym); }
    }
    return { bars, missing, batchError: String(err.message).slice(0, 140) };
  }
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
export function scoreDependent(edge, { bars, eventAt, direction, timeframe = "1Day" }) {
  const base = {
    ticker: edge.from,
    hub: edge.to,
    exposure: edge.magnitude,
    relationshipType: edge.relationshipType,
    typeSource: edge.typeSource ?? "hint",
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

  // Dollar volume must be a daily figure regardless of bar size, or an hourly
  // series would make every name look 7x less liquid than it is.
  const perBar = median(assetBars.slice(-30).map((b) => b.c * b.v));
  const barsPerDay = timeframe === "1Day" ? 1 : timeframe === "1Hour" ? 7 : 1;
  const dollarVolume = perBar * barsPerDay;
  if (!(dollarVolume >= GATES.dollarVolumeFloor))
    return refuse(
      "liquidity",
      `median daily volume $${(dollarVolume / 1e6).toFixed(2)}M is under the $${(GATES.dollarVolumeFloor / 1e6).toFixed(0)}M floor`
    );

  const marketBars = bars.get(MARKET_PROXY);
  if (!marketBars?.length) return refuse("market_data", `no bars for ${MARKET_PROXY}`);

  const { etf } = sectorEtf(edge.fromSic);
  const sectorBars = etf ? bars.get(etf) : null;

  // Align on timestamps present in EVERY series, so a halted name or a sector
  // ETF with a missing bar cannot shift one series against another. Indexing by
  // Map rather than scanning keeps this linear — with hourly bars the quadratic
  // version was both slow and, when the sector series had a gap, silently
  // produced mismatched lengths and refused the name outright.
  const index = (series) => new Map(series.map((b) => [b.t, b]));
  const mIdx = index(marketBars);
  const sIdx = sectorBars ? index(sectorBars) : null;

  const a = [], m = [], s = sIdx ? [] : null;
  for (const bar of assetBars) {
    const mb = mIdx.get(bar.t);
    if (!mb) continue;
    const sb = sIdx ? sIdx.get(bar.t) : null;
    if (sIdx && !sb) continue;
    a.push(bar); m.push(mb); if (sIdx) s.push(sb);
  }
  if (a.length < GATES.minEstimationBars + 1)
    return refuse("market_data", `only ${a.length} bars align across asset, market and sector`);

  const cut = splitAt(a, eventAt);
  if (cut < GATES.minEstimationBars)
    return refuse("market_data", `only ${cut} bars before the event, need ${GATES.minEstimationBars}`);
  if (cut >= a.length)
    return refuse("market_data", `no ${timeframe === "1Day" ? "daily" : "intraday"} bars after the event yet`);

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
    residualSigma: model.residualSigma,
    scale: scored.scale,
    spot: a[a.length - 1].c,
    sectorEtf: etf,
    hasSector: model.hasSector,
  };
}

/**
 * Propagate one event across the graph.
 * `direction` is the sign the thesis predicts for dependents: -1 for bad news
 * at the hub, +1 for good.
 */
export async function runCascade({ graph, hub, eventAt, direction = -1, feed = "sip", headline = null, timeframe = null, withOptions = false }) {
  const edges = graph.edges.filter((e) => e.to === hub);
  if (!edges.length) {
    return { hub, eventAt, headline, error: `no edges into ${hub} in the graph`, considered: [], positions: [], refusals: [] };
  }

  const sectorEtfs = edges.map((e) => sectorEtf(e.fromSic).etf).filter(Boolean);
  const symbols = [...edges.map((e) => e.from), hub, MARKET_PROXY, ...sectorEtfs];

  // A same-day event has no daily bar after it, so a daily model can never see
  // it — and our edge horizon is hours. Recent events are scored on hourly
  // bars; older ones stay daily, where the estimation window is longer.
  const ageDays = (Date.now() - new Date(eventAt).getTime()) / 864e5;
  const tf = timeframe ?? (ageDays <= 3 ? "1Hour" : "1Day");
  const lookbackDays = tf === "1Hour" ? 90 : 400;

  const start = new Date(new Date(eventAt).getTime() - lookbackDays * 24 * 3600 * 1000).toISOString();
  const end = new Date().toISOString();
  const { bars, missing } = await loadMarketData(symbols, { start, end, feed, timeframe: tf });

  const considered = edges
    .map((e) => scoreDependent(e, { bars, eventAt, direction, timeframe: tf }))
    .sort((a, b) => (b.exposure ?? 0) - (a.exposure ?? 0));

  // Attach the contract the agent would actually buy, so the UI shows the real
  // instrument rather than implying a share trade.
  if (withOptions) {
    const { selectContract } = await import("../market/options.mjs");
    const { expectedMove } = await import("./execute.mjs");
    for (const c of considered.filter((x) => x.tradeable)) {
      try {
        const pick = await selectContract({
          underlying: c.ticker, spot: c.spot, direction,
          expectedMove: expectedMove({ ...c, direction }),
        });
        c.option = pick.ok
          ? { ...pick.contract, expectedMovePct: expectedMove({ ...c, direction }) }
          : { unavailable: true, gate: pick.gate, reason: pick.reason };
      } catch (err) {
        c.option = { unavailable: true, gate: "option_data", reason: err.message.slice(0, 120) };
      }
    }
  }

  return {
    hub,
    eventAt,
    headline,
    direction,
    feed,
    timeframe: tf,
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
        typeSource: e.typeSource ?? "hint",
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
