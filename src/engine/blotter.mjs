// Round-trip accounting.
//
// Alpaca reports open positions and it reports orders, but nothing pairs a
// closing fill back to the opening one — so "what did that trade actually
// make?" has no answer anywhere in the API. This walks the fills per symbol and
// matches them, FIFO, producing closed trades with a realised number.
//
// Shorts open on a sell and close on a buy, so direction is taken from whichever
// side came first rather than assumed.

import { orders as fetchOrders, positions as fetchPositions } from "../market/alpaca.mjs";
import * as ledger from "./ledger.mjs";

const MULTIPLIER = (assetClass) => (assetClass === "us_option" ? 100 : 1);

/** Decode an OCC symbol into something a human reads. */
export function describe(symbol) {
  const m = symbol.match(/^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!m) return { underlying: symbol, label: symbol, isOption: false };
  const [, root, yy, mm, dd, cp, strike] = m;
  return {
    underlying: root,
    isOption: true,
    label: `${root} ${cp === "P" ? "put" : "call"} ${Number(strike) / 1000} ${mm}/${dd}`,
    expiry: `20${yy}-${mm}-${dd}`,
  };
}

export async function blotter() {
  const [raw, open] = await Promise.all([fetchOrders({ status: "all", limit: 200 }), fetchPositions()]);

  const fills = raw
    .filter((o) => o.status === "filled" && Number(o.filled_qty) > 0)
    .map((o) => ({
      symbol: o.symbol,
      assetClass: o.asset_class,
      side: o.side,
      qty: Number(o.filled_qty),
      price: Number(o.filled_avg_price),
      at: o.filled_at ?? o.submitted_at,
    }))
    .sort((a, b) => (a.at < b.at ? -1 : 1));

  // FIFO lots per symbol. A lot opens on the first side seen and closes on the
  // opposite one.
  const lots = new Map();
  const closed = [];

  for (const f of fills) {
    const mult = MULTIPLIER(f.assetClass);
    if (!lots.has(f.symbol)) lots.set(f.symbol, []);
    const queue = lots.get(f.symbol);

    const opposite = queue.length && queue[0].side !== f.side;
    if (!opposite) { queue.push({ ...f, remaining: f.qty }); continue; }

    let toClose = f.qty;
    while (toClose > 0 && queue.length) {
      const lot = queue[0];
      const matched = Math.min(lot.remaining, toClose);
      // Short: opened on a sell, so profit is entry minus exit.
      const short = lot.side === "sell";
      const pl = (short ? lot.price - f.price : f.price - lot.price) * matched * mult;

      closed.push({
        symbol: f.symbol, ...describe(f.symbol),
        direction: short ? "short" : "long",
        qty: matched,
        entryPrice: lot.price, exitPrice: f.price,
        openedAt: lot.at, closedAt: f.at,
        pl: Number(pl.toFixed(2)),
        plPct: Number((((short ? lot.price - f.price : f.price - lot.price) / lot.price) * 100).toFixed(2)),
        assetClass: f.assetClass,
      });

      lot.remaining -= matched;
      toClose -= matched;
      if (lot.remaining <= 0) queue.shift();
    }
    // More closed than was open: the remainder opens a new lot the other way.
    if (toClose > 0) queue.push({ ...f, remaining: toClose });
  }

  const openRows = open.map((p) => {
    const d = describe(p.symbol);
    const thesis = ledger.get(p.symbol) ?? ledger.get(d.underlying);
    return {
      symbol: p.symbol, ...d,
      assetClass: p.asset_class,
      direction: p.side,
      qty: Math.abs(Number(p.qty)),
      entryPrice: Number(p.avg_entry_price),
      currentPrice: Number(p.current_price),
      value: Math.abs(Number(p.market_value)),
      pl: Number(p.unrealized_pl),
      plPct: Number(p.unrealized_plpc) * 100,
      hub: thesis?.hub ?? null,
      exposure: thesis?.exposure ?? null,
      entryZ: thesis?.entryZ ?? null,
      accession: thesis?.accession ?? null,
      openedAt: thesis?.openedAt ?? null,
      // A thesis reconstructed after the fact is weaker evidence than one
      // recorded at order time, and the interface should say so.
      inferred: Boolean(thesis?.inferred),
    };
  });

  const realised = closed.reduce((s, c) => s + c.pl, 0);
  const unrealised = openRows.reduce((s, o) => s + o.pl, 0);

  return {
    closed: closed.sort((a, b) => (a.closedAt < b.closedAt ? 1 : -1)),
    open: openRows.sort((a, b) => b.pl - a.pl),
    totals: {
      realised: Number(realised.toFixed(2)),
      unrealised: Number(unrealised.toFixed(2)),
      closedCount: closed.length,
      openCount: openRows.length,
      wins: closed.filter((c) => c.pl > 0).length,
      losses: closed.filter((c) => c.pl < 0).length,
    },
  };
}
