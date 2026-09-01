// Client for Alpaca's OFFICIAL MCP server (github.com/alpacahq/alpaca-mcp-server).
//
// The hackathon requires projects to use Alpaca's MCP server or CLI, and this is
// the honest way to do it: Cascade's orders genuinely go through it. There are
// two MCP surfaces in this project and they point in opposite directions —
//
//   Cascade's own server  exposes the causal engine OUTWARD, so any agent can
//                         ask what is downstream of an event, with citations
//   Alpaca's server       is what Cascade calls INWARD to trade
//
// Launched on demand over stdio via uvx, kept alive for the process, and never
// required: if it cannot start, execution falls back to the REST client and
// says so rather than silently dropping an order.

import { spawn } from "node:child_process";
import "../env.mjs";

const READY_TIMEOUT_MS = 90_000;   // first run resolves and installs the package
const CALL_TIMEOUT_MS = 45_000;

let proc = null;
let ready = null;
let nextId = 1;
const pending = new Map();
let buffer = "";
let toolNames = [];

export function available() {
  return Boolean(process.env.ALPACA_API_KEY_ID && process.env.ALPACA_API_SECRET_KEY);
}

function handleLine(line) {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const entry = pending.get(msg.id);
  if (!entry) return;
  pending.delete(msg.id);
  clearTimeout(entry.timer);
  if (msg.error) entry.reject(new Error(`${msg.error.message ?? "mcp error"}`));
  else entry.resolve(msg.result);
}

function rpc(method, params, timeoutMs = CALL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

/** Start the server once and complete the handshake. */
export async function start() {
  if (ready) return ready;
  ready = (async () => {
    if (!available()) throw new Error("Alpaca credentials required to start Alpaca's MCP server");

    const home = process.env.HOME || "";
    proc = spawn("uvx", ["alpaca-mcp-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // Alpaca's server reads its own variable names.
        ALPACA_API_KEY: process.env.ALPACA_API_KEY_ID,
        ALPACA_SECRET_KEY: process.env.ALPACA_API_SECRET_KEY,
        ALPACA_PAPER_TRADE: "True",
        PATH: `${home}/.local/bin:${process.env.PATH}`,
      },
    });

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    });
    proc.on("exit", (code) => {
      for (const [, e] of pending) { clearTimeout(e.timer); e.reject(new Error(`Alpaca MCP server exited (${code})`)); }
      pending.clear();
      proc = null; ready = null;
    });

    const init = await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "cascade", version: "0.1.0" },
    }, READY_TIMEOUT_MS);

    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

    const list = await rpc("tools/list", {});
    toolNames = (list.tools || []).map((t) => t.name);

    return { server: init.serverInfo, protocol: init.protocolVersion, tools: toolNames.length };
  })().catch((err) => { ready = null; throw err; });

  return ready;
}

export async function call(name, args = {}) {
  await start();
  const result = await rpc("tools/call", { name, arguments: args });
  const text = (result?.content || []).map((c) => c.text ?? "").join("\n");
  if (result?.isError) throw new Error(text.slice(0, 300) || `${name} failed`);
  return { text, raw: result };
}

export const tools = () => toolNames;

export async function accountInfo() {
  return (await call("get_account_info", {})).text;
}

/**
 * Single-leg option order. The schema wants `symbol`/`side` at the top level —
 * `legs` is the multi-leg form — and `qty` as a STRING. Passing a number or the
 * multi-leg shape makes the call hang rather than error.
 */
export async function placeOptionOrder({ symbol, qty, side = "buy" }) {
  return call("place_option_order", {
    symbol,
    side,
    qty: String(qty),
    type: "market",
    time_in_force: "day",
    position_intent: side === "buy" ? "buy_to_open" : "sell_to_open",
  });
}

/** Place an equity order through Alpaca's MCP server. */
export async function placeStockOrder({ symbol, qty, side, notional }) {
  const args = { symbol, side, type: "market", time_in_force: "day" };
  if (qty != null) args.qty = String(qty); else args.notional = String(notional);
  return call("place_stock_order", args);
}

export function stop() {
  if (proc) { proc.kill(); proc = null; ready = null; }
}
