// Options expression of a cascade.
//
// A cascade hands us three things a share position cannot use but an option
// needs exactly:
//
//   direction   the sign the thesis predicts for the dependent
//   magnitude   how much residual is still unclaimed, in σ — convert to a move
//   horizon     the ripple arrives in days, not months
//
// So the option is not a bolt-on. The residual gap sets the strike, the ripple
// horizon sets the expiry, and the thesis sign sets put versus call. Long
// premium also gives an autonomous agent something a short share position never
// does: defined, known-in-advance downside.
//
// Deep out-of-the-money contracts routinely quote with a zero bid, so options
// carry their own liquidity gate — the equity gate says nothing about them.

import "../env.mjs";

const TRADE = process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets";
const DATA = process.env.ALPACA_DATA_URL || "https://data.alpaca.markets";

const headers = () => ({
  "APCA-API-KEY-ID": process.env.ALPACA_API_KEY_ID,
  "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET_KEY,
});

export const OPTION_GATES = {
  minBid: 0.10,          // a contract with no bid cannot be exited
  maxSpreadFraction: 0.35, // ask-bid relative to mid
  minDaysToExpiry: 10,   // the ripple needs room to arrive
  maxDaysToExpiry: 60,   // beyond this the premium is paying for time we don't need
  minOpenInterest: 5,
};

const day = (d) => new Date(d).toISOString().slice(0, 10);

/** Active contracts for one underlying in the horizon window. */
export async function chain(underlying, { direction, minDays = OPTION_GATES.minDaysToExpiry, maxDays = OPTION_GATES.maxDaysToExpiry } = {}) {
  const url = new URL("/v2/options/contracts", TRADE);
  url.searchParams.set("underlying_symbols", underlying);
  url.searchParams.set("status", "active");
  url.searchParams.set("type", direction < 0 ? "put" : "call");
  url.searchParams.set("expiration_date_gte", day(Date.now() + minDays * 864e5));
  url.searchParams.set("expiration_date_lte", day(Date.now() + maxDays * 864e5));
  url.searchParams.set("limit", "500");

  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`options chain ${res.status}: ${(await res.text()).slice(0, 140)}`);
  const j = await res.json();
  return (j.option_contracts || []).map((c) => ({
    symbol: c.symbol,
    type: c.type,
    strike: Number(c.strike_price),
    expiry: c.expiration_date,
    openInterest: Number(c.open_interest ?? 0),
    daysOut: Math.round((new Date(c.expiration_date) - Date.now()) / 864e5),
  }));
}

/** Latest quotes for specific contracts. */
export async function quotes(symbols) {
  if (!symbols.length) return new Map();
  const out = new Map();
  // The endpoint caps how many symbols one request may carry.
  for (let i = 0; i < symbols.length; i += 100) {
    const url = new URL("/v1beta1/options/quotes/latest", DATA);
    url.searchParams.set("symbols", symbols.slice(i, i + 100).join(","));
    url.searchParams.set("feed", "indicative");
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) continue;
    const j = await res.json();
    for (const [sym, q] of Object.entries(j.quotes || {})) {
      const bid = Number(q.bp ?? 0), ask = Number(q.ap ?? 0);
      const mid = bid && ask ? (bid + ask) / 2 : 0;
      out.set(sym, { bid, ask, mid, spreadFraction: mid ? (ask - bid) / mid : Infinity, at: q.t });
    }
  }
  return out;
}

/**
 * Pick the contract that expresses this cascade.
 *
 * `expectedMove` is the fraction of price the thesis still expects — derived
 * from how much residual remains before the move would be considered priced in.
 * The strike sits partway into that move: far enough out to carry leverage,
 * near enough that arriving at the thesis puts it in the money.
 */
export async function selectContract({ underlying, spot, direction, expectedMove, horizonDays = 14 }) {
  if (!(spot > 0)) return { ok: false, gate: "option_data", reason: `no spot price for ${underlying}` };

  let contracts;
  try {
    contracts = await chain(underlying, { direction, minDays: OPTION_GATES.minDaysToExpiry, maxDays: OPTION_GATES.maxDaysToExpiry });
  } catch (err) {
    return { ok: false, gate: "option_data", reason: err.message.slice(0, 120) };
  }
  if (!contracts.length) return { ok: false, gate: "option_chain", reason: `${underlying} has no listed ${direction < 0 ? "puts" : "calls"} in the horizon window` };

  // Nearest expiry that still leaves room for the ripple. Reaching further out
  // buys time the thesis does not need and pays theta for it.
  const expiries = [...new Set(contracts.map((c) => c.expiry))].sort();
  const expiry = expiries.find((e) => (new Date(e) - Date.now()) / 864e5 >= Math.min(horizonDays, OPTION_GATES.minDaysToExpiry))
    ?? expiries[expiries.length - 1];

  // Target strike: partway into the move the thesis still expects.
  const reach = Math.max(0.01, Math.min(0.25, expectedMove * 0.6));
  const target = direction < 0 ? spot * (1 - reach) : spot * (1 + reach);

  const candidates = contracts
    .filter((c) => c.expiry === expiry)
    .sort((a, b) => Math.abs(a.strike - target) - Math.abs(b.strike - target))
    .slice(0, 8);
  if (!candidates.length) return { ok: false, gate: "option_chain", reason: `no strikes near ${target.toFixed(2)} for ${expiry}` };

  const q = await quotes(candidates.map((c) => c.symbol));

  const rejected = [];
  for (const c of candidates) {
    const quote = q.get(c.symbol);
    if (!quote || !(quote.bid > 0)) { rejected.push(`${c.symbol} no bid`); continue; }
    if (quote.bid < OPTION_GATES.minBid) { rejected.push(`${c.symbol} bid $${quote.bid.toFixed(2)}`); continue; }
    if (quote.spreadFraction > OPTION_GATES.maxSpreadFraction) { rejected.push(`${c.symbol} spread ${(quote.spreadFraction * 100).toFixed(0)}%`); continue; }
    if (c.openInterest < OPTION_GATES.minOpenInterest) { rejected.push(`${c.symbol} OI ${c.openInterest}`); continue; }
    return {
      ok: true,
      contract: { ...c, ...quote, underlying, spot, target, moneyness: direction < 0 ? spot / c.strike : c.strike / spot },
    };
  }

  return {
    ok: false,
    gate: "option_liquidity",
    reason: `no tradeable contract near ${target.toFixed(2)} exp ${expiry} — ${rejected.slice(0, 3).join(", ")}`,
  };
}

/** Contracts to buy for a dollar budget. One contract controls 100 shares. */
export function contractsFor(notional, premium) {
  if (!(premium > 0)) return 0;
  return Math.floor(notional / (premium * 100));
}

// Alpaca rejects options MARKET orders outside regular hours (422 / 42210000).
// The daemon holds until the open, but scripts can hit this directly.
export const OPTIONS_MARKET_HOURS_ONLY = true;

export async function submitOptionOrder({ symbol, qty, clientOrderId }) {
  const res = await fetch(new URL("/v2/orders", TRADE), {
    method: "POST",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify({
      symbol,
      qty: String(qty),
      side: "buy",             // long premium only: defined risk
      type: "market",
      time_in_force: "day",
      client_order_id: clientOrderId,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`option order ${res.status}: ${text.slice(0, 180)}`);
  return JSON.parse(text);
}

export async function optionPositions() {
  const res = await fetch(new URL("/v2/positions", TRADE), { headers: headers() });
  if (!res.ok) return [];
  const all = await res.json();
  return all.filter((p) => p.asset_class === "us_option");
}
