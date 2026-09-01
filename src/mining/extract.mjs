// Concentration-disclosure extraction from a 10-K / 20-F.
//
// Two surfaces, because filers use both and a prose-only extractor silently
// under-reports every filer that tabulates:
//   - prose  : "two customers ... accounted for a combined 76% of total sales"
//   - tables : a row labelled "Lam Research Corporation" with a % per column
//
// Tables are parsed structurally. Flattening them loses the column headers, so
// "37.0 31.9 34.0" arrives with no way to know which fiscal year each belongs
// to — a hit that looks clean and carries the wrong year.

import * as cheerio from "cheerio";
import { resolveNamesIn } from "./resolve.mjs";

// Inline XBRL wraps tagged facts in elements. Once tags are stripped the number
// and its percent sign are separated: "approximately 46 %". \s* is mandatory.
const PCT = String.raw`\d{1,3}(?:\.\d+)?\s*%`;

const PROSE_PATTERNS = [
  new RegExp(String.raw`accounted for (?:approximately |a combined |more than |over |in excess of )*${PCT}`, "gi"),
  new RegExp(String.raw`represented (?:approximately |a combined |more than |over )*${PCT}`, "gi"),
  new RegExp(String.raw`${PCT} of (?:our |the |total |net |consolidated |combined )*(?:revenue|revenues|sales|net sales|net revenue)`, "gi"),
  /concentration(?:s)? of credit risk/gi,
  /(?:no|one|two|three|four|five|ten) (?:or more )?customers? (?:individually |collectively |combined )?(?:accounted|represented|comprised)/gi,
  /(?:our|the) (?:largest|top|principal|significant|major) customers?/gi,
  // Named-but-unquantified customer lists ("our customers include General
  // Motors, Ford, ..."). These yield an edge with a null magnitude, which the
  // schema treats as untradeable — but they still belong in the survey, since
  // "names a counterparty" and "quantifies the share" are separate metrics.
  /customers? (?:include|included|including)/gi,
  /(?:sales|revenue)s? (?:to|from) (?:our )?(?:largest|principal|major)/gi,
];

const CONCENTRATION_CUES = /customer|concentration|revenue|sales|supplier|segment/i;

export function parseFiling(html) {
  const $ = cheerio.load(html);
  $("script, style").remove();

  const tables = [];
  $("table").each((_, el) => {
    const rows = [];
    $(el).find("tr").each((__, tr) => {
      const cells = [];
      $(tr).find("th, td").each((___, td) => {
        cells.push($(td).text().replace(/ /g, " ").replace(/\s+/g, " ").trim());
      });
      // Filers pad tables heavily with empty spacer cells.
      const meaningful = cells.filter((c) => c !== "");
      if (meaningful.length) rows.push(cells);
    });
    if (rows.length >= 2) tables.push(rows);
  });

  // Prose = document text with tables removed, so table numerals do not leak in
  // and masquerade as sentences.
  $("table").remove();
  const prose = $.root().text().replace(/ /g, " ").replace(/\s+/g, " ").trim();

  return { prose, tables };
}

export function findProsePassages(prose, { window = 320 } = {}) {
  const seen = new Set();
  const passages = [];
  for (const pattern of PROSE_PATTERNS) {
    for (const match of prose.matchAll(pattern)) {
      const start = Math.max(0, match.index - window);
      const end = Math.min(prose.length, match.index + match[0].length + window);
      const text = prose.slice(start, end).trim();
      const key = text.slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);
      passages.push({ text, trigger: match[0].trim(), offset: match.index });
    }
  }
  return passages;
}

const pctCell = (c) => /^\(?\d{1,3}(?:\.\d+)?\s*%\)?$/.test(c.trim());
const pctValue = (c) => Number(c.replace(/[^\d.]/g, ""));

/**
 * EDGAR routinely splits a percentage across two cells — "37.0" in one, "%" in
 * the next — so a per-cell test sees neither a number nor a percentage. Merge
 * them back before any row analysis, preserving column position by leaving the
 * consumed cell in place as empty (the header alignment indexes off it).
 */
function mergeSplitPercents(row) {
  const out = [...row];
  for (let i = 0; i < out.length - 1; i++) {
    const here = out[i].trim();
    const next = out[i + 1].trim();
    if (/^\(?\d{1,3}(?:\.\d+)?\)?$/.test(here) && next === "%") {
      out[i] = `${here}%`;
      out[i + 1] = "";
    }
  }
  return out;
}

/**
 * Rows that pair a text label with percentage cells, with the header row kept
 * so each percentage retains the period it belongs to.
 */
export function findTableRows(tables) {
  const results = [];

  for (const rawRows of tables) {
    const rows = rawRows.map(mergeSplitPercents);
    const flat = rows.flat().join(" ");
    if (!CONCENTRATION_CUES.test(flat)) continue;
    if (!rows.some((r) => r.some(pctCell))) continue;

    // The header is the first row carrying period-ish text and no percentages.
    let header = null;
    for (const row of rows.slice(0, 4)) {
      const nonEmpty = row.filter((c) => c !== "");
      if (!nonEmpty.length || nonEmpty.some(pctCell)) continue;
      if (nonEmpty.some((c) => /\d{4}|year|month|period|ended/i.test(c))) { header = row; break; }
    }

    for (const row of rows) {
      const label = row.find((c) => c && !pctCell(c) && /[A-Za-z]{3,}/.test(c));
      if (!label) continue;
      const pctIdx = row.map((c, i) => (pctCell(c) ? i : -1)).filter((i) => i >= 0);
      if (!pctIdx.length) continue;

      const values = pctIdx.map((i) => ({
        value: pctValue(row[i]),
        // Align to the header cell in the same column when one exists; null
        // rather than a guess when the columns do not line up.
        period: header?.[i]?.trim() || null,
      }));
      results.push({ label: label.trim(), values, row });
    }
  }
  return results;
}

/**
 * Tiering, per the two-tier model:
 *   named      -> a counterparty resolved to a listed ticker (a graph edge)
 *   quantified -> that counterparty carries a share figure (edge weight)
 *   anonymous  -> concentration disclosed without a resolvable name
 *                 (node fragility attribute, never an edge)
 */
export async function extractEvidence(html, { self = null } = {}) {
  const { prose, tables } = parseFiling(html);
  const passages = findProsePassages(prose);
  const rows = findTableRows(tables);

  const named = [];

  for (const p of passages) {
    const hits = await resolveNamesIn(p.text, { self });
    const pcts = [...p.text.matchAll(new RegExp(PCT, "g"))].map((m) => Number(m[0].replace(/[^\d.]/g, "")));
    for (const h of hits) {
      named.push({
        source: "prose",
        counterparty: h.surface,
        ticker: h.ticker,
        ambiguous: h.ambiguous,
        percentages: pcts,
        quantified: pcts.length > 0,
        quote: p.text,
      });
    }
  }

  for (const r of rows) {
    const hits = await resolveNamesIn(r.label, { self });
    for (const h of hits) {
      named.push({
        source: "table",
        counterparty: h.surface,
        ticker: h.ticker,
        ambiguous: h.ambiguous,
        percentages: r.values.map((v) => v.value),
        periods: r.values.map((v) => v.period),
        quantified: r.values.length > 0,
        quote: r.row.filter(Boolean).join(" | "),
      });
    }
  }

  const byTicker = new Map();
  for (const n of named) {
    const prev = byTicker.get(n.ticker);
    // A table row beats a prose mention: it carries period alignment.
    if (!prev || (n.source === "table" && prev.source !== "table")) byTicker.set(n.ticker, n);
  }

  return {
    hasDisclosure: passages.length > 0 || rows.length > 0,
    proseCount: passages.length,
    tableRowCount: rows.length,
    named: [...byTicker.values()],
    namedConfident: [...byTicker.values()].filter((n) => !n.ambiguous),
    namedQuantified: [...byTicker.values()].filter((n) => n.quantified && !n.ambiguous),
    namedAmbiguous: [...byTicker.values()].filter((n) => n.ambiguous),
    passages,
    rows,
  };
}
