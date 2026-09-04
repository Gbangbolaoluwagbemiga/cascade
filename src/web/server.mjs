// Cascade web server. No framework — node http, so the deploy has no surprises.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { structuralScreen, runCascade, GATES } from "../engine/cascade.mjs";
import { sizePositions, execute, portfolioHeadroom } from "../engine/execute.mjs";
import { credentials, account, positions, news, clock, orders } from "../market/alpaca.mjs";
import { adjudicate } from "../engine/triage.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PUBLIC = fileURLToPath(new URL("./public/", import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const BOOTED_AT = new Date();

// Build marker from day one: a health endpoint that proves which code is live.
//
// Railway builds from a tarball with no .git directory, so `git rev-parse`
// returns nothing there and the marker read "unversioned" — useless for the one
// job it has. Platform-injected SHAs are checked first, git only as a local
// fallback.
const COMMIT = (
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.SOURCE_COMMIT ||
  process.env.GIT_COMMIT ||
  (() => {
    try {
      return execSync("git rev-parse HEAD", { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch { return ""; }
  })()
).slice(0, 7) || "unversioned";

const DEPLOY = {
  env: process.env.RAILWAY_ENVIRONMENT_NAME ?? null,
  service: process.env.RAILWAY_SERVICE_NAME ?? null,
  region: process.env.RAILWAY_REPLICA_REGION ?? null,
  branch: process.env.RAILWAY_GIT_BRANCH ?? null,
};

const loadGraph = () => JSON.parse(fs.readFileSync(path.join(ROOT, "data/graph.json"), "utf8"));

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  // Buffers must pass through untouched. JSON.stringify turns a Buffer into
  // {"type":"Buffer","data":[60,33,...]}, which is exactly what the browser
  // rendered instead of the page.
  if (Buffer.isBuffer(body) || typeof body === "string") return res.end(body);
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === "/healthz") {
      let graph = null;
      try { const g = loadGraph(); graph = { edges: g.edgeCount, nodes: g.nodeCount, builtAt: g.builtAt }; } catch { /* absent */ }
      let mcp = { ok: false, reason: "not checked" };
      try {
        const { launcherPresent } = await import("../market/alpaca-mcp.mjs");
        const l = await launcherPresent();
        mcp = l.ok
          ? { ok: true, launcher: `uvx ${l.version}`, route: "alpaca-mcp" }
          : { ok: false, route: "rest-fallback", reason: "uvx not on PATH — orders route through REST" };
      } catch (err) { mcp = { ok: false, route: "rest-fallback", reason: err.message.slice(0, 120) }; }

      let llm = { powered: false, reason: "not checked" };
      try { llm = await adjudicate(); } catch (err) { llm = { powered: false, reason: err.message }; }
      return send(res, 200, {
        status: "ok",
        commit: COMMIT,
        deploy: DEPLOY,
        llm,
        alpacaMcp: mcp,
        bootedAt: BOOTED_AT.toISOString(),
        uptimeSeconds: Math.round((Date.now() - BOOTED_AT) / 1000),
        graph,
        alpacaCredentials: credentials().ok,
        gates: GATES,
      });
    }

    if (url.pathname === "/api/graph") return send(res, 200, loadGraph());

    // What the daemon has actually done — including everything it refused.
    if (url.pathname === "/api/journal") {
      const file = path.join(ROOT, "data/journal.jsonl");
      if (!fs.existsSync(file)) return send(res, 200, { entries: [], daemon: null });
      const entries = fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean).slice(-120).reverse();
      let daemon = null;
      try { daemon = JSON.parse(fs.readFileSync(path.join(ROOT, "data/daemon-state.json"), "utf8")); } catch {}
      return send(res, 200, { entries, daemon });
    }

    if (url.pathname === "/api/hubs") {
      const g = loadGraph();
      const hubs = g.nodes
        .filter((n) => n.inDegree > 0)
        .map((n) => ({
          ...n,
          totalExposure: g.edges.filter((e) => e.to === n.ticker).reduce((a, e) => a + e.magnitude, 0),
          maxExposure: Math.max(...g.edges.filter((e) => e.to === n.ticker).map((e) => e.magnitude)),
        }));
      return send(res, 200, hubs);
    }

    if (url.pathname === "/api/portfolio") {
      if (!credentials().ok) return send(res, 200, { connected: false, positions: [] });
      const [a, p, k] = await Promise.all([account(), positions(), clock()]);
      // Realised and unrealised are different facts. Showing only the open P/L
      // hid a $4,480 realised loss behind a -$90 headline.
      const START_EQUITY = Number(process.env.START_EQUITY || 100000);
      const unrealised = p.reduce((sum, x) => sum + Number(x.unrealized_pl), 0);
      const deployed = p.reduce((sum, x) => sum + Math.abs(Number(x.market_value)), 0);
      return send(res, 200, {
        connected: true,
        accountNumber: a.account_number,
        equity: Number(a.equity),
        cash: Number(a.cash),
        startEquity: START_EQUITY,
        unrealised,
        realised: Number(a.equity) - START_EQUITY - unrealised,
        totalPl: Number(a.equity) - START_EQUITY,
        deployed,
        deployedPct: deployed / Number(a.equity),
        marketOpen: k.is_open,
        positions: p.map((x) => ({
          symbol: x.symbol, qty: Number(x.qty), side: x.side, assetClass: x.asset_class,
          entry: Number(x.avg_entry_price), value: Number(x.market_value),
          pl: Number(x.unrealized_pl), plpc: Number(x.unrealized_plpc),
        })),
      });
    }

    // Order history — what was actually sent to the broker, and what it did.
    // Round-trip accounting: what each closed trade actually made.
    if (url.pathname === "/api/blotter") {
      if (!credentials().ok) return send(res, 200, { connected: false, closed: [], open: [], totals: {} });
      const { blotter } = await import("../engine/blotter.mjs");
      const b = await blotter();
      const a = await account();
      return send(res, 200, {
        connected: true, ...b,
        equity: Number(a.equity),
        startEquity: Number(process.env.START_EQUITY || 100000),
      });
    }

    if (url.pathname === "/api/orders") {
      if (!credentials().ok) return send(res, 200, { connected: false, orders: [] });
      const raw = await orders({ status: "all", limit: 60 });
      return send(res, 200, {
        connected: true,
        orders: raw.map((o) => ({
          id: o.id, symbol: o.symbol, side: o.side, qty: Number(o.qty ?? 0),
          notional: o.notional ? Number(o.notional) : null,
          type: o.order_type, limitPrice: o.limit_price ? Number(o.limit_price) : null,
          status: o.status, assetClass: o.asset_class,
          submittedAt: o.submitted_at, filledAt: o.filled_at,
          filledQty: Number(o.filled_qty ?? 0),
          filledPrice: o.filled_avg_price ? Number(o.filled_avg_price) : null,
          clientOrderId: o.client_order_id,
        })),
      });
    }

    if (url.pathname === "/api/news") {
      if (!credentials().ok) return send(res, 200, { connected: false, news: [] });
      const g = loadGraph();
      const hubs = g.nodes.filter((n) => n.inDegree > 1).map((n) => n.ticker).slice(0, 12);
      const start = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
      return send(res, 200, { connected: true, news: await news(hubs, { start, limit: 30 }) });
    }

    if (url.pathname === "/api/cascade") {
      const hub = url.searchParams.get("hub");
      if (!hub) return send(res, 400, { error: "hub required" });
      const graph = loadGraph();
      const direction = url.searchParams.get("direction") === "up" ? 1 : -1;
      // Default to a week back: long enough for a residual to have formed,
      // short enough that the window is still about this event.
      const eventAt = url.searchParams.get("at")
        || new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);

      const cred = credentials();
      if (!cred.ok) {
        return send(res, 200, {
          hub, direction, live: false,
          reason: cred.ok ? "no event date supplied" : "no Alpaca credentials — structural gates only",
          considered: structuralScreen(graph, hub),
        });
      }
      const result = await runCascade({ graph, hub, eventAt, direction, withOptions: url.searchParams.get("options") !== "0" });
      return send(res, 200, { ...result, live: true });
    }

    // Close one position, or the whole book. Opening was reachable from the UI
    // and closing was not — an agent you can start but not stop is not a
    // product.
    if (url.pathname === "/api/close" && req.method === "POST") {
      const cred = credentials();
      if (!cred.ok) return send(res, 400, { error: cred.reason });

      const symbol = url.searchParams.get("symbol");
      const scope = url.searchParams.get("scope"); // "all" | "options"
      const { closePosition } = await import("../market/alpaca.mjs");

      // A close SUBMITS an order. Outside market hours it queues, and the
      // position stays open until it fills — so the thesis must NOT be
      // forgotten here. Erasing it on submission wiped the reasoning behind
      // thirteen still-open positions.
      const attempt = async (sym) => {
        try { await closePosition(sym); return { symbol: sym, ok: true }; }
        catch (err) { return { symbol: sym, ok: false, error: err.message.slice(0, 180) }; }
      };

      const k = await clock().catch(() => ({ is_open: false }));
      const targets = symbol
        ? [symbol]
        : (await positions())
            .filter((p) => (scope === "options" ? p.asset_class === "us_option" : true))
            .map((p) => p.symbol);

      if (!targets.length) return send(res, 200, { submitted: [], failed: [], marketOpen: k.is_open, note: "no open positions" });

      const results = await Promise.all(targets.map(attempt));
      const submitted = results.filter((r) => r.ok).map((r) => r.symbol);
      const failed = results.filter((r) => !r.ok);

      return send(res, 200, {
        submitted, failed, marketOpen: k.is_open,
        note: !k.is_open && submitted.length
          ? `${submitted.length} close order${submitted.length > 1 ? "s" : ""} queued — the market is shut, they fill at the open`
          : failed.length && !submitted.length
            ? "nothing closed — see the reasons below"
            : null,
      });
    }

    // Run a cascade for real. The gates still decide what is bought — this only
    // chooses WHEN to look, exactly like the Telegram /trade command. There is
    // deliberately no endpoint that places an arbitrary order.
    if (url.pathname === "/api/trade" && req.method === "POST") {
      const cred = credentials();
      if (!cred.ok) return send(res, 400, { error: cred.reason });

      const hub = url.searchParams.get("hub");
      const direction = url.searchParams.get("direction") === "up" ? 1 : -1;
      if (!hub) return send(res, 400, { error: "hub required" });

      const graph = loadGraph();
      if (!graph.edges.some((e) => e.to === hub)) return send(res, 400, { error: `${hub} is not a hub in the graph` });

      const eventAt = url.searchParams.get("at")
        || new Date(Date.now() - 6 * 3600 * 1000).toISOString();

      const result = await runCascade({ graph, hub, eventAt, direction, feed: "sip" });
      if (result.error) return send(res, 400, { error: result.error });

      if (!result.positions.length) {
        return send(res, 200, { hub, direction, orders: [], refusals: result.refusals,
          note: "nothing passed the gates" });
      }

      // Manual runs are journalled like the daemon's, or the agent log shows
      // an account that changed for no recorded reason.
      const headline = url.searchParams.get("headline");
      const { appendJournal } = await import("../engine/journal.mjs");
      appendJournal({ kind: "event", hub, direction, headline,
        summary: `${hub} ${direction < 0 ? "▼" : "▲"} manual run${headline ? " — " + headline.slice(0, 60) : " (no headline given)"}` });

      const a = await account();
      const room = await portfolioHeadroom(Number(a.equity));
      if (!room.ok) {
        return send(res, 200, { hub, direction, orders: [], refusals: result.refusals,
          note: room.reason });
      }
      const sized = sizePositions(
        result.positions.map((p) => ({ ...p, direction })),
        Number(a.equity),
        { deployed: room.deployed },
      );
      const orders = await execute(sized, { direction, dryRun: false, equity: Number(a.equity) });

      for (const o of orders) {
        appendJournal({ kind: "order", ticker: o.ticker, hub, side: o.side,
          instrument: o.instrument, status: o.status, exposure: o.exposure, z: o.z,
          accession: o.accession, manual: true,
          summary: `${o.side} ${o.ticker} ${o.shares ? o.shares + "sh" : "$" + o.notional} — ${(o.exposure * 100).toFixed(0)}% via ${hub}, ${o.z?.toFixed(2)}σ — ${o.status} (manual)` });
      }
      for (const r of result.refusals) {
        appendJournal({ kind: "refusal", ticker: r.ticker, hub, gate: r.gate, manual: true,
          summary: `${r.ticker} refused [${r.gate}] ${r.reason}` });
      }

      return send(res, 200, {
        hub, direction, equity: Number(a.equity),
        orders: orders.map((o) => ({
          ticker: o.ticker, instrument: o.instrument, status: o.status, via: o.via,
          contract: o.contract ?? null, contracts: o.contracts ?? null,
          shares: o.shares ?? null, notional: o.notional, exposure: o.exposure, z: o.z,
          error: o.error ?? null,
        })),
        refusals: result.refusals,
      });
    }

    // static
    const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) return send(res, 404, { error: "not found" });
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || "application/octet-stream");
  } catch (err) {
    // Honest failure, never a raw stack trace to the browser.
    console.error(err);
    return send(res, 500, { error: err.message });
  }
});

// One process can host both. On Railway this means a single service, a single
// health endpoint, and no drift between what the UI shows and what the agent did.
if (process.env.RUN_DAEMON === "true") {
  const { startDaemon } = await import("../daemon.mjs");
  startDaemon({ quiet: false }).catch((err) => console.error("daemon failed to start:", err.message));
}

// Warm the market-data cache for the hubs the interface opens on.
//
// The first cascade after a boot pays for every dependent's daily bars at once
// — 19 to 29 seconds — and the stage sits on "propagating…" for all of it,
// which reads as a hang rather than as work. Every later call is under two
// seconds because the bars are cached. So we pay that cost at startup, before
// anyone has clicked, instead of in front of an audience.
async function prewarm() {
  try {
    const graph = loadGraph();
    if (!credentials().ok) return;
    const hubs = graph.nodes.filter((n) => n.inDegree > 0).slice(0, 3).map((n) => n.ticker);
    const eventAt = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    for (const hub of hubs) {
      const t = Date.now();
      await runCascade({ graph, hub, eventAt, direction: -1, withOptions: false });
      console.log(`  prewarmed      ${hub} in ${((Date.now() - t) / 1000).toFixed(1)}s`);
    }
  } catch (err) {
    // Never fatal: a cold cache is slow, not broken.
    console.error("prewarm skipped:", err.message);
  }
}

server.listen(PORT, () => {
  console.log(`Cascade running  http://localhost:${PORT}`);
  console.log(`  health         http://localhost:${PORT}/healthz`);
  console.log(`  commit         ${COMMIT}`);
  console.log(`  alpaca keys    ${credentials().ok ? "present" : "MISSING — structural gates only"}`);
  console.log(`  daemon         ${process.env.RUN_DAEMON === "true" ? "running in this process" : "separate (npm run daemon)"}`);
  prewarm();
});
