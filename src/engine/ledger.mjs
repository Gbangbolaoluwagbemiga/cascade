// Which thesis opened which position.
//
// Exits were previously reconstructed by searching the graph for any edge whose
// source matched the held ticker — `.find()`, so the FIRST match. JAKK depends
// on both Walmart and Amazon; PBH on both too. The position would then be
// re-scored against whichever edge happened to be first in the file, which may
// be an entirely different event from the one that opened it.
//
// A thesis is not derivable after the fact. It has to be written down when the
// position is taken.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILE = path.join(fileURLToPath(new URL("../../", import.meta.url)), "data/theses.json");

const read = () => { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return {}; } };
const write = (v) => fs.writeFileSync(FILE, JSON.stringify(v, null, 2));

/** Key by the traded symbol — the OCC contract for options, the ticker for shares. */
export function record(order) {
  const all = read();
  const key = order.instrument === "option" ? order.contract : order.ticker;
  if (!key) return;
  all[key] = {
    symbol: key,
    underlying: order.ticker,
    instrument: order.instrument ?? "share",
    hub: order.hub,
    direction: order.direction ?? -1,
    exposure: order.exposure,
    entryZ: order.z,
    relationshipType: order.relationshipType,
    headline: order.headline ?? null,
    accession: order.accession ?? null,
    strike: order.strike ?? null,
    expiry: order.expiry ?? null,
    openedAt: new Date().toISOString(),
  };
  write(all);
}

export function get(symbol) {
  return read()[symbol] ?? null;
}

export function all() {
  return Object.values(read());
}

export function forget(symbol) {
  const v = read();
  delete v[symbol];
  write(v);
}

/**
 * Best-effort thesis for a position opened before the ledger existed, or by
 * hand. Picks the LARGEST exposure rather than the first match, and marks the
 * result inferred so a caller can treat it with less confidence.
 */
export function inferFromGraph(graph, symbol, underlying) {
  const edges = graph.edges.filter((e) => e.from === (underlying ?? symbol));
  if (!edges.length) return null;
  const best = edges.reduce((a, b) => (b.magnitude > a.magnitude ? b : a));
  return {
    symbol, underlying: underlying ?? symbol, instrument: "share",
    hub: best.to, direction: -1, exposure: best.magnitude,
    relationshipType: best.relationshipType, accession: best.accession,
    inferred: true,
  };
}
