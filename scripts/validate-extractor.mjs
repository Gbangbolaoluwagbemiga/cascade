// Validation, not survey. These are filers chosen *because* we expect a hit.
// A zero here is a bug in the extractor until proven otherwise.
//
//   UCTT, ICHR  — semicap, known to name Lam and Applied Materials
//   VC, LEA, APTV — auto suppliers, suspected to tabulate rather than narrate
//   SPR         — aerospace, Boeing is an overwhelming share of revenue
//   AEIS, COHU  — known-anonymous controls; expect disclosure, expect no name

import { latestAnnualReport, getText } from "../src/mining/sec.mjs";
import { extractEvidence } from "../src/mining/extract.mjs";

const EXPECT = {
  UCTT: "named+quantified",
  ICHR: "named+quantified",
  VC: "unknown — the table test",
  LEA: "unknown — the table test",
  APTV: "unknown — the table test",
  SPR: "unknown — aerospace",
  AEIS: "anonymous only (control)",
  COHU: "aggregate only (control)",
};

for (const ticker of Object.keys(EXPECT)) {
  let filing;
  try {
    filing = await latestAnnualReport(ticker);
  } catch (err) {
    console.log(`\n### ${ticker}  ERROR ${err.message}`);
    continue;
  }
  if (!filing) { console.log(`\n### ${ticker}  no 10-K/20-F on file`); continue; }

  const html = await getText(filing.url);
  const ev = await extractEvidence(html, { self: ticker });

  const tier = ev.namedQuantified.length ? "NAMED+QUANTIFIED"
             : ev.namedConfident.length ? "NAMED, no share"
             : ev.hasDisclosure ? "ANONYMOUS only"
             : "NOTHING";

  console.log(`\n### ${ticker} — ${filing.company}`);
  console.log(`    expected : ${EXPECT[ticker]}`);
  console.log(`    got      : ${tier}`);
  console.log(`    ${filing.form} ${filing.filingDate}  prose=${ev.proseCount} tableRows=${ev.tableRowCount}`);

  for (const n of ev.namedConfident.slice(0, 5)) {
    const pct = n.percentages.length ? n.percentages.slice(0, 4).join("%, ") + "%" : "no share";
    const per = n.periods?.filter(Boolean).slice(0, 4).join(" | ") || "no period";
    console.log(`      → ${n.ticker.padEnd(6)} "${n.counterparty}"  [${n.source}]  ${pct}`);
    if (n.source === "table") console.log(`         periods: ${per}`);
  }
  if (ev.namedAmbiguous.length) console.log(`      (ambiguous, held back: ${ev.namedAmbiguous.map((n) => n.ticker).join(", ")})`);
  if (!ev.namedConfident.length && ev.hasDisclosure) {
    const p = ev.passages[0];
    if (p) console.log(`      (anonymous) …${p.text.slice(0, 200)}…`);
  }
}
