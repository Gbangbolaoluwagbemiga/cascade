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
import { sizePositions, execute, OPTION_EXITS, portfolioHeadroom, deployedCapital } from "./engine/execute.mjs";
import { triageEvent, adjudicate } from "./engine/triage.mjs";
import { shockTravels } from "./llm/client.mjs";
import * as telegram from "./notify/telegram.mjs";
import { startCommandLoop } from "./notify/commands.mjs";
import { exitVerdict } from "./market/residual.mjs";
import * as ledger from "./engine/ledger.mjs";
import { watch as watch8K } from "./events/edgar8k.mjs";
import { tickerMap } from "./mining/sec.mjs";

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
let adj = { powered: false, reason: "not started" };
let paused = false;
let triageEngine = "heuristic";

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
    const isOption = p.asset_class === "us_option";

    // Options decay. The residual test alone can hold a long put until it is
    // worthless, or give back a large gain waiting for a 2σ move that never
    // comes. Bank winners, cap losers, and never ride into the expiry cliff.
    if (isOption) {
      const plpc = Number(p.unrealized_plpc);
      const thesisRecord = ledger.get(p.symbol);
      const daysLeft = thesisRecord?.expiry
        ? Math.round((new Date(thesisRecord.expiry) - Date.now()) / 864e5)
        : null;

      let optionExit = null;
      if (plpc >= OPTION_EXITS.takeProfit) optionExit = `took profit at ${(plpc * 100).toFixed(0)}%`;
      else if (plpc <= OPTION_EXITS.stopLoss) optionExit = `stopped out at ${(plpc * 100).toFixed(0)}%`;
      else if (daysLeft != null && daysLeft <= OPTION_EXITS.minDaysLeft) optionExit = `${daysLeft}d to expiry — closing before the cliff`;

      if (optionExit) {
        journal({ kind: "exit", ticker: p.symbol, instrument: "option",
          pl: Number(p.unrealized_pl), plpc,
          summary: `${p.symbol} ${optionExit} — P/L $${Number(p.unrealized_pl).toFixed(2)}${AUTO_TRADE ? "" : " (dry run)"}` });
        if (AUTO_TRADE) {
          const { closePosition } = await import("./market/alpaca.mjs");
          try { await closePosition(p.symbol); ledger.forget(p.symbol); } catch (err) {
            journal({ kind: "error", summary: `close ${p.symbol} failed: ${err.message}` });
          }
        }
        continue;
      }
    }
    // The underlying for an OCC symbol: leading alpha before the date block.
    const underlying = isOption ? (p.symbol.match(/^([A-Z]+)\d{6}[CP]\d{8}$/)?.[1] ?? p.symbol) : p.symbol;

    // The thesis that opened this position, not whichever edge sorts first.
    const thesis = ledger.get(p.symbol) ?? ledger.inferFromGraph(graph, p.symbol, underlying);
    if (!thesis) continue;

    const direction = thesis.direction ?? (p.side === "short" ? -1 : 1);

    let scored;
    try {
      const r = await runCascade({
        graph, hub: thesis.hub,
        eventAt: thesis.openedAt ?? new Date(Date.now() - 7 * 864e5).toISOString(),
        direction, feed: "sip",
      });
      scored = r.considered.find((c) => c.ticker === underlying);
    } catch { continue; }
    if (scored?.z == null) continue;

    const verdict = exitVerdict(scored.z, direction);
    if (!verdict.exit) continue;

    journal({
      kind: "exit", ticker: p.symbol, underlying, hub: thesis.hub, z: scored.z,
      pl: Number(p.unrealized_pl), instrument: isOption ? "option" : "share",
      inferred: Boolean(thesis.inferred), dryRun: !AUTO_TRADE,
      summary: `${p.symbol} ${verdict.reason} — P/L $${Number(p.unrealized_pl).toFixed(2)}${thesis.inferred ? " (thesis inferred)" : ""}${AUTO_TRADE ? "" : " (dry run)"}`,
    });

    telegram.positionClosed({ ticker: p.symbol, hub: thesis.hub, reason: verdict.reason, pl: Number(p.unrealized_pl) }).catch(() => {});

    if (AUTO_TRADE) {
      const { closePosition } = await import("./market/alpaca.mjs");
      try { await closePosition(p.symbol); ledger.forget(p.symbol); }
      catch (err) { journal({ kind: "error", summary: `close ${p.symbol} failed: ${err.message}` }); }
    }
  }
}

/**
 * Close everything at a wall-clock deadline.
 *
 * A cascade thesis resolves when the residual arrives — which may be after the
 * competition ends. Without this the run finishes holding floating positions
 * whose value is whatever the last tick happened to be. FLATTEN_AT converts the
 * book to a realised number before that.
 */
async function flattenIfDue() {
  const at = process.env.FLATTEN_AT;
  if (!at) return false;
  const due = new Date(at);
  if (Number.isNaN(due.getTime()) || Date.now() < due.getTime()) return false;

  const held = await openPositions();
  if (!held.length) return true;

  journal({ kind: "flatten", summary: `deadline ${at} reached — closing ${held.length} position${held.length > 1 ? "s" : ""}` });
  if (!AUTO_TRADE) { journal({ kind: "flatten", summary: "dry run — nothing closed" }); return true; }

  const { closePosition } = await import("./market/alpaca.mjs");
  for (const p of held) {
    try {
      await closePosition(p.symbol);
      ledger.forget(p.symbol);
      journal({ kind: "exit", ticker: p.symbol, pl: Number(p.unrealized_pl),
        summary: `${p.symbol} closed at deadline — P/L $${Number(p.unrealized_pl).toFixed(2)}` });
    } catch (err) {
      journal({ kind: "error", summary: `flatten ${p.symbol} failed: ${err.message}` });
    }
  }
  return true;
}

async function cycle() {
  cycles++;
  const graph = load(path.join(DATA, "graph.json"), null);
  if (!graph) { journal({ kind: "error", summary: "data/graph.json missing — run scripts/build-graph.mjs" }); return; }

  const hubs = graph.nodes.filter((n) => n.inDegree > 0).map((n) => n.ticker);
  const seen = new Set(load(SEEN, []));

  // A transient network blip must not cost a whole cycle. Retry once, then fall
  // back to a time-of-day estimate rather than skipping the scan entirely —
  // aborting here meant four consecutive missed scans on one flaky evening.
  let k = null;
  for (let attempt = 0; attempt < 2 && !k; attempt++) {
    try { k = await clock(); }
    catch { if (attempt === 0) await new Promise((r) => setTimeout(r, 2000)); }
  }
  if (!k) {
    const now = new Date();
    const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const minutes = et.getHours() * 60 + et.getMinutes();
    const weekday = et.getDay() >= 1 && et.getDay() <= 5;
    k = { is_open: weekday && minutes >= 570 && minutes < 960, estimated: true };
    journal({ kind: "degraded", summary: `clock unreachable — assuming market ${k.is_open ? "open" : "closed"} from the clock` });
  }

  let items = [];
  try {
    items = await news(hubs, { start: new Date(Date.now() - 6 * 3600 * 1000).toISOString(), limit: 50 });
  } catch (err) {
    journal({ kind: "degraded", summary: `news feed unavailable (${String(err.message).slice(0, 40)}) — continuing on 8-K only` });
  }

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
  // Second source: the filers' own 8-Ks. A headline is somebody's judgement
  // that something mattered; an 8-K is the company's own, with a numbered item
  // saying what kind of event it was.
  try {
    const map = await tickerMap();
    const hubList = hubs.map((t) => ({ ticker: t, cik: map.get(t)?.cik }));
    const { events: filings } = await watch8K(hubList, { sinceHours: 36, seen });
    for (const f of filings) {
      seen.add(f.id);
      candidates.push({
        ...f, symbols: [f.hub],
        triage: { material: true, direction: f.direction, engine: "edgar-8k",
          reason: `Item ${f.item} — ${f.label}`, confidence: 0.9 },
      });
    }
    if (filings.length) journal({ kind: "scan", summary: `${filings.length} material 8-K${filings.length > 1 ? "s" : ""} on graph hubs` });
  } catch (err) {
    journal({ kind: "error", summary: `8-K watch: ${err.message.slice(0, 90)}` });
  }

  save(SEEN, [...seen].slice(-4000));

  const engine = candidates[0]?.triage?.engine ?? triageEngine;
  journal({
    kind: "scan",
    summary: `${items.length} headlines · ${fresh.length} new · ${candidates.length} material (${engine}) · market ${k.is_open ? "open" : "closed"}`,
  });

  if (await flattenIfDue()) { writeState({ flattened: true }); return; }

  await reviewExits(graph);

  if (!candidates.length) { writeState({ lastScan: { headlines: items.length, material: 0 } }); return; }
  if (!k.is_open) {
    journal({ kind: "hold", summary: `${candidates.length} material events but market closed — will act at open` });
    writeState({ pending: candidates.length });
    return;
  }

  if (paused) {
    journal({ kind: "hold", summary: `paused — ${candidates.length} material event${candidates.length > 1 ? "s" : ""} not acted on` });
    writeState({ paused: true, pending: candidates.length });
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

    // Final gate, and the one no price check can perform: does THIS shock
    // travel down THIS kind of edge? An App Store fee change reaches Duolingo;
    // an iPhone recall does not. Only runs on events that already survived
    // triage and every cheap gate, so the expensive model stays cheap.
    let survivors = r.positions;
    if (adj.powered) {
      survivors = [];
      for (const p of r.positions) {
        try {
          const t = await shockTravels({
            headline: c.headline, relationshipType: p.relationshipType,
            from: p.ticker, to: c.hub,
          });
          if (t.travels) { survivors.push(p); continue; }
          journal({ kind: "refusal", ticker: p.ticker, hub: c.hub, gate: "shock_type",
            summary: `${p.ticker} refused [shock_type] ${t.reason} (${p.relationshipType} edge)` });
        } catch (err) {
          // A model failure must not silently pass a trade through.
          journal({ kind: "refusal", ticker: p.ticker, hub: c.hub, gate: "shock_type",
            summary: `${p.ticker} refused [shock_type] adjudication failed: ${err.message.slice(0, 70)}` });
        }
      }
      if (!survivors.length) { journal({ kind: "nothing", summary: `${c.hub}: no edge transmits this kind of shock` }); continue; }
    }

    const acct = await account();
    const room = await portfolioHeadroom(Number(acct.equity));
    if (!room.ok) {
      journal({ kind: "refusal", hub: c.hub, gate: "portfolio_cap", summary: `${c.hub} cascade refused [portfolio_cap] ${room.reason}` });
      continue;
    }
    const sized = sizePositions(
      survivors.map((p) => ({ ...p, direction: c.direction })),
      Number(acct.equity),
      { deployed: room.deployed },
    );
    const orders = await execute(sized, { direction: c.direction, dryRun: !AUTO_TRADE });

    // Fire-and-forget: a notification failure must never affect a trade that
    // has already happened.
    telegram.cascadeFired({
      hub: c.hub, headline: c.headline, direction: c.direction,
      orders, refusals: r.refusals, timeframe: r.timeframe,
    }).catch(() => {});

    for (const o of orders)
      journal({ kind: "order", ticker: o.ticker, hub: c.hub, side: o.side, notional: o.notional,
        shares: o.shares ?? null, status: o.status, exposure: o.exposure, z: o.z,
        accession: o.accession, sourceUrl: o.sourceUrl,
        summary: `${o.side} ${o.ticker} ${o.shares ? o.shares + "sh" : "$" + o.notional} — ${(o.exposure * 100).toFixed(0)}% exposed via ${c.hub}, ${o.z.toFixed(2)}σ — ${o.status}` });
  }

  writeState({ lastScan: { headlines: items.length, material: candidates.length } });
}

// ── boot ─────────────────────────────────────────────────────────────────────
let started = false;

/**
 * Start the agent loop. Exported so a single process can serve the web app and
 * run the daemon together — one Railway service, one health endpoint, nothing
 * to keep in sync. `npm run daemon` runs it standalone.
 */
export async function startDaemon({ quiet = false } = {}) {
  if (started) return { alreadyRunning: true };
  started = true;

  fs.mkdirSync(DATA, { recursive: true });
  const adjudicator = await adjudicate();
  adj = adjudicator;
  triageEngine = adjudicator.powered ? adjudicator.provider : "heuristic";

  if (!quiet) {
    console.log(`\nCascade daemon`);
    console.log(`  poll        every ${POLL_MS / 1000}s`);
    console.log(`  trading     ${AUTO_TRADE ? "LIVE (paper account)" : "dry run — set AUTO_TRADE=true to submit"}`);
    console.log(`  triage      ${adjudicator.powered ? adjudicator.triageModel : "heuristic classifier (no LLM key)"}`);
    console.log(`  adjudicator ${adjudicator.powered ? adjudicator.adjudicatorModel : "OFF — " + adjudicator.reason}`);
    console.log(`  telegram    ${telegram.configured() ? "on" : "off (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)"}`);
  }

  let edgeCount = 0;
  try { edgeCount = JSON.parse(fs.readFileSync(path.join(DATA, "graph.json"), "utf8")).edgeCount; } catch {}

  journal({ kind: "boot", summary: `daemon up · triage=${triageEngine} · autoTrade=${AUTO_TRADE} · poll=${POLL_MS / 1000}s · telegram=${telegram.configured() ? "on" : "off"}` });
  telegram.daemonUp({
    triageModel: adjudicator.triageModel, adjudicatorModel: adjudicator.adjudicatorModel,
    edges: edgeCount, autoTrade: AUTO_TRADE,
  }).catch(() => {});

  // Telegram command surface. Read-only plus pause/resume and /trade, which
  // runs the real cascade with every gate applied — a human chooses when to
  // look, never what to buy.
  if (telegram.configured()) {
    const started = startCommandLoop({
      graph: load(path.join(DATA, "graph.json"), { edges: [], nodes: [], edgeCount: 0, nodeCount: 0 }),
      llm: adjudicator,
      autoTrade: AUTO_TRADE,
      paused: () => paused,
      setPaused: (v) => { paused = v; journal({ kind: "control", summary: v ? "paused via telegram" : "resumed via telegram" }); },
      journal: () => {
        try {
          return fs.readFileSync(JOURNAL, "utf8").split("\n").filter(Boolean)
            .map((l) => { try { return JSON.parse(l); } catch { return null; } })
            .filter(Boolean).reverse();
        } catch { return []; }
      },
    });
    if (!quiet) console.log(`  commands    ${started ? "listening" : "off"}`);
  }

  const tick = () => cycle().catch((e) => journal({ kind: "error", summary: e.message }));
  await tick();
  const timer = setInterval(tick, POLL_MS);
  timer.unref?.();
  return { started: true, adjudicator };
}

// Run standalone when invoked directly (npm run daemon).
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  await startDaemon();
  // Keep the process alive; the interval is unref'd so it would otherwise exit.
  setInterval(() => {}, 1 << 30);
}
