// Cascade web server. No framework — node http, so the deploy has no surprises.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { structuralScreen, runCascade, GATES } from "../engine/cascade.mjs";
import { credentials, account, positions, news, clock } from "../market/alpaca.mjs";
import { adjudicate } from "../engine/triage.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PUBLIC = fileURLToPath(new URL("./public/", import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const BOOTED_AT = new Date();

// Build marker from day one: a health endpoint that proves which code is live.
let COMMIT = "unversioned";
try {
  COMMIT = execSync("git rev-parse --short HEAD", { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] })
    .toString().trim();
} catch { /* not a repo yet */ }

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
      let llm = { powered: false, reason: "not checked" };
      try { llm = await adjudicate(); } catch (err) { llm = { powered: false, reason: err.message }; }
      return send(res, 200, {
        status: "ok",
        commit: COMMIT,
        llm,
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
      return send(res, 200, {
        connected: true,
        accountNumber: a.account_number,
        equity: Number(a.equity),
        cash: Number(a.cash),
        marketOpen: k.is_open,
        positions: p.map((x) => ({
          symbol: x.symbol, qty: Number(x.qty), side: x.side,
          entry: Number(x.avg_entry_price), value: Number(x.market_value),
          pl: Number(x.unrealized_pl), plpc: Number(x.unrealized_plpc),
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
      const result = await runCascade({ graph, hub, eventAt, direction });
      return send(res, 200, { ...result, live: true });
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

server.listen(PORT, () => {
  console.log(`Cascade running  http://localhost:${PORT}`);
  console.log(`  health         http://localhost:${PORT}/healthz`);
  console.log(`  commit         ${COMMIT}`);
  console.log(`  alpaca keys    ${credentials().ok ? "present" : "MISSING — structural gates only"}`);
  console.log(`  daemon         ${process.env.RUN_DAEMON === "true" ? "running in this process" : "separate (npm run daemon)"}`);
});
