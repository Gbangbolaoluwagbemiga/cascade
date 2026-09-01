// The Cascade daemon.
//
// This is the agent. It runs continuously, watches news on graph hubs, triages
// what is material, propagates the cascade, applies every gate, sizes what
// survives, trades it, and closes positions when the thesis arrives or breaks.
//
// Close the laptop and it keeps running. An agent that only thinks while a tab
// is open is a UI, not an actor.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { news, account, positions as openPositions, clock } from "./market/alpaca.mjs";
import { runCascade } from "./engine/cascade.mjs";
import { sizePositions, execute } from "./engine/execute.mjs";
import { triageEvent, adjudicate } from "./engine/triage.mjs";
import { exitVerdict } from "./market/residual.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DATA = path.join(ROOT, "data");
const JOURNAL = path.join(DATA, "journal.jsonl");
const SEEN = path.join(DATA, "seen-news.json");
const STATE = path.join(DATA, "daemon-state.json");

const POLL_MS = Number(process.env.POLL_MS || 5 * 60 * 1000);
const AUTO_TRADE = process.env.AUTO_TRADE === "true";
const MAX_CASCADES_PER_CYCLE = Number(process.env.MAX_CASCADES || 2);

const bootedAt = new Date();
let cycles = 0;

const load = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fallback; } };
const save = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2));

function journal(entry) {
  const line = { at: new Date().toISOString(), ...entry };
  fs.appendFileSync(JOURNAL, JSON.stringify(line) + "\n");
  const tag = entry.kind.toUpperCase().padEnd(10);
  console.log(`${line.at.slice(11, 19)}  ${tag} ${entry.summary ?? ""}`);
  return line;
}

function writeState(extra = {}) {
  save(STATE, {
    bootedAt: bootedAt.toISOString(),
    uptimeSeconds: Math.round((Date.now() - bootedAt) / 1000),
    cycles,
    pollMs: POLL_MS,
    autoTrade: AUTO_TRADE,
    llm: adj,
    lastCycleAt: new Date().toISOString(),
    ...extra,
  });
}

async function reviewExits(graph) {
  const held = await openPositions();
  if (!held.length) return;

  for (const p of held) {
    // Which cascade opened this? Find the hub this ticker depends on.
    const edge = graph.edges.find((e) => e.from === p.symbol);
    if (!edge) continue;
    const direction = p.side === "short" ? -1 : 1;

    let scored;
    try {
      const r = await runCascade({ graph, hub: edge.to, eventAt: new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10), direction, feed: "sip" });
      scored = r.considered.find((c) => c.ticker === p.symbol);
    } catch { continue; }
    if (!scored?.z && scored?.z !== 0) continue;

    const verdict = exitVerdict(scored.z, direction);
    if (!verdict.exit) continue;

    journal({
      kind: "exit", ticker: p.symbol, hub: edge.to, z: scored.z,
      pl: Number(p.unrealized_pl), dryRun: !AUTO_TRADE,
      summary: `${p.symbol} ${verdict.reason} — P/L $${Number(p.unrealized_pl).toFixed(2)}${AUTO_TRADE ? "" : " (dry run)"}`,
    });
    if (AUTO_TRADE) {
      const { closePosition } = await import("./market/alpaca.mjs");
      try { await closePosition(p.symbol); } catch (err) { journal({ kind: "error", summary: `close ${p.symbol} failed: ${err.message}` }); }
    }
  }
}

async function cycle() {
  cycles++;
  const graph = load(path.join(DATA, "graph.json"), null);
  if (!graph) { journal({ kind: "error", summary: "data/graph.json missing — run scripts/build-graph.mjs" }); return; }

  const hubs = graph.nodes.filter((n) => n.inDegree > 0).map((n) => n.ticker);
  const seen = new Set(load(SEEN, []));

  let k;
  try { k = await clock(); } catch (err) { journal({ kind: "error", summary: `clock: ${err.message}` }); return; }

  let items = [];
  try {
    items = await news(hubs, { start: new Date(Date.now() - 6 * 3600 * 1000).toISOString(), limit: 50 });
  } catch (err) { journal({ kind: "error", summary: `news: ${err.message}` }); return; }

  const fresh = items.filter((n) => !seen.has(n.id));
  const candidates = [];

  for (const n of fresh) {
    seen.add(n.id);
    const hub = (n.symbols || []).find((s) => hubs.includes(s));
    if (!hub) continue;
    const t = await triageEvent(n.headline, { hub, symbols: n.symbols, summary: n.summary });
    if (!t.material) continue;
    candidates.push({ ...n, hub, direction: t.direction ?? -1, triage: t });
  }
  save(SEEN, [...seen].slice(-4000));

  const engine = candidates[0]?.triage?.engine ?? triageEngine;
  journal({
    kind: "scan",
    summary: `${items.length} headlines · ${fresh.length} new · ${candidates.length} material (${engine}) · market ${k.is_open ? "open" : "closed"}`,
  });

  await reviewExits(graph);

  if (!candidates.length) { writeState({ lastScan: { headlines: items.length, material: 0 } }); return; }
  if (!k.is_open) {
    journal({ kind: "hold", summary: `${candidates.length} material events but market closed — will act at open` });
    writeState({ pending: candidates.length });
    return;
  }

  for (const c of candidates.slice(0, MAX_CASCADES_PER_CYCLE)) {
    journal({ kind: "event", hub: c.hub, headline: c.headline, direction: c.direction, url: c.url,
      triage: c.triage,
      summary: `${c.hub} ${c.direction < 0 ? "▼" : "▲"} ${c.headline.slice(0, 72)} — ${c.triage.engine}: ${c.triage.reason}` });

    let r;
    try {
      r = await runCascade({ graph, hub: c.hub, eventAt: c.at, direction: c.direction, feed: "sip", headline: c.headline });
    } catch (err) { journal({ kind: "error", summary: `cascade ${c.hub}: ${err.message}` }); continue; }
    if (r.error) { journal({ kind: "error", summary: r.error }); continue; }

    for (const ref of r.refusals)
      journal({ kind: "refusal", ticker: ref.ticker, hub: c.hub, gate: ref.gate,
        summary: `${ref.ticker} refused [${ref.gate}] ${ref.reason}` });

    if (!r.positions.length) { journal({ kind: "nothing", summary: `${c.hub}: nothing passed the gates` }); continue; }

    const acct = await account();
    const sized = sizePositions(r.positions.map((p) => ({ ...p, direction: c.direction })), Number(acct.equity));
    const orders = await execute(sized, { direction: c.direction, dryRun: !AUTO_TRADE });

    for (const o of orders)
      journal({ kind: "order", ticker: o.ticker, hub: c.hub, side: o.side, notional: o.notional,
        shares: o.shares ?? null, status: o.status, exposure: o.exposure, z: o.z,
        accession: o.accession, sourceUrl: o.sourceUrl,
        summary: `${o.side} ${o.ticker} ${o.shares ? o.shares + "sh" : "$" + o.notional} — ${(o.exposure * 100).toFixed(0)}% exposed via ${c.hub}, ${o.z.toFixed(2)}σ — ${o.status}` });
  }

  writeState({ lastScan: { headlines: items.length, material: candidates.length } });
}

// ── boot ─────────────────────────────────────────────────────────────────────
fs.mkdirSync(DATA, { recursive: true });
const adj = await adjudicate();
const triageEngine = adj.powered ? "grok" : "heuristic";

console.log(`\nCascade daemon`);
console.log(`  poll        every ${POLL_MS / 1000}s`);
console.log(`  trading     ${AUTO_TRADE ? "LIVE (paper account)" : "dry run — set AUTO_TRADE=true to submit"}`);
console.log(`  triage      ${adj.powered ? adj.triageModel : "heuristic classifier (no XAI_API_KEY)"}`);
console.log(`  adjudicator ${adj.powered ? adj.adjudicatorModel : "OFF — " + adj.reason}`);
journal({ kind: "boot", summary: `daemon up · triage=${triageEngine} · autoTrade=${AUTO_TRADE} · poll=${POLL_MS / 1000}s` });

await cycle().catch((e) => journal({ kind: "error", summary: e.message }));
setInterval(() => cycle().catch((e) => journal({ kind: "error", summary: e.message })), POLL_MS);
