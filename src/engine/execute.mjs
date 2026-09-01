// Position sizing and execution.
//
// Size = exposure x confidence, where confidence falls as the residual creeps
// toward "already priced". A name that is 34% exposed and utterly unmoved earns
// a bigger position than one 9% exposed and half-priced already.

import { submitOrder, positions as openPositions, closePosition, dailyBars, latestPrices } from "../market/alpaca.mjs";
import { UNPRICED_MAX_Z } from "../market/residual.mjs";

export const SIZING = {
  portfolioRisk: 0.25,   // never deploy more than a quarter of equity per cascade
  maxPerPosition: 0.05,  // and never more than 5% in one name
  minNotional: 200,      // below this the fill is not worth the slippage
};

/**
 * Confidence in [0,1]: full when the residual is flat, decaying to zero as it
 * approaches the unpriced threshold. Beyond that the gate has already refused.
 */
export function confidence(candidate) {
  const aligned = candidate.z * Math.sign(candidate.direction || -1);
  const room = Math.max(0, UNPRICED_MAX_Z - Math.abs(aligned)) / UNPRICED_MAX_Z;
  return Math.max(0, Math.min(1, room));
}

export function sizePositions(candidates, equity) {
  const scored = candidates.map((c) => ({ ...c, confidence: confidence(c) }));
  const weightOf = (c) => c.exposure * c.confidence;
  const total = scored.reduce((a, c) => a + weightOf(c), 0);
  if (!(total > 0)) return [];

  const budget = equity * SIZING.portfolioRisk;
  return scored
    .map((c) => {
      const share = weightOf(c) / total;
      const notional = Math.min(budget * share, equity * SIZING.maxPerPosition);
      return { ...c, weight: share, notional: Math.round(notional * 100) / 100 };
    })
    .filter((c) => c.notional >= SIZING.minNotional);
}

/**
 * Place the orders. `dryRun` is the default: nothing reaches the broker unless
 * the caller explicitly asks, because an accidental live submission is not the
 * kind of mistake you can take back.
 */
export async function execute(sized, { direction = -1, dryRun = true } = {}) {
  const side = direction < 0 ? "sell" : "buy";
  const results = [];

  // Alpaca rejects fractional quantities on a short sale, and a notional order
  // implies a fraction. Shorts therefore have to be expressed in whole shares,
  // which needs a price — so sizing in dollars is converted here rather than
  // leaving the caller to discover the rule from a 422.
  const prices = side === "sell" ? await latestPrices(sized.map((c) => c.ticker)) : new Map();

  for (const c of sized) {
    const order = {
      symbol: c.ticker,
      side,
      type: "market",
      time_in_force: "day",
      client_order_id: `cascade-${c.hub}-${c.ticker}-${Date.now()}`.slice(0, 48),
    };

    if (side === "sell") {
      const price = prices.get(c.ticker);
      if (!price) { results.push({ ...c, side, status: "skipped", error: "no price to convert notional to whole shares" }); continue; }
      const qty = Math.floor(c.notional / price);
      if (qty < 1) { results.push({ ...c, side, status: "skipped", error: `notional $${c.notional} is under one share at $${price.toFixed(2)}` }); continue; }
      order.qty = String(qty);
      c.shares = qty;
      c.price = price;
    } else {
      order.notional = c.notional;
    }

    if (dryRun) {
      results.push({ ...c, side, status: "dry-run", order });
      continue;
    }
    try {
      const filled = await submitOrder(order);
      results.push({ ...c, side, status: filled.status, orderId: filled.id, submittedAt: filled.submitted_at });
    } catch (err) {
      // A rejected order is reportable, not fatal: shorting needs locate, and
      // some names are simply not shortable.
      results.push({ ...c, side, status: "rejected", error: err.message });
    }
  }
  return results;
}

/** Positions whose thesis has arrived (or broken) and should be closed. */
export async function reviewExits(theses, { dryRun = true } = {}) {
  const held = await openPositions();
  const bySymbol = new Map(held.map((p) => [p.symbol, p]));
  const actions = [];

  for (const t of theses) {
    const pos = bySymbol.get(t.ticker);
    if (!pos) continue;
    if (!t.exit?.exit) { actions.push({ ticker: t.ticker, action: "hold", reason: t.exit?.reason }); continue; }
    if (dryRun) { actions.push({ ticker: t.ticker, action: "would-close", reason: t.exit.reason }); continue; }
    try {
      await closePosition(t.ticker);
      actions.push({ ticker: t.ticker, action: "closed", reason: t.exit.reason });
    } catch (err) {
      actions.push({ ticker: t.ticker, action: "close-failed", reason: err.message });
    }
  }
  return actions;
}

/** Is this name shortable at all? Prevents proposing a trade the broker refuses. */
export async function shortable(symbols) {
  const out = new Map();
  for (const s of symbols) {
    try {
      const bars = await dailyBars([s], {
        start: new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString(),
      });
      out.set(s, (bars.get(s)?.length ?? 0) > 0);
    } catch { out.set(s, false); }
  }
  return out;
}
