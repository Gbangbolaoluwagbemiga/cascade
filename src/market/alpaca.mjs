// Alpaca client — market data and paper trading.
//
// Failure here must be legible. A missing key, a rejected feed and an empty bar
// series are three different problems with three different fixes, and a stack
// trace tells you none of them.

import { loadEnv } from "../env.mjs";
loadEnv();

export const DATA_URL = process.env.ALPACA_DATA_URL || "https://data.alpaca.markets";
export const TRADE_URL = process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets";

export function credentials() {
  const id = process.env.ALPACA_API_KEY_ID;
  const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!id || !secret) {
    return {
      ok: false,
      reason:
        "No Alpaca credentials. Add ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY to .env " +
        "(alpaca.markets -> select the PAPER account, top left -> API Keys -> Generate New Key).",
    };
  }
  return { ok: true, headers: { "APCA-API-KEY-ID": id, "APCA-API-SECRET-KEY": secret } };
}

async function call(base, endpoint, { method = "GET", body = null, query = null } = {}) {
  const cred = credentials();
  if (!cred.ok) throw new Error(cred.reason);

  const url = new URL(endpoint, base);
  if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);

  const res = await fetch(url, {
    method,
    headers: { ...cred.headers, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* keep raw */ }

  if (!res.ok) {
    const detail = parsed?.message || text.slice(0, 200);
    const err = new Error(`Alpaca ${res.status} on ${url.pathname}: ${detail}`);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

export const account = () => call(TRADE_URL, "/v2/account");
export const clock = () => call(TRADE_URL, "/v2/clock");

/**
 * Daily bars for several symbols. Paginates, since a long history across many
 * symbols exceeds one page.
 *
 * `feed` matters: "sip" is consolidated and complete but the free tier only
 * serves it delayed; "iex" is real time but a few percent of volume, which is
 * exactly the wrong trade-off for the small caps in our dependent list.
 */
// The free tier serves SIP delayed. Asking for the most recent minutes returns
// 403 "subscription does not permit querying recent SIP data" — so the client
// clamps the window rather than leaving every caller to remember.
export const SIP_DELAY_MINUTES = 16;

export function clampEndForFeed(end, feed) {
  if (feed !== "sip") return end;
  const latest = Date.now() - SIP_DELAY_MINUTES * 60 * 1000;
  const asked = end ? new Date(end).getTime() : Date.now();
  return new Date(Math.min(asked, latest)).toISOString();
}

/**
 * SEC and Alpaca write class shares differently: the SEC ticker file has MOG-A
 * and BRK-B, Alpaca wants MOG.A and BRK.B. An unmapped symbol returns 400 and,
 * because bars are fetched in one batch, takes down every cascade that touches
 * it — a single Moog edge aborted the whole Boeing cascade.
 */
export const toAlpacaSymbol = (s) => String(s).replace(/-([A-Z])$/, ".$1");
export const fromAlpacaSymbol = (s) => String(s).replace(/\.([A-Z])$/, "-$1");

// Bar cache.
//
// Daily bars for a session that has already closed do not change, and the same
// dependents are re-scored on every UI click, every daemon cycle and every exit
// check. Without this each of those paid full network cost — and paid it again
// on the retry path when Alpaca's connection flaked. Keyed by the exact query,
// so a different window or timeframe never reads a stale series.
const BAR_CACHE = new Map();
const BAR_TTL_MS = 5 * 60 * 1000;

function barCacheGet(key) {
  const hit = BAR_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > BAR_TTL_MS) { BAR_CACHE.delete(key); return null; }
  return hit.value;
}

function barCacheSet(key, value) {
  // Bounded so a long-running daemon cannot grow it without limit.
  if (BAR_CACHE.size > 400) BAR_CACHE.clear();
  BAR_CACHE.set(key, { at: Date.now(), value });
}

export async function dailyBars(symbols, { start, end, feed = "sip", limit = 10000, timeframe = "1Day" } = {}) {
  const out = new Map();
  let pageToken = null;
  end = clampEndForFeed(end, feed);

  // Translate on the way out, translate back on the way in, so callers keep
  // using the SEC spelling the graph is built from.
  const wire = symbols.map(toAlpacaSymbol);

  const cacheKey = JSON.stringify([[...wire].sort(), timeframe, start, end, feed, limit]);
  const cached = barCacheGet(cacheKey);
  if (cached) return new Map(cached);

  do {
    const page = await call(DATA_URL, "/v2/stocks/bars", {
      query: {
        symbols: wire.join(","),
        timeframe,
        start,
        end,
        feed,
        adjustment: "split",
        limit,
        page_token: pageToken,
      },
    });
    for (const [sym, bars] of Object.entries(page.bars || {})) {
      const key = fromAlpacaSymbol(sym);
      if (!out.has(key)) out.set(key, []);
      out.get(key).push(...bars);
    }
    pageToken = page.next_page_token || null;
  } while (pageToken);

  for (const bars of out.values()) bars.sort((a, b) => (a.t < b.t ? -1 : 1));
  // Copy on the way in and on the way out, so a caller mutating its result
  // cannot corrupt what the next caller reads.
  barCacheSet(cacheKey, new Map(out));
  return out;
}

/**
 * Which feeds this key can actually read.
 *
 * The paper-trading docs say a Paper Only Account is entitled to IEX data; the
 * market-data docs say the free Basic plan is "real time IEX or 15 min delayed
 * SIP". Those disagree, so we ask the API instead of reading the docs.
 */
export async function probeFeeds(symbol = "AAPL") {
  const end = new Date(Date.now() - (SIP_DELAY_MINUTES + 4) * 60 * 1000).toISOString();
  const start = new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString();
  const results = {};

  for (const feed of ["iex", "sip"]) {
    try {
      const bars = await dailyBars([symbol], { start, end, feed });
      const n = bars.get(symbol)?.length ?? 0;
      results[feed] = { ok: n > 0, bars: n };
    } catch (err) {
      results[feed] = { ok: false, status: err.status ?? null, reason: err.message };
    }
  }
  return results;
}

export const submitOrder = (order) => call(TRADE_URL, "/v2/orders", { method: "POST", body: order });
export const positions = () => call(TRADE_URL, "/v2/positions");

/** Order history — every order sent, filled or not. */
export const orders = ({ status = "all", limit = 60 } = {}) =>
  call(TRADE_URL, "/v2/orders", { query: { status, limit, direction: "desc", nested: "true" } });
export const closePosition = (symbol) => call(TRADE_URL, `/v2/positions/${symbol}`, { method: "DELETE" });

/**
 * Benzinga headlines via Alpaca. This is the event feed: the daemon watches it
 * for news on graph hubs, because an event at a hub is what starts a cascade.
 */
export async function news(symbols, { start, end, limit = 50 } = {}) {
  const cred = credentials();
  if (!cred.ok) throw new Error(cred.reason);
  const url = new URL("/v1beta1/news", DATA_URL);
  url.searchParams.set("symbols", symbols.join(","));
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("sort", "desc");
  if (start) url.searchParams.set("start", start);
  if (end) url.searchParams.set("end", end);

  const res = await fetch(url, { headers: cred.headers });
  if (!res.ok) throw new Error(`Alpaca news ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = await res.json();
  return (j.news || []).map((n) => ({
    id: n.id,
    at: n.created_at,
    headline: n.headline,
    summary: n.summary,
    source: n.source,
    url: n.url,
    symbols: n.symbols,
  }));
}

/** Most recent close per symbol, respecting the SIP delay. */
export async function latestPrices(symbols, { feed = "sip" } = {}) {
  const start = new Date(Date.now() - 12 * 24 * 3600 * 1000).toISOString();
  const bars = await dailyBars(symbols, { start, feed });
  const out = new Map();
  for (const [sym, series] of bars) if (series.length) out.set(sym, series[series.length - 1].c);
  return out;
}
