// Cascade MCP server — JSON-RPC 2.0 over stdio.
//
// The organisers called MCP "the core of the theme", and this is the part of
// Cascade worth exposing: any Claude, Cursor or VS Code agent can ask what is
// downstream of an event and get back sourced, quantified relationships it
// could not otherwise obtain.
//
// Every answer carries its citation. The server will not speculate: if a
// relationship is not in the graph, it says so rather than inventing one.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { structuralScreen, runCascade } from "../engine/cascade.mjs";
import { credentials } from "../market/alpaca.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PROTOCOL_VERSION = "2024-11-05";
const SERVER = { name: "cascade", version: "0.1.0" };

const graph = () => JSON.parse(fs.readFileSync(path.join(ROOT, "data/graph.json"), "utf8"));

const TOOLS = [
  {
    name: "cascade_downstream",
    description:
      "Given a company (the hub), list every publicly-listed company that has disclosed a material revenue dependency on it, with the share of revenue, the fiscal period, and the SEC accession number. Relationships are mined from filers' own XBRL concentration facts — never inferred.",
    inputSchema: {
      type: "object",
      properties: { ticker: { type: "string", description: "Hub ticker, e.g. WMT, AAPL, HD" } },
      required: ["ticker"],
    },
  },
  {
    name: "cascade_upstream",
    description:
      "Given a company, list the hubs it depends on for revenue — who its disclosed major customers are, and how concentrated it is.",
    inputSchema: {
      type: "object",
      properties: { ticker: { type: "string", description: "Dependent ticker, e.g. SMG, CRUS, LEA" } },
      required: ["ticker"],
    },
  },
  {
    name: "cascade_run",
    description:
      "Propagate an event at a hub through the graph and score every exposed dependent for whether the market has already priced it in. Returns positions worth taking and, importantly, the ones refused with the gate and reason. Requires market data credentials.",
    inputSchema: {
      type: "object",
      properties: {
        hub: { type: "string", description: "Ticker where the event happened" },
        event_date: { type: "string", description: "ISO date of the event, e.g. 2026-08-25" },
        direction: { type: "string", enum: ["down", "up"], description: "Sign the thesis predicts for dependents" },
      },
      required: ["hub"],
    },
  },
  {
    name: "cascade_graph_stats",
    description: "Coverage of the causal graph: hubs ranked by inbound dependents, edge count, and how each edge is sourced.",
    inputSchema: { type: "object", properties: {} },
  },
];

const text = (s) => ({ content: [{ type: "text", text: s }] });
const fail = (s) => ({ content: [{ type: "text", text: s }], isError: true });
const pct = (x) => (x * 100).toFixed(1) + "%";

async function callTool(name, args = {}) {
  const g = graph();

  if (name === "cascade_downstream") {
    const t = String(args.ticker || "").toUpperCase();
    const edges = g.edges.filter((e) => e.to === t);
    if (!edges.length)
      return text(`No disclosed dependents of ${t} in the graph. That means no filer in the mined universe named ${t} as a material customer — not that none exists. Cascade never infers a relationship it cannot cite.`);
    const lines = edges
      .sort((a, b) => b.magnitude - a.magnitude)
      .map((e) =>
        `${e.from}  ${pct(e.magnitude)} of ${e.from}'s revenue  ·  type ${e.relationshipType}  ·  FY ending ${e.fiscalPeriodEnd}\n` +
        `    disclosed as "${e.disclosedAs}"  ·  ${e.accession}\n    ${e.sourceUrl}`);
    return text(`${edges.length} disclosed dependents of ${t}:\n\n${lines.join("\n\n")}`);
  }

  if (name === "cascade_upstream") {
    const t = String(args.ticker || "").toUpperCase();
    const edges = g.edges.filter((e) => e.from === t);
    if (!edges.length) return text(`${t} discloses no named customer concentration in the mined universe.`);
    const total = edges.reduce((a, e) => a + e.magnitude, 0);
    const lines = edges
      .sort((a, b) => b.magnitude - a.magnitude)
      .map((e) => `${e.to}  ${pct(e.magnitude)}  ·  ${e.relationshipType}  ·  FY ${e.fiscalPeriodEnd}  ·  ${e.accession}`);
    return text(`${t} discloses ${edges.length} named customer dependencies totalling ${pct(total)} of revenue:\n\n${lines.join("\n")}`);
  }

  if (name === "cascade_run") {
    if (!credentials().ok) {
      const hub = String(args.hub || "").toUpperCase();
      const screened = structuralScreen(g, hub);
      if (!screened.length) return fail(`No edges into ${hub}.`);
      return text(
        `No market-data credentials, so the priced-in check cannot run. Structural screen only:\n\n` +
          screened.map((c) => `${c.ticker}  ${pct(c.exposure)}  ${c.state}  — ${c.reason}`).join("\n")
      );
    }
    const hub = String(args.hub || "").toUpperCase();
    const eventAt = args.event_date || new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
    const direction = args.direction === "up" ? 1 : -1;

    let r;
    try {
      r = await runCascade({ graph: g, hub, eventAt, direction, feed: "sip" });
    } catch (err) {
      return fail(`Cascade failed: ${err.message}`);
    }
    if (r.error) return fail(r.error);

    const pos = r.positions
      .map((p) => `${p.ticker}  ${pct(p.exposure)} exposed  ·  residual ${p.z.toFixed(2)}σ  ·  ${p.reason}\n    cited: "${p.disclosedAs}" ${p.accession}`)
      .join("\n");
    const ref = r.refusals.map((p) => `${p.ticker}  [${p.gate}]  ${p.reason}`).join("\n");

    return text(
      `Cascade from ${hub} ${direction < 0 ? "▼" : "▲"} on ${eventAt}\n` +
        `${r.considered.length} exposed · ${r.positions.length} unpriced · ${r.refusals.length} refused\n\n` +
        `UNPRICED AND EXPOSED\n${pos || "  none"}\n\nREFUSED\n${ref || "  none"}`
    );
  }

  if (name === "cascade_graph_stats") {
    const hubs = g.nodes.filter((n) => n.inDegree > 0).sort((a, b) => b.inDegree - a.inDegree);
    return text(
      `Cascade graph — ${g.edgeCount} edges across ${g.nodeCount} companies, built ${g.builtAt}.\n` +
        `Every edge is a filer's own XBRL concentration fact with an accession number.\n\n` +
        hubs.map((n) => `${String(n.inDegree).padStart(3)} inbound  ${n.ticker.padEnd(6)} ${n.company ?? ""}`).join("\n")
    );
  }

  return fail(`Unknown tool: ${name}`);
}

// ── JSON-RPC plumbing ────────────────────────────────────────────────────────
const write = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

async function handle(req) {
  const { id, method, params } = req;

  if (method === "initialize")
    return { jsonrpc: "2.0", id, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER } };

  // Notifications carry no id and must not be answered.
  if (method === "notifications/initialized" || method === "initialized") return null;

  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

  if (method === "tools/call") {
    try {
      return { jsonrpc: "2.0", id, result: await callTool(params?.name, params?.arguments) };
    } catch (err) {
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true } };
    }
  }

  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };

  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let req;
    try { req = JSON.parse(line); } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    const res = await handle(req);
    if (res) write(res);
  }
});

process.stderr.write(`cascade mcp server ready — ${TOOLS.length} tools\n`);
