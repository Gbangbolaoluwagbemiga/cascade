// SEC EDGAR access. Fair-access rules require a User-Agent carrying a contact
// address and a request rate under 10/sec; we stay well under it.

const CONTACT = process.env.SEC_CONTACT || "Cascade Research gbangbolaphilip@gmail.com";
const HEADERS = { "User-Agent": CONTACT, "Accept-Encoding": "gzip, deflate" };
const MIN_GAP_MS = 340;

let lastRequest = 0;

async function throttle() {
  const wait = lastRequest + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequest = Date.now();
}

async function request(url, { retries = 3 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    await throttle();
    let res;
    try {
      res = await fetch(url, { headers: HEADERS });
    } catch (err) {
      if (attempt === retries) throw new Error(`network failure on ${url}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    // 403 from EDGAR means the User-Agent was rejected — retrying will not help.
    if (res.status === 403) throw new Error(`EDGAR rejected the request (403). Check SEC_CONTACT.`);
    if (res.status === 429 || res.status >= 500) {
      if (attempt === retries) throw new Error(`${res.status} after ${retries} retries: ${url}`);
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
    return res;
  }
}

export async function getJSON(url) {
  return (await request(url)).json();
}

export async function getText(url) {
  return (await request(url)).text();
}

let tickerMapCache = null;

/** ticker -> { cik (10-digit padded), title } */
export async function tickerMap() {
  if (tickerMapCache) return tickerMapCache;
  const raw = await getJSON("https://www.sec.gov/files/company_tickers.json");
  const map = new Map();
  for (const key of Object.keys(raw)) {
    const { cik_str, ticker, title } = raw[key];
    map.set(ticker, { cik: String(cik_str).padStart(10, "0"), title });
  }
  tickerMapCache = map;
  return map;
}

/**
 * Most recent annual report for a ticker.
 * Returns null when the company files neither 10-K nor 20-F (ETFs, trusts,
 * foreign private issuers on other forms) rather than throwing — the survey
 * needs to count those as misses, not crash on them.
 */
export async function latestAnnualReport(ticker) {
  const map = await tickerMap();
  const rec = map.get(ticker);
  if (!rec) return null;

  const sub = await getJSON(`https://data.sec.gov/submissions/CIK${rec.cik}.json`);
  const recent = sub.filings?.recent;
  if (!recent) return null;

  for (let i = 0; i < recent.form.length; i++) {
    const form = recent.form[i];
    if (form !== "10-K" && form !== "20-F") continue;
    const accession = recent.accessionNumber[i];
    const bare = accession.replace(/-/g, "");
    const doc = recent.primaryDocument[i];
    if (!doc) continue;
    return {
      ticker,
      company: rec.title,
      cik: rec.cik,
      sic: sub.sic || null,
      sicDescription: sub.sicDescription || null,
      // "Large accelerated filer", "Accelerated filer", "Non-accelerated filer"
      filerCategory: sub.category || null,
      // The accession prefix is the CIK of the agent that transmitted the
      // filing — a free proxy for filing agent (Workiva, Toppan Merrill, ...).
      filingAgentCik: accession.slice(0, 10),
      form,
      accession,
      filingDate: recent.filingDate[i],
      reportDate: recent.reportDate?.[i] ?? null,
      url: `https://www.sec.gov/Archives/edgar/data/${Number(rec.cik)}/${bare}/${doc}`,
    };
  }
  return null;
}

// --- filing cache -----------------------------------------------------------
// Survey re-runs after an extractor fix should cost CPU, not 237 downloads.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname — the project path contains spaces, which
// pathname percent-encodes into a directory that does not exist.
const CACHE_DIR = fileURLToPath(new URL("../../data/cache/", import.meta.url));

export async function getFilingCached(url) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const key = crypto.createHash("sha1").update(url).digest("hex") + ".html";
  const file = path.join(CACHE_DIR, key);
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  const text = await getText(url);
  fs.writeFileSync(file, text);
  return text;
}
