// Telegram command surface.
//
// Read-only by default, plus two controls. What it deliberately does NOT offer
// is a way to place an arbitrary trade: /trade runs the real cascade with every
// gate applied, so a human chooses *when to look*, never *what to buy*. An
// agent you can override isn't autonomous, and a chat box wired straight to an
// order endpoint is one fat thumb away from a position nobody decided on.

import "../env.mjs";

const API = "https://api.telegram.org";
const token = () => process.env.TELEGRAM_BOT_TOKEN;
const chatId = () => process.env.TELEGRAM_CHAT_ID;

const esc = (s) => String(s ?? "").replace(/[_*[\]()~`>#+\-=|{}.!]/g, (c) => "\\" + c);
const pct = (x) => `${(x * 100).toFixed(1)}%`;

export const COMMANDS = [
  { command: "status", description: "equity, positions, P/L, and what the agent is running" },
  { command: "positions", description: "open positions with their thesis" },
  { command: "graph", description: "causal graph coverage and top hubs" },
  { command: "hub", description: "/hub WMT — who depends on this company, with citations" },
  { command: "why", description: "/why SMG — why this position exists" },
  { command: "refusals", description: "what the agent refused to trade, and why" },
  { command: "run", description: "/run HD — score a cascade now, no orders" },
  { command: "trade", description: "/trade HD — run it for real; every gate still applies" },
  { command: "pause", description: "stop opening new positions" },
  { command: "resume", description: "start opening positions again" },
  { command: "help", description: "list commands" },
];

async function send(text) {
  if (!token() || !chatId()) return;
  await fetch(`${API}/bot${token()}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId(), text, parse_mode: "MarkdownV2", disable_web_page_preview: true }),
  }).catch(() => {});
}

/** Publish the command list so Telegram shows a menu instead of nothing. */
export async function registerCommands() {
  if (!token()) return { ok: false };
  const res = await fetch(`${API}/bot${token()}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commands: COMMANDS }),
  });
  return { ok: res.ok };
}

// ── handlers ─────────────────────────────────────────────────────────────────

async function status(ctx) {
  const { account, positions, clock } = await import("../market/alpaca.mjs");
  const [a, p, k] = await Promise.all([account(), positions(), clock()]);
  const pl = p.reduce((s, x) => s + Number(x.unrealized_pl), 0);
  return [
    `*Cascade*`,
    `equity \`$${esc(Number(a.equity).toLocaleString())}\` · open P/L \`${esc((pl >= 0 ? "+" : "") + pl.toFixed(2))}\``,
    `${p.length} position${p.length === 1 ? "" : "s"} · market ${k.is_open ? "open" : "closed"}`,
    ``,
    `${esc(ctx.graph.edgeCount)} sourced edges · ${esc(ctx.graph.nodes.filter((n) => n.inDegree > 0).length)} hubs`,
    `trading ${ctx.paused() ? "*paused*" : ctx.autoTrade ? "*live*" : "dry run"}`,
    `triage \`${esc(ctx.llm.triageModel ?? "heuristic")}\``,
  ].join("\n");
}

async function positionsCmd(ctx) {
  const { positions } = await import("../market/alpaca.mjs");
  const ledger = await import("../engine/ledger.mjs");
  const p = await positions();
  if (!p.length) return "_no open positions_";
  return p.map((x) => {
    const t = ledger.get(x.symbol);
    const pl = Number(x.unrealized_pl);
    const head = `\`${esc(x.symbol.padEnd(8))}\` ${esc(x.qty)} · ${esc((pl >= 0 ? "+" : "") + pl.toFixed(2))}`;
    return t ? `${head}\n   via ${esc(t.hub)} · ${esc(pct(t.exposure))} of revenue` : head;
  }).join("\n");
}

function graphCmd(ctx) {
  const hubs = ctx.graph.nodes.filter((n) => n.inDegree > 0).sort((a, b) => b.inDegree - a.inDegree).slice(0, 10);
  return [
    `*${esc(ctx.graph.edgeCount)} edges · ${esc(ctx.graph.nodeCount)} companies*`,
    `every edge cites an SEC filing`,
    ``,
    ...hubs.map((n) => `\`${esc(String(n.inDegree).padStart(2))}\` ${esc(n.ticker.padEnd(6))} ${esc(String(n.company ?? "").slice(0, 26))}`),
  ].join("\n");
}

function hubCmd(ctx, arg) {
  const t = String(arg || "").toUpperCase();
  if (!t) return "usage: `/hub WMT`";
  const edges = ctx.graph.edges.filter((e) => e.to === t).sort((a, b) => b.magnitude - a.magnitude);
  if (!edges.length) return `no disclosed dependents of ${esc(t)} in the graph\n_Cascade never infers a relationship it cannot cite_`;
  return [`*${esc(edges.length)} disclosed dependents of ${esc(t)}*`, ``,
    ...edges.map((e) => `\`${esc(e.from.padEnd(6))}\` ${esc(pct(e.magnitude))} of revenue · ${esc(e.relationshipType)}\n   ${esc(e.accession ?? "")}`)].join("\n");
}

function whyCmd(ctx, arg) {
  const t = String(arg || "").toUpperCase();
  if (!t) return "usage: `/why SMG`";
  const edges = ctx.graph.edges.filter((e) => e.from === t);
  if (!edges.length) return `${esc(t)} is not in the graph`;
  return [`*${esc(t)}* discloses:`, ``,
    ...edges.map((e) => `${esc(pct(e.magnitude))} of revenue from *${esc(e.to)}*\n   "${esc(e.disclosedAs)}" · FY ${esc(e.fiscalPeriodEnd)}\n   ${esc(e.accession)}`)].join("\n");
}

function refusalsCmd(ctx) {
  const recent = ctx.journal().filter((e) => e.kind === "refusal").slice(0, 10);
  if (!recent.length) return "_nothing refused yet_";
  return ["*recent refusals*", ``, ...recent.map((r) => `\`${esc(String(r.ticker).padEnd(6))}\` ${esc(String(r.summary).replace(/^\S+\s+refused\s+/, ""))}`)].join("\n");
}

async function runCmd(ctx, arg, { live }) {
  const hub = String(arg || "").toUpperCase();
  if (!hub) return `usage: \`/${live ? "trade" : "run"} HD\``;
  if (!ctx.graph.edges.some((e) => e.to === hub)) return `${esc(hub)} is not a hub in the graph — try /graph`;

  const { runCascade } = await import("../engine/cascade.mjs");
  const r = await runCascade({
    graph: ctx.graph, hub,
    eventAt: new Date(Date.now() - 6 * 3600 * 1000).toISOString(),
    direction: -1, feed: "sip",
  });
  if (r.error) return esc(r.error);

  const lines = [`*${esc(hub)} ▼ cascade*`,
    `${esc(r.considered.length)} exposed · ${esc(r.positions.length)} unpriced · ${esc(r.refusals.length)} refused`, ``];

  for (const p of r.positions) lines.push(`\`${esc(p.ticker.padEnd(6))}\` ${esc(pct(p.exposure))} · ${esc(p.z.toFixed(2))}σ unmoved`);
  if (r.refusals.length) {
    lines.push(``, `*refused*`);
    for (const x of r.refusals.slice(0, 5)) lines.push(`\`${esc(x.ticker.padEnd(6))}\` ${esc(x.gate)} — ${esc(String(x.reason).slice(0, 60))}`);
  }

  if (!live) { lines.push(``, `_scored only — no orders_`); return lines.join("\n"); }
  if (!r.positions.length) { lines.push(``, `_nothing passed the gates_`); return lines.join("\n"); }

  const { account } = await import("../market/alpaca.mjs");
  const { sizePositions, execute } = await import("../engine/execute.mjs");
  const a = await account();
  const sized = sizePositions(r.positions.map((p) => ({ ...p, direction: -1 })), Number(a.equity));
  const orders = await execute(sized, { direction: -1, dryRun: false });

  lines.push(``, `*orders*`);
  for (const o of orders) {
    lines.push(o.instrument === "option"
      ? `\`${esc(o.ticker.padEnd(6))}\` ${esc(o.contracts)}x ${esc(o.contract)} — ${esc(o.status)}`
      : `\`${esc(o.ticker.padEnd(6))}\` ${esc(o.side)} ${esc(o.shares ?? "")} — ${esc(o.status)}${o.error ? " " + esc(o.error.slice(0, 40)) : ""}`);
  }
  return lines.join("\n");
}

// ── polling loop ─────────────────────────────────────────────────────────────

let offset = 0;
let polling = false;

export function startCommandLoop(ctx, { intervalMs = 3000 } = {}) {
  if (!token() || !chatId() || polling) return false;
  polling = true;
  registerCommands();

  const tick = async () => {
    try {
      const res = await fetch(`${API}/bot${token()}/getUpdates?offset=${offset}&timeout=0&allowed_updates=["message"]`);
      if (!res.ok) return;
      const { result = [] } = await res.json();
      for (const u of result) {
        offset = u.update_id + 1;
        const text = u.message?.text;
        // Only answer the configured chat — the bot is public, the account is not.
        if (!text || String(u.message.chat.id) !== String(chatId())) continue;

        const [raw, ...rest] = text.trim().split(/\s+/);
        const cmd = raw.replace(/^\//, "").split("@")[0].toLowerCase();
        const arg = rest[0];

        let reply;
        try {
          if (cmd === "start" || cmd === "help")
            reply = ["*Cascade* — trades the ripple, not the splash", ``,
              ...COMMANDS.map((c) => `/${esc(c.command)} — ${esc(c.description)}`)].join("\n");
          else if (cmd === "status") reply = await status(ctx);
          else if (cmd === "positions") reply = await positionsCmd(ctx);
          else if (cmd === "graph") reply = graphCmd(ctx);
          else if (cmd === "hub") reply = hubCmd(ctx, arg);
          else if (cmd === "why") reply = whyCmd(ctx, arg);
          else if (cmd === "refusals") reply = refusalsCmd(ctx);
          else if (cmd === "run") reply = await runCmd(ctx, arg, { live: false });
          else if (cmd === "trade") reply = await runCmd(ctx, arg, { live: true });
          else if (cmd === "pause") { ctx.setPaused(true); reply = "⏸ paused — no new positions"; }
          else if (cmd === "resume") { ctx.setPaused(false); reply = "▶️ resumed"; }
          else continue;
        } catch (err) {
          reply = `⚠️ ${esc(String(err.message).slice(0, 160))}`;
        }
        await send(reply);
      }
    } catch { /* transient network — try again next tick */ }
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return true;
}
