// Canonicalising a disclosed counterparty to a tradeable identity.
//
// Filers name the same company in their own taxonomy, so one hub arrives as
// "Ford", "Ford Motor Company" and "Ford Motor Co". Left unmerged, in-degree
// fragments and every hub looks half its real size.
//
// The discipline is the same as everywhere else in this pipeline: exact match,
// or an unambiguous prefix, or nothing. No fuzzy merging, no edit distance, no
// "probably the same company". An unresolved counterparty is reported as
// unresolved — it stays in the graph as an explanation, marked unpositionable.
//
// Uniqueness is judged per COMPANY (CIK), not per ticker. Ford lists four
// tickers on one CIK — F plus three preferred lines — and counting tickers made
// the prefix "ford" look ambiguous when it identifies exactly one company.

import { getJSON } from "./sec.mjs";
import { normalizeName } from "./resolve.mjs";
import AMBIGUOUS from "./ambiguous-keys.json" with { type: "json" };

const AMBIGUOUS_KEYS = new Set(AMBIGUOUS.ambiguous);

// Exchanges Alpaca can trade. OTC-quoted foreign lines (Mercedes-Benz as
// MBGAF, Volkswagen as VWAGY) resolve to a real company but are not
// positionable, and that distinction has to survive into the graph.
const TRADEABLE_EXCHANGES = new Set(["Nasdaq", "NYSE", "NYSE American", "CBOE", "NYSE Arca"]);

// Tokens carrying no identity alone: "general" is Motors, Electric, Dynamics
// and Mills.
const NON_IDENTIFYING = new Set([
  "general", "american", "national", "united", "first", "global", "international",
  "standard", "pacific", "atlantic", "central", "northern", "southern", "eastern",
  "western", "advanced", "applied", "allied", "premier", "superior", "universal",
  "new", "old", "great", "big", "best", "prime", "core", "next", "future",
]);

const despace = (s) => s.replace(/\s+/g, "");

let indexCache = null;

async function buildIndex() {
  if (indexCache) return indexCache;

  const raw = await getJSON("https://www.sec.gov/files/company_tickers_exchange.json");
  const col = Object.fromEntries(raw.fields.map((f, i) => [f, i]));

  // One record per company, with its primary listing.
  const companies = new Map(); // cik -> { cik, name, ticker, exchange }
  for (const row of raw.data) {
    const cik = String(row[col.cik]);
    const ticker = row[col.ticker];
    const exchange = row[col.exchange];
    if (!ticker) continue;
    const prev = companies.get(cik);
    // Prefer a plain common-stock line: no hyphen, then shortest, then a
    // tradeable exchange over an OTC quote.
    const score = (t, ex) =>
      (t.includes("-") ? 100 : 0) + t.length + (TRADEABLE_EXCHANGES.has(ex) ? 0 : 50);
    if (!prev || score(ticker, exchange) < score(prev.ticker, prev.exchange)) {
      companies.set(cik, { cik, name: row[col.name], ticker, exchange });
    }
  }

  const exact = new Map(); // normalised name -> cik
  const squashed = new Map(); // despaced name -> Set(cik)
  const prefixCounts = new Map(); // prefix -> Set(cik)

  for (const [cik, c] of companies) {
    const key = normalizeName(c.name);
    if (!key || key.length < 2) continue;
    if (!exact.has(key)) exact.set(key, cik);

    const sq = despace(key);
    if (!squashed.has(sq)) squashed.set(sq, new Set());
    squashed.get(sq).add(cik);

    const tokens = key.split(" ");
    for (let n = 1; n < tokens.length; n++) {
      const p = tokens.slice(0, n).join(" ");
      if (!prefixCounts.has(p)) prefixCounts.set(p, new Set());
      prefixCounts.get(p).add(cik);
    }
  }

  const prefix = new Map();
  for (const [p, ciks] of prefixCounts) {
    if (ciks.size !== 1) continue; // identifies exactly one company
    if (exact.has(p)) continue; // a real full name wins
    const tokens = p.split(" ");
    if (tokens.every((t) => NON_IDENTIFYING.has(t))) continue;
    if (tokens.length === 1 && AMBIGUOUS_KEYS.has(p)) continue;
    prefix.set(p, [...ciks][0]);
  }

  const squash = new Map();
  for (const [s, ciks] of squashed) if (ciks.size === 1) squash.set(s, [...ciks][0]);

  indexCache = { companies, exact, prefix, squash };
  return indexCache;
}

/** Exchange/tradeability for a ticker we already hold — not a name lookup. */
export async function lookupTicker(ticker) {
  const { companies } = await buildIndex();
  for (const [, c] of companies) {
    if (c.ticker === ticker) {
      return { ticker: c.ticker, company: c.name, exchange: c.exchange, positionable: TRADEABLE_EXCHANGES.has(c.exchange) };
    }
  }
  return { ticker, company: null, exchange: null, positionable: false, reason: "ticker not in SEC exchange file" };
}

function describe(companies, cik, method, canonicalName) {
  const c = companies.get(cik);
  return {
    ticker: c.ticker,
    company: c.name,
    exchange: c.exchange,
    positionable: TRADEABLE_EXCHANGES.has(c.exchange),
    method,
    canonicalName,
  };
}

/**
 * @returns resolution with `positionable`, or `{ticker:null, reason}`.
 *   "exact"          the filer's name matched a company title
 *   "squashed"       spacing variant only ("Wal Mart" -> "Walmart")
 *   "unique-prefix"  "Ford" matched the one company named "Ford Motor…"
 */
export async function canonicalise(displayName) {
  const { companies, exact, prefix, squash } = await buildIndex();
  const key = normalizeName(displayName);
  if (!key) return { ticker: null, reason: "empty after normalisation" };

  const hit = exact.get(key);
  if (hit) return describe(companies, hit, "exact", key);

  // Member tags split CamelCase, so "WalMartMember" becomes "Wal Mart" while
  // the filing title is "Walmart Inc." Spacing-only variants are still exact.
  const sq = squash.get(despace(key));
  if (sq) return describe(companies, sq, "squashed", key);

  const pre = prefix.get(key);
  if (pre) return describe(companies, pre, "unique-prefix", key);

  return { ticker: null, reason: "no exact or unambiguous match", canonicalName: key };
}

/**
 * Merge edges onto canonical hubs, split by whether we can hold a position.
 *
 * An unresolved or non-tradeable counterparty is not a failure — the US
 * Government really is 92% of Oshkosh's revenue, and Volkswagen really is a
 * customer of several suppliers. Those edges stay in the graph as explanations
 * for a node's exposure, flagged so the trader never attempts them.
 */
export async function canonicaliseEdges(edges) {
  const positionable = [];
  const unpositionable = [];
  const byHub = new Map();

  for (const e of edges) {
    const c = await canonicalise(e.counterparty);
    const out = {
      ...e,
      to: c.ticker ?? null,
      toCompany: c.company ?? null,
      exchange: c.exchange ?? null,
      resolution: c.method ?? null,
    };

    if (!c.ticker) {
      unpositionable.push({ ...out, unpositionableReason: c.reason });
      continue;
    }
    if (c.ticker === e.from) continue; // a filer naming itself
    if (!c.positionable) {
      unpositionable.push({ ...out, unpositionableReason: `not on a tradeable exchange (${c.exchange})` });
      continue;
    }

    positionable.push(out);
    if (!byHub.has(c.ticker)) byHub.set(c.ticker, []);
    byHub.get(c.ticker).push(out);
  }

  return { positionable, unpositionable, byHub };
}
