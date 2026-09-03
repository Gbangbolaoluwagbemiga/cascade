// Position sizing and execution.
//
// Size = exposure x confidence, where confidence falls as the residual creeps
// toward "already priced". A name that is 34% exposed and utterly unmoved earns
// a bigger position than one 9% exposed and half-priced already.

import { submitOrder, positions as openPositions, closePosition, dailyBars, latestPrices } from "../market/alpaca.mjs";
import { selectContract, contractsFor, submitOptionOrder } from "../market/options.mjs";
import * as alpacaMcp from "../market/alpaca-mcp.mjs";
import * as ledger from "./ledger.mjs";
import { PRICED_MIN_Z } from "../market/residual.mjs";
import { UNPRICED_MAX_Z } from "../market/residual.mjs";

// Equities had no percentage stop at all — a share position could run a long
// way against the thesis and nothing would cut it, because the only equity exit
// was the residual reaching ±2σ. The residual is the *primary* signal; these are
// the backstop for when it takes too long to say so.
export const EQUITY_EXITS = {
  takeProfit: 0.08,   // +8% on the position: bank it rather than wait for 2σ
  stopLoss: -0.06,    // -6%: the thesis is costing more than it is worth
};

export const OPTION_EXITS = {
  takeProfit: 0.60,   // +60% on premium: bank it rather than wait for 2σ
  stopLoss: -0.50,    // -50%: the thesis is not arriving fast enough
  minDaysLeft: 5,     // close before the expiry cliff dominates the price
};

export const SIZING = {
  portfolioRisk: 0.25,   // never deploy more than a quarter of equity per cascade
  maxPerPosition: 0.05,  // and never more than 5% in one name
  minNotional: 200,      // below this the fill is not worth the slippage

  // Ceiling across the WHOLE book, not one cascade.
  //
  // Each cascade was sized without knowing what earlier ones had already
  // committed, so four of them stacked to 47% of equity — sixteen positions,
  // every one short, all moving together. The per-cascade and per-name caps
  // never saw each other. This one does.
  portfolioCap: Number(process.env.PORTFOLIO_CAP || 0.60),
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

/**
 * @param deployed capital already committed across the existing book. Passing
 *   it is what stops cascades stacking blindly on one another.
 */
export function sizePositions(candidates, equity, { deployed = 0 } = {}) {
  const scored = candidates.map((c) => ({ ...c, confidence: confidence(c) }));
  const weightOf = (c) => c.exposure * c.confidence;
  const total = scored.reduce((a, c) => a + weightOf(c), 0);
  if (!(total > 0)) return [];

  // Headroom left under the portfolio ceiling, after what is already open.
  const ceiling = equity * SIZING.portfolioCap;
  const headroom = Math.max(0, ceiling - deployed);
  if (headroom < SIZING.minNotional) return [];

  const budget = Math.min(equity * SIZING.portfolioRisk, headroom);
  return scored
    .map((c) => {
      const share = weightOf(c) / total;
      const notional = Math.min(budget * share, equity * SIZING.maxPerPosition);
      return { ...c, weight: share, notional: Math.round(notional * 100) / 100 };
    })
    .filter((c) => c.notional >= SIZING.minNotional);
}

/** Capital committed across the open book, as an absolute figure. */
export async function deployedCapital() {
  try {
    const held = await openPositions();
    return held.reduce((sum, p) => sum + Math.abs(Number(p.market_value)), 0);
  } catch { return 0; }
}

/**
 * Headroom check with a legible reason, so a refusal reads like every other
 * gate rather than an empty result.
 */
export async function portfolioHeadroom(equity) {
  const deployed = await deployedCapital();
  const ceiling = equity * SIZING.portfolioCap;
  const headroom = ceiling - deployed;
  return {
    deployed, ceiling, headroom,
    pct: deployed / equity,
    ok: headroom >= SIZING.minNotional,
    reason: headroom >= SIZING.minNotional
      ? null
      : `portfolio is ${(100 * deployed / equity).toFixed(0)}% deployed against a ${(SIZING.portfolioCap * 100).toFixed(0)}% ceiling — no headroom for a new cascade`,
  };
}

/**
 * How much further the thesis expects this name to move, as a fraction of
 * price. It is the residual still unclaimed — the distance from where the
 * market has taken it to where "already priced" begins — converted back from
 * sigmas into a move. This is what sizes the option strike.
 */
export function expectedMove(candidate) {
  const aligned = candidate.z * Math.sign(candidate.direction || -1);
  const gap = Math.max(0.25, PRICED_MIN_Z - aligned);
  const scale = candidate.scale ?? (candidate.residualSigma ?? 0.02);
  return Math.max(0.01, Math.min(0.30, gap * scale));
}

/**
 * Place the orders. `dryRun` is the default: nothing reaches the broker unless
 * the caller explicitly asks, because an accidental live submission is not the
 * kind of mistake you can take back.
 *
 * Options are the primary expression — the cascade supplies direction,
 * magnitude and horizon, which is exactly what an option needs and a share
 * cannot use — with shares as the fallback when no contract is tradeable.
 */
/**
 * Route an order through Alpaca's official MCP server, falling back to the REST
 * client if it cannot start. Never silently drops the order — the route taken
 * is recorded on the result.
 */
async function route(kind, args, { viaMcp }) {
  if (viaMcp) {
    try {
      const r = kind === "option"
        ? await alpacaMcp.placeOptionOrder(args)
        : await alpacaMcp.placeStockOrder(args);
      return { via: "alpaca-mcp", response: r.text };
    } catch (err) {
      // Fall through to REST rather than lose the trade.
      const fallbackError = err.message.slice(0, 140);
      if (kind === "option") {
        const filled = await submitOptionOrder({ symbol: args.symbol, qty: args.qty, limitPrice: args.limitPrice, clientOrderId: args.clientOrderId });
        return { via: "rest-fallback", mcpError: fallbackError, id: filled.id, status: filled.status };
      }
      const filled = await submitOrder(args.order);
      return { via: "rest-fallback", mcpError: fallbackError, id: filled.id, status: filled.status };
    }
  }
  if (kind === "option") {
    const filled = await submitOptionOrder({ symbol: args.symbol, qty: args.qty, limitPrice: args.limitPrice, clientOrderId: args.clientOrderId });
    return { via: "rest", id: filled.id, status: filled.status };
  }
  const filled = await submitOrder(args.order);
  return { via: "rest", id: filled.id, status: filled.status };
}

export async function execute(sized, { direction = -1, dryRun = true, preferOptions = true, viaMcp = process.env.EXECUTION_VIA !== "rest" } = {}) {
  const side = direction < 0 ? "sell" : "buy";
  const results = [];

  // Never stack onto a name already held. Two cascades touching the same
  // dependent, or a re-run of the same event, would otherwise multiply the
  // position past its own size cap without any gate noticing.
  let alreadyHeld = new Set();
  if (!dryRun) {
    try {
      const held = await openPositions();
      for (const p of held) {
        alreadyHeld.add(p.symbol);
        const underlying = p.symbol.match(/^([A-Z]+)\d{6}[CP]\d{8}$/)?.[1];
        if (underlying) alreadyHeld.add(underlying);
      }
    } catch { /* if positions cannot be read, fall through rather than block */ }
  }

  // Alpaca rejects fractional quantities on a short sale, and a notional order
  // implies a fraction. Shorts therefore have to be expressed in whole shares,
  // which needs a price — so sizing in dollars is converted here rather than
  // leaving the caller to discover the rule from a 422.
  const prices = side === "sell" ? await latestPrices(sized.map((c) => c.ticker)) : new Map();

  for (const c of sized) {
    if (alreadyHeld.has(c.ticker)) {
      results.push({ ...c, instrument: "skipped", status: "skipped",
        error: `already holding ${c.ticker} — not stacking` });
      continue;
    }

    // ── options first ────────────────────────────────────────────────────────
    if (preferOptions) {
      const spot = c.spot ?? prices.get(c.ticker);
      const move = expectedMove(c);
      let pick;
      try {
        pick = await selectContract({ underlying: c.ticker, spot, direction, expectedMove: move });
      } catch (err) {
        pick = { ok: false, gate: "option_data", reason: err.message.slice(0, 120) };
      }

      if (pick.ok) {
        const k = pick.contract;
        const qty = contractsFor(c.notional, k.mid);
        if (qty >= 1) {
          const record = {
            ...c, instrument: "option", side: "buy",
            contract: k.symbol, strike: k.strike, expiry: k.expiry, daysToExpiry: k.daysOut,
            premium: k.mid, contracts: qty, notional: Number((qty * k.mid * 100).toFixed(2)),
            expectedMovePct: move, spot,
          };
          if (dryRun) { results.push({ ...record, status: "dry-run", via: viaMcp ? "alpaca-mcp" : "rest" }); continue; }
          try {
            const r = await route("option", {
              symbol: k.symbol, qty, limitPrice: k.mid,
              clientOrderId: `csc-${c.hub}-${c.ticker}-${Date.now()}`.slice(0, 48),
            }, { viaMcp });
            const done = { ...record, status: r.status ?? "submitted", orderId: r.id, via: r.via, mcpError: r.mcpError };
            ledger.record(done);
            results.push(done);
          } catch (err) {
            results.push({ ...record, status: "rejected", error: err.message.slice(0, 160) });
          }
          continue;
        }
        // Budget below one contract: fall through to shares rather than skip.
        c.optionNote = `$${c.notional} under one contract at $${k.mid.toFixed(2)}`;
      } else {
        c.optionNote = `${pick.gate}: ${pick.reason}`;
      }
    }

    // ── shares fallback ──────────────────────────────────────────────────────
    const order = {
      symbol: c.ticker,
      side,
      type: "market",
      time_in_force: "day",
      client_order_id: `cascade-${c.hub}-${c.ticker}-${Date.now()}`.slice(0, 48),
    };

    if (side === "sell") {
      const price = prices.get(c.ticker);
      if (!price) { results.push({ ...c, instrument: "share", side, status: "skipped", error: "no price to convert notional to whole shares" }); continue; }
      const qty = Math.floor(c.notional / price);
      if (qty < 1) { results.push({ ...c, instrument: "share", side, status: "skipped", error: `notional $${c.notional} is under one share at $${price.toFixed(2)}` }); continue; }
      order.qty = String(qty);
      c.shares = qty;
      c.price = price;
    } else {
      order.notional = c.notional;
    }

    if (dryRun) {
      results.push({ ...c, instrument: "share", side, status: "dry-run", order, via: viaMcp ? "alpaca-mcp" : "rest" });
      continue;
    }
    try {
      const r = await route("share", {
        order,
        symbol: order.symbol,
        side: order.side,
        qty: order.qty ? Number(order.qty) : undefined,
        notional: order.notional,
      }, { viaMcp });
      const done = {
        ...c, instrument: "share", side,
        status: r.status ?? "submitted", orderId: r.id, via: r.via, mcpError: r.mcpError,
      };
      // Write the thesis down at order time. Without this the exit logic cannot
      // tell which event opened the position.
      ledger.record(done);
      results.push(done);
    } catch (err) {
      // A rejected order is reportable, not fatal: shorting needs locate, and
      // some names are simply not shortable.
      results.push({ ...c, instrument: "share", side, status: "rejected", error: String(err.message).slice(0, 160) });
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
