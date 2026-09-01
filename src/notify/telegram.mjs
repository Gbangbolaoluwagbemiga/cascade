// Telegram feed.
//
// Traders would want this even if it never traded: each cascade as it fires,
// with the exposure, the residual and the citation. Patron proved a Telegram
// feed out-recruits a web app.
//
// Silent by design when unconfigured — a missing token is not an error, it is
// a channel that is off. A notification failure must never affect a trade.

import "../env.mjs";

const API = "https://api.telegram.org";

export function configured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

// MarkdownV2 reserves a wide set of punctuation; an unescaped character makes
// Telegram reject the whole message with a 400.
const esc = (s) => String(s ?? "").replace(/[_*[\]()~`>#+\-=|{}.!]/g, (c) => "\\" + c);

async function send(text, { preview = false } = {}) {
  if (!configured()) return { sent: false, reason: "telegram not configured" };
  try {
    const res = await fetch(`${API}/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: "MarkdownV2",
        disable_web_page_preview: !preview,
      }),
    });
    if (!res.ok) return { sent: false, reason: `telegram ${res.status}: ${(await res.text()).slice(0, 140)}` };
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;

/** One cascade, as it fires. */
export async function cascadeFired({ hub, headline, direction, orders, refusals, timeframe }) {
  const arrow = direction < 0 ? "▼" : "▲";
  const lines = [`⚡ *${esc(hub)}* ${arrow} cascade`, `_${esc(String(headline).slice(0, 150))}_`, ""];

  if (orders?.length) {
    lines.push(`*${orders.length} position${orders.length > 1 ? "s" : ""}*`);
    for (const o of orders) {
      lines.push(`\`${esc(o.ticker.padEnd(6))}\` ${esc(pct(o.exposure))} of revenue via ${esc(hub)} · ${esc(o.z.toFixed(2))}σ unmoved`);
      if (o.accession) lines.push(`   ↳ cited ${esc(o.accession)}`);
    }
  } else {
    lines.push("_nothing passed the gates_");
  }

  if (refusals?.length) {
    lines.push("", `*refused ${refusals.length}*`);
    for (const r of refusals.slice(0, 6)) lines.push(`\`${esc(r.ticker.padEnd(6))}\` ${esc(r.gate)} — ${esc(String(r.reason).slice(0, 70))}`);
    if (refusals.length > 6) lines.push(`_…and ${refusals.length - 6} more_`);
  }

  lines.push("", `_scored on ${esc(timeframe ?? "1Day")} bars_`);
  return send(lines.join("\n"));
}

export async function positionClosed({ ticker, hub, reason, pl }) {
  const sign = pl >= 0 ? "+" : "";
  return send([`✅ *${esc(ticker)}* closed`, esc(reason), `P/L \`${esc(sign + pl.toFixed(2))}\` · via ${esc(hub)}`].join("\n"));
}

export async function daemonUp({ triageModel, adjudicatorModel, edges, autoTrade }) {
  return send([
    `🟢 *Cascade* is up`,
    `${esc(String(edges))} sourced edges · ${esc(autoTrade ? "trading live" : "dry run")}`,
    `triage \`${esc(triageModel ?? "heuristic")}\``,
    `adjudicator \`${esc(adjudicatorModel ?? "off")}\``,
  ].join("\n"));
}

/** Confirms the token and chat id actually work, rather than assuming. */
export async function selftest() {
  if (!configured()) return { ok: false, reason: "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID not set" };
  try {
    const me = await fetch(`${API}/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`).then((r) => r.json());
    if (!me.ok) return { ok: false, reason: `getMe failed: ${me.description}` };
    const sent = await send("🟢 *Cascade* connected to this channel");
    return sent.sent ? { ok: true, bot: me.result.username } : { ok: false, reason: sent.reason };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
