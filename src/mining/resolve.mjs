// Resolving a counterparty name to a listed ticker.
//
// Rule from the schema decisions: resolution is exact-match only, against the
// SEC's own company index. We never infer a counterparty. A name we cannot
// resolve is reported as unresolved, never guessed.

import { tickerMap } from "./sec.mjs";
import AMBIGUOUS from "./ambiguous-keys.json" with { type: "json" };

// Single-token company keys that are also ordinary English words ("financial",
// "southern", "strategy"). Not rejected outright — a filing really can name
// Coherent or Flex — but flagged, so the survey counts them separately and the
// LLM adjudication step decides with the quote in hand.
const AMBIGUOUS_KEYS = new Set(AMBIGUOUS.ambiguous);

// Strictly corporate-form suffixes, stripped from the END only.
//
// "holdings", "group" and "trust" are deliberately NOT here: they are part of
// the distinctive name, not form markers. Stripping them turned
// "NORTHERN TRUST CORP" into the key "northern". Likewise nothing is stripped
// from the front — that turned "BV Financial, Inc." into "financial", so every
// filing containing the word "Financial" resolved to BVFL.
const SUFFIXES = new Set([
  "inc", "incorporated", "corp", "corporation", "co", "company", "ltd", "limited",
  "llc", "lp", "plc", "nv", "sa", "ag", "se", "ab", "oyj", "kk", "spa", "bv",
  "gmbh", "aps", "asa", "pte",
]);

// Capitalised words that are never company names in a filing context. Without
// this, "Total" resolves to TotalEnergies and "Products" to a shell company.
const STOPWORDS = new Set([
  "total", "revenue", "revenues", "sales", "net", "customer", "customers",
  "products", "product", "services", "segment", "segments", "company", "group",
  "december", "january", "february", "march", "april", "may", "june", "july",
  "august", "september", "october", "november", "fiscal", "year", "years",
  "united", "states", "china", "korea", "taiwan", "japan", "europe", "americas",
  "asia", "other", "others", "all", "one", "two", "three", "four", "five",
  "consolidated", "our", "we", "approximately", "accounts", "receivable",
]);

export function normalizeName(raw) {
  const cleaned = String(raw)
    .toLowerCase()
    // Apostrophes are DELETED, not spaced: "Lowe's" must normalise to "lowes"
    // to match the SEC title "LOWES COMPANIES INC". Replacing them with a space
    // produced "lowe s", which matched nothing — Lowe's, Macy's and McDonald's
    // were all unresolvable.
    .replace(/['‘’]/g, "")
    .replace(/[.,;:()"“”]/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const tokens = cleaned.split(" ").filter(Boolean);
  if (tokens[0] === "the") tokens.shift();
  while (tokens.length > 1 && SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(" ");
}

let indexCache = null;

/** normalized company name -> ticker */
export async function nameIndex() {
  if (indexCache) return indexCache;
  const map = await tickerMap();
  const index = new Map();
  for (const [ticker, { title }] of map) {
    const key = normalizeName(title);
    if (!key || key.length < 3) continue;
    // Multiple share classes share a title; keep the shortest ticker (usually
    // the primary line, e.g. GOOG over GOOGL is wrong but harmless here since
    // we only need identity, not the exact class).
    const existing = index.get(key);
    if (!existing || ticker.length < existing.length) index.set(key, ticker);
  }
  indexCache = index;
  return index;
}

/**
 * Exact resolution only. Returns a ticker or null — never a guess.
 * `maxTokens` bounds the n-gram sweep; company names beyond 5 tokens are rare
 * and the cost is quadratic in token count.
 */
export async function resolveNamesIn(passage, { maxTokens = 5, self = null } = {}) {
  const index = await nameIndex();
  const found = new Map();

  // Capitalised token runs are the only candidates worth testing.
  const tokens = passage.split(/\s+/);
  const isCapitalised = (t) => /^[A-Z][A-Za-z0-9&.'\-]*$/.test(t);

  for (let i = 0; i < tokens.length; i++) {
    if (!isCapitalised(tokens[i])) continue;
    for (let n = maxTokens; n >= 1; n--) {
      if (i + n > tokens.length) continue;
      const slice = tokens.slice(i, i + n);
      if (!slice.every((t) => isCapitalised(t) || SUFFIXES.has(t.toLowerCase().replace(/\./g, "")))) continue;

      const surface = slice.join(" ");
      const key = normalizeName(surface);
      if (!key || key.split(" ").every((t) => STOPWORDS.has(t))) continue;
      if (key.split(" ").length === 1 && STOPWORDS.has(key)) continue;

      const ticker = index.get(key);
      if (ticker) {
        // A filer naming itself is not a counterparty.
        if (self && ticker === self) { i += n - 1; break; }
        const ambiguous = !key.includes(" ") && AMBIGUOUS_KEYS.has(key);
        found.set(ticker, { ticker, surface, normalized: key, ambiguous });
        i += n - 1;
        break;
      }
    }
  }
  return [...found.values()];
}
