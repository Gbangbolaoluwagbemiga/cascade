// Assign relationship_type to every edge, once, using Grok.
//
// This runs at ingest and never at trade time — the daemon must not be waiting
// on a model to decide what an edge means while an event is live. Types are
// written back into data/graph.json with the model, confidence and reason, so
// the classification is auditable rather than a black box.
//
// Rivian tags Chase Bank at 36% of revenue as "customer concentration". It is a
// real dependency and a real citation, but Chase originates Rivian's retail
// financing — a tariff does not travel that edge, a lender leaving auto lending
// does. Getting that wrong fires trades on the wrong events.

import fs from "node:fs";
import { adjudicateEdge, resolveModels, stats } from "../src/llm/client.mjs";

const models = await resolveModels();
if (!models.ok) {
  console.error(`\n  ${models.reason}\n`);
  console.error("  Edges keep their heuristic type hint until a key is present.");
  console.error("  Nothing is guessed in the meantime — the daemon reports the adjudicator as off.\n");
  process.exit(2);
}

const graph = JSON.parse(fs.readFileSync("data/graph.json", "utf8"));
const force = process.argv.includes("--force");
const todo = graph.edges.filter((e) => force || e.typeSource !== "llm");

console.log(`adjudicating ${todo.length} of ${graph.edges.length} edges`);
console.log(`provider ${models.provider} · model ${models.adjudicator.id} [${models.adjudicator.source}]\n`);

let changed = 0;
const PACE_MS = Number(process.env.ADJUDICATE_PACE_MS || 1200);

for (const e of todo) {
  await new Promise((r) => setTimeout(r, PACE_MS));
  try {
    const r = await adjudicateEdge({
      from: e.from, to: e.to, disclosedAs: e.disclosedAs,
      magnitude: e.magnitude, toCompany: e.toCompany,
    });
    const before = e.relationshipType;
    e.relationshipType = r.relationshipType;
    e.typeSource = "llm";
    e.typeModel = r.model;
    e.typeConfidence = r.confidence;
    e.typeReason = r.reason;
    if (before !== r.relationshipType) {
      changed++;
      console.log(`  ${e.from} → ${e.to}   ${before} → ${r.relationshipType}   (${r.confidence.toFixed(2)})  ${r.reason}`);
    } else {
      console.log(`  ${e.from} → ${e.to}   ${r.relationshipType} confirmed   (${r.confidence.toFixed(2)})`);
    }
  } catch (err) {
    console.log(`  ${e.from} → ${e.to}   FAILED — ${err.message.slice(0, 90)}  (keeps "${e.relationshipType}")`);
  }
}

graph.adjudicatedAt = new Date().toISOString();
fs.writeFileSync("data/graph.json", JSON.stringify(graph, null, 2));

const byType = {};
for (const e of graph.edges) byType[e.relationshipType] = (byType[e.relationshipType] || 0) + 1;

console.log(`\n${changed} reclassified`);
console.log("edges by type:", byType);
console.log("llm usage:", stats());
