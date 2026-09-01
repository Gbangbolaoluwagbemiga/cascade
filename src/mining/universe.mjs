// Sector universes built from EDGAR's own SIC classification, so the sample is
// not a list of tickers I already believed would disclose.

import { getText, tickerMap } from "./sec.mjs";

let reverseCache = null;
async function cikToTicker() {
  if (reverseCache) return reverseCache;
  const map = await tickerMap();
  const rev = new Map();
  for (const [ticker, { cik }] of map) {
    const key = String(Number(cik));
    if (!rev.has(key)) rev.set(key, ticker);
  }
  reverseCache = rev;
  return rev;
}

/** Companies filing 10-Ks under a SIC code, restricted to those with a ticker. */
export async function sectorUniverse(sic, { max = 200 } = {}) {
  const rev = await cikToTicker();
  const out = new Map();

  for (let start = 0; start < max; start += 100) {
    const url =
      `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&SIC=${sic}` +
      `&type=10-K&dateb=&owner=include&count=100&start=${start}&output=atom`;
    const xml = await getText(url);
    const ciks = [...xml.matchAll(/CIK=(\d+)/g)].map((m) => String(Number(m[1])));
    if (!ciks.length) break;
    for (const cik of ciks) {
      const ticker = rev.get(cik);
      // No ticker means not listed, which means untradeable — correctly excluded.
      if (ticker) out.set(ticker, cik);
    }
    if (ciks.length < 100) break;
  }
  return [...out.keys()];
}

/** Deterministic sampling, so the survey is reproducible. */
export function sample(list, n, seed = 20260813) {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}
