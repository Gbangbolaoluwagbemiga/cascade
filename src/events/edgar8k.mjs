// EDGAR 8-K watcher — the second event source.
//
// A headline is somebody's judgement that something mattered. An 8-K is the
// company's own: it is filed *because* the filer deems the event material, with
// a timestamp and a numbered item saying what kind of event it was. No triage
// guessing required.
//
// The item that matters most here is 1.02 — termination of a material definitive
// agreement. That is a disclosed relationship ending, which means the graph edge
// and the event arrive in the same document.

import { getJSON, getText } from "../mining/sec.mjs";

// Direction is the effect on the filer's DEPENDENTS, not on the filer's stock.
export const ITEMS = {
  "1.01": { label: "material agreement entered", direction: 1, weight: 3 },
  "1.02": { label: "material agreement terminated", direction: -1, weight: 4 },
  "1.03": { label: "bankruptcy or receivership", direction: -1, weight: 4 },
  "2.02": { label: "results of operations", direction: 0, weight: 2 },
  "2.05": { label: "exit or disposal costs", direction: -1, weight: 3 },
  "2.06": { label: "material impairment", direction: -1, weight: 3 },
  "3.01": { label: "delisting or listing-rule failure", direction: -1, weight: 3 },
  "4.02": { label: "financials no longer reliable", direction: -1, weight: 3 },
  // An officer leaving is material to the filer and says nothing about its
  // suppliers' demand. Neutral: only tradeable if a headline supplies direction.
  "5.02": { label: "senior officer departure", direction: 0, weight: 1 },
  "7.01": { label: "Regulation FD disclosure", direction: 0, weight: 1 },
  "8.01": { label: "other material event", direction: 0, weight: 1 },
};

/** Recent 8-K submissions for one company. */
export async function recent8Ks(cik, { sinceHours = 48 } = {}) {
  const padded = String(cik).padStart(10, "0");
  const sub = await getJSON(`https://data.sec.gov/submissions/CIK${padded}.json`);
  const r = sub.filings?.recent;
  if (!r) return [];

  const cutoff = Date.now() - sinceHours * 3600 * 1000;
  const out = [];

  for (let i = 0; i < r.form.length; i++) {
    if (!String(r.form[i]).startsWith("8-K")) continue;
    // acceptanceDateTime is when EDGAR received it — the tradeable moment.
    const at = r.acceptanceDateTime?.[i] ?? `${r.filingDate[i]}T12:00:00Z`;
    if (new Date(at).getTime() < cutoff) continue;

    const accession = r.accessionNumber[i];
    out.push({
      accession,
      form: r.form[i],
      at,
      filingDate: r.filingDate[i],
      // "1.01,1.02" when EDGAR has parsed the items for us.
      items: String(r.items?.[i] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      primaryDocument: r.primaryDocument?.[i] ?? null,
      cik: Number(cik),
      url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}/${r.primaryDocument?.[i] ?? ""}`,
    });
  }
  return out;
}

/** Fall back to reading the document when EDGAR's item list is empty. */
export async function itemsFromDocument(url) {
  try {
    const text = (await getText(url))
      .replace(/<[^>]+>/g, " ")
      .replace(/&#\d+;/g, " ")
      .replace(/\s+/g, " ");
    const found = new Set();
    for (const m of text.matchAll(/Item\s+(\d\.\d{2})/gi)) found.add(m[1]);
    return [...found];
  } catch {
    return [];
  }
}

/**
 * Turn an 8-K into a cascade event, or reject it.
 *
 * Rejection is normal and expected: most 8-Ks are routine. Returning a reason
 * keeps that visible in the journal rather than silent.
 */
export function classify(filing) {
  const known = filing.items.filter((i) => ITEMS[i]);
  if (!known.length) {
    return { material: false, reason: `items ${filing.items.join(",") || "none"} are not cascade-relevant` };
  }

  // The heaviest item decides; ties break toward the directional one.
  const ranked = known
    .map((i) => ({ item: i, ...ITEMS[i] }))
    .sort((a, b) => b.weight - a.weight || Math.abs(b.direction) - Math.abs(a.direction));
  const lead = ranked[0];

  // A neutral item (earnings, Reg FD) carries no direction of its own — the
  // headline or the price reaction has to supply it, so we leave it to triage.
  if (lead.direction === 0) {
    return { material: false, reason: `Item ${lead.item} (${lead.label}) has no inherent direction — needs a headline` };
  }

  return {
    material: true,
    item: lead.item,
    label: lead.label,
    direction: lead.direction,
    weight: lead.weight,
    reason: `Item ${lead.item} — ${lead.label}`,
    headline: `SEC 8-K Item ${lead.item}: ${lead.label}`,
  };
}

/** Watch every hub in the graph for fresh, material 8-Ks. */
export async function watch(hubs, { sinceHours = 48, seen = new Set() } = {}) {
  const events = [];
  const skipped = [];

  for (const { ticker, cik } of hubs) {
    if (!cik) continue;
    let filings = [];
    try { filings = await recent8Ks(cik, { sinceHours }); } catch { continue; }

    for (const f of filings) {
      if (seen.has(f.accession)) continue;
      if (!f.items.length && f.primaryDocument) f.items = await itemsFromDocument(f.url);

      const verdict = classify(f);
      if (!verdict.material) { skipped.push({ ticker, accession: f.accession, reason: verdict.reason }); continue; }

      events.push({
        source: "edgar-8k",
        id: f.accession,
        hub: ticker,
        at: f.at,
        headline: `${ticker}: ${verdict.headline}`,
        direction: verdict.direction,
        item: verdict.item,
        label: verdict.label,
        url: f.url,
        accession: f.accession,
      });
    }
  }
  return { events, skipped };
}
