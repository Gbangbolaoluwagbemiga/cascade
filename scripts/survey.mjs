// Naming-rate / tagging-rate survey.
//
// The question is no longer only "which sectors name counterparties in prose"
// but "which filers tag concentration as structured XBRL facts" — and whether
// that tracks sector at all, or tracks filer size and filing agent instead.
//
// Two control sectors are included that we expect to fail. If banks and
// utilities score as well as semis, the discriminator is broken and the
// ranking should not be trusted.

import fs from "node:fs";
import { latestAnnualReport, getFilingCached } from "../src/mining/sec.mjs";
import { sectorUniverse, sample } from "../src/mining/universe.mjs";
import { extractConcentrationFacts, factsToEdges } from "../src/mining/xbrl.mjs";
import { extractEvidence } from "../src/mining/extract.mjs";

const SECTORS = [
  { name: "Semiconductors", sic: 3674 },
  { name: "Semicap / industry machinery", sic: 3559 },
  { name: "Auto parts", sic: 3714 },
  { name: "Aerospace parts", sic: 3728 },
  { name: "Pharma preparations", sic: 2834 },
  { name: "Lab / analytical instruments", sic: 3826 },
  { name: "EMS / printed circuit boards", sic: 3672 },
  { name: "Household & personal products", sic: 2844 },
  { name: "Food products", sic: 2000 },
  { name: "CONTROL: state banks", sic: 6022 },
  { name: "CONTROL: electric utilities", sic: 4911 },
];

const PER_SECTOR = Number(process.env.PER_SECTOR || 25);
const OUT = new URL("../data/survey.jsonl", import.meta.url);
fs.mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
fs.writeFileSync(OUT, "");

const rows = [];

for (const sector of SECTORS) {
  let universe = [];
  try {
    universe = await sectorUniverse(sector.sic, { max: 200 });
  } catch (err) {
    console.error(`[${sector.name}] universe failed: ${err.message}`);
    continue;
  }
  const picked = sample(universe, PER_SECTOR);
  console.error(`[${sector.name}] listed=${universe.length} sampling=${picked.length}`);

  for (const ticker of picked) {
    const row = { sector: sector.name, sic: sector.sic, ticker };
    try {
      const filing = await latestAnnualReport(ticker);
      if (!filing) {
        row.status = "no-annual-report";
        rows.push(row);
        fs.appendFileSync(OUT, JSON.stringify(row) + "\n");
        continue;
      }
      Object.assign(row, {
        status: "ok",
        company: filing.company,
        form: filing.form,
        filingDate: filing.filingDate,
        filerCategory: filing.filerCategory,
        filingAgentCik: filing.filingAgentCik,
      });

      const html = await getFilingCached(filing.url);

      const x = extractConcentrationFacts(html);
      const edges = factsToEdges(x.facts, { from: ticker });
      row.xbrlNamedEdges = edges.length;
      row.xbrlAnonymous = x.anonymous.length;
      row.xbrlAggregate = x.aggregate.length;
      row.xbrlNonCustomer = x.nonCustomer.length;
      row.xbrlSuspect = x.suspect.length;
      row.xbrlEmpty = x.empty.length;
      row.xbrlAnyCustomerTagging =
        x.facts.length + x.anonymous.length + x.aggregate.length > 0;
      row.counterparties = edges.map((e) => e.counterparty).slice(0, 8);
      row.maxShare = edges.length ? Math.max(...edges.map((e) => e.magnitude)) : null;
      row.fiscalPeriodEnd = edges[0]?.fiscalPeriodEnd ?? null;

      const ev = await extractEvidence(html, { self: ticker });
      row.htmlAnyDisclosure = ev.hasDisclosure;
      row.htmlNamed = ev.namedConfident.length;
      row.htmlNamedQuantified = ev.namedQuantified.length;
    } catch (err) {
      row.status = "error";
      row.error = err.message;
    }
    rows.push(row);
    fs.appendFileSync(OUT, JSON.stringify(row) + "\n");
    process.stderr.write(
      `  ${row.ticker.padEnd(6)} xbrl=${row.xbrlNamedEdges ?? "-"} anon=${row.xbrlAnonymous ?? "-"} html=${row.htmlNamedQuantified ?? "-"} ${row.status}\n`
    );
  }
}

// ---- summary ----------------------------------------------------------------
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(0)}%` : "—");
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

console.log("\n\n=== SURVEY RESULTS ===\n");
console.log(
  ["Sector", "n", "XBRL tagged", "XBRL named", "anon only", "HTML n+q", "med edges", "med FY"]
    .map((h, i) => (i === 0 ? h.padEnd(30) : h.padStart(12)))
    .join("")
);

const bySector = new Map();
for (const r of rows) {
  if (!bySector.has(r.sector)) bySector.set(r.sector, []);
  bySector.get(r.sector).push(r);
}

for (const [name, rs] of bySector) {
  const ok = rs.filter((r) => r.status === "ok");
  const tagged = ok.filter((r) => r.xbrlAnyCustomerTagging);
  const named = ok.filter((r) => r.xbrlNamedEdges > 0);
  const anonOnly = ok.filter((r) => r.xbrlNamedEdges === 0 && r.xbrlAnonymous > 0);
  const htmlNQ = ok.filter((r) => r.htmlNamedQuantified > 0);
  const years = ok.map((r) => r.fiscalPeriodEnd).filter(Boolean).map((d) => d.slice(0, 4));
  console.log(
    [
      name.slice(0, 29).padEnd(30),
      String(ok.length).padStart(12),
      pct(tagged.length, ok.length).padStart(12),
      pct(named.length, ok.length).padStart(12),
      pct(anonOnly.length, ok.length).padStart(12),
      pct(htmlNQ.length, ok.length).padStart(12),
      String(median(named.map((r) => r.xbrlNamedEdges))).padStart(12),
      (years.sort().at(Math.floor(years.length / 2)) || "—").padStart(12),
    ].join("")
  );
}

// Does tagging track filer size / filing agent more than sector?
const group = (key) => {
  const m = new Map();
  for (const r of rows.filter((x) => x.status === "ok")) {
    const k = r[key] || "unknown";
    if (!m.has(k)) m.set(k, { n: 0, named: 0 });
    const g = m.get(k);
    g.n++;
    if (r.xbrlNamedEdges > 0) g.named++;
  }
  return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
};

console.log("\n--- named-edge rate by filer category ---");
for (const [k, g] of group("filerCategory")) console.log(`  ${String(k).padEnd(28)} n=${String(g.n).padStart(3)}  ${pct(g.named, g.n)}`);

console.log("\n--- named-edge rate by filing agent (accession prefix), n>=8 ---");
for (const [k, g] of group("filingAgentCik")) if (g.n >= 8) console.log(`  ${String(k).padEnd(28)} n=${String(g.n).padStart(3)}  ${pct(g.named, g.n)}`);

const suspects = rows.filter((r) => r.xbrlSuspect > 0);
console.log(`\nscale-suspect facts rejected on ${suspects.length} filers: ${suspects.map((r) => r.ticker).join(", ") || "none"}`);
console.log(`\nrows written: ${rows.length} -> data/survey.jsonl`);
