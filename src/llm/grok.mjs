// Grok (xAI) client — the two-stage LLM the brief specifies.
//
//   stage 1  triage       cheap, runs on every headline
//   stage 2  adjudication expensive, runs once per edge at ingest
//
// The division of labour matters: Grok never discovers relationships. It ranks
// and types edges that were already mined from filings and already carry a
// citation. A model that invented a supply-chain link would break the one rule
// the whole product rests on.
//
// The API is OpenAI-compatible: POST /v1/chat/completions on https://api.x.ai/v1.

const BASE = process.env.XAI_BASE_URL || "https://api.x.ai/v1";

// Cheap model for the high-volume stage, capable model for the judgement.
export const TRIAGE_MODEL = process.env.GROK_TRIAGE_MODEL || "grok-4.1-fast";
export const ADJUDICATOR_MODEL = process.env.GROK_ADJUDICATOR_MODEL || "grok-4.6";

// Rough spend tracking, so the budget is observable rather than discovered on a bill.
export const usage = { calls: 0, promptTokens: 0, completionTokens: 0, byModel: {} };

export function credentials() {
  const key = process.env.XAI_API_KEY;
  if (!key) return { ok: false, reason: "no XAI_API_KEY — set it in .env to enable Grok triage and adjudication" };
  return { ok: true, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" } };
}

/** Models this key can actually reach — never assume an ID that may have moved. */
export async function listModels() {
  const cred = credentials();
  if (!cred.ok) return { ok: false, reason: cred.reason };
  try {
    const res = await fetch(`${BASE}/models`, { headers: cred.headers });
    if (!res.ok) return { ok: false, reason: `xAI ${res.status}: ${(await res.text()).slice(0, 160)}` };
    const j = await res.json();
    return { ok: true, models: (j.data || []).map((m) => m.id) };
  } catch (err) {
    return { ok: false, reason: `xAI unreachable: ${err.message}` };
  }
}

async function chat({ model, system, user, maxTokens = 700, temperature = 0 }) {
  const cred = credentials();
  if (!cred.ok) throw new Error(cred.reason);

  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: cred.headers,
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`xAI ${res.status} on ${model}: ${text.slice(0, 200)}`);

  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`xAI returned non-JSON: ${text.slice(0, 160)}`); }

  usage.calls++;
  usage.promptTokens += j.usage?.prompt_tokens ?? 0;
  usage.completionTokens += j.usage?.completion_tokens ?? 0;
  usage.byModel[model] = (usage.byModel[model] || 0) + 1;

  const content = j.choices?.[0]?.message?.content;
  if (!content) throw new Error("xAI returned no content");
  try { return JSON.parse(content); } catch { throw new Error(`model did not return valid JSON: ${String(content).slice(0, 160)}`); }
}

// ── stage 1: triage ──────────────────────────────────────────────────────────
const TRIAGE_SYSTEM = `You triage financial news for a trading agent that maps second-order effects.

The agent already knows which companies depend on which. Your only job is to decide whether THIS headline is a real, material event at the named company — something that could plausibly change the economics of its suppliers or partners over the next few days.

Material: guidance changes, demand shifts, regulatory or legal action, recalls, plant or supply disruption, contract wins or losses, tariffs, strikes, major product decisions.
NOT material: analyst price targets, ratings changes, "here's how much $1000 invested would be worth", peer comparisons, options-flow notes, listicles, generic market recaps.

Be strict. A false positive costs a real trade; a false negative costs nothing but a missed one.

Respond with JSON only:
{"material": boolean, "direction": "down"|"up"|null, "confidence": 0.0-1.0, "reason": "<12 words>"}
direction is the effect on the company's DEPENDENTS, not on its own share price.`;

export async function triage(headline, { hub, symbols = [], summary = "" } = {}) {
  const out = await chat({
    model: TRIAGE_MODEL,
    system: TRIAGE_SYSTEM,
    maxTokens: 200,
    user: `Company: ${hub}\nTickers in headline: ${symbols.join(", ") || "none"}\nHeadline: ${headline}${summary ? `\nSummary: ${summary.slice(0, 400)}` : ""}`,
  });
  return {
    material: Boolean(out.material),
    direction: out.direction === "up" ? 1 : out.direction === "down" ? -1 : null,
    confidence: Number(out.confidence ?? 0),
    reason: String(out.reason ?? "").slice(0, 120),
    model: TRIAGE_MODEL,
  };
}

// ── stage 2: adjudication ────────────────────────────────────────────────────
const ADJUDICATE_SYSTEM = `You classify a disclosed business relationship between two public companies.

You are given the exact wording a filer used in its SEC filing. Do not speculate beyond it.

Assign relationship_type — every one of these is a REAL dependency; what differs is which kind of shock travels along it:
- "customer": the dependent sells goods or services to the hub. Transmits DEMAND.
- "conduit_financing": the hub finances or originates the dependent's sales (a bank, a leasing arm). Transmits CREDIT AVAILABILITY, not demand.
- "conduit_distribution": the hub is a channel or platform the dependent reaches customers through (an app store, a distributor, a wholesaler). Transmits ROUTE-TO-MARKET.
- "government": the hub is a government body. Transmits APPROPRIATIONS.
- "unknown": the wording does not let you tell. This is a valid and safe answer.

Respond with JSON only:
{"relationship_type": "<one of the above>", "confidence": 0.0-1.0, "reason": "<15 words>"}`;

export async function adjudicateEdge({ from, to, disclosedAs, magnitude, toCompany }) {
  const out = await chat({
    model: ADJUDICATOR_MODEL,
    system: ADJUDICATE_SYSTEM,
    maxTokens: 250,
    user:
      `Dependent: ${from}\nCounterparty: ${to}${toCompany ? ` (${toCompany})` : ""}\n` +
      `Filer tagged the counterparty as: "${disclosedAs}"\n` +
      `Share: ${(magnitude * 100).toFixed(1)}% of ${from}'s revenue`,
  });
  const allowed = ["customer", "conduit_financing", "conduit_distribution", "government", "unknown"];
  const type = allowed.includes(out.relationship_type) ? out.relationship_type : "unknown";
  return { relationshipType: type, confidence: Number(out.confidence ?? 0), reason: String(out.reason ?? "").slice(0, 140), model: ADJUDICATOR_MODEL };
}

/**
 * Does THIS shock travel down THIS edge? The reason the type enum exists: an
 * iPhone recall is irrelevant to Duolingo, while an App Store commission change
 * is existential — same edge, same 61.6%, opposite answers.
 */
const TRANSMITS = {
  customer: "demand — guidance cuts, lost programmes, volume shifts",
  conduit_financing: "credit availability — a lender exiting a segment, a rate shock",
  conduit_distribution: "route-to-market — platform fees, delisting, channel changes",
  government: "appropriations — budgets, shutdowns, contract awards",
};

export async function shockTravels({ headline, relationshipType, from, to }) {
  if (relationshipType === "unknown") return { travels: false, reason: "edge type unknown — blocked" };
  const out = await chat({
    model: ADJUDICATOR_MODEL,
    maxTokens: 200,
    system:
      `Decide whether a news event at one company propagates to a dependent along a specific kind of relationship.\n` +
      `This edge transmits ${TRANSMITS[relationshipType]}.\n` +
      `If the event does not act through that channel, it does NOT travel, even though the relationship is real.\n` +
      `Respond with JSON only: {"travels": boolean, "reason": "<15 words>"}`,
    user: `Event at ${to}: ${headline}\nDependent: ${from}\nRelationship type: ${relationshipType}`,
  });
  return { travels: Boolean(out.travels), reason: String(out.reason ?? "").slice(0, 140) };
}

export function costEstimate() {
  // grok-4.1-fast $0.20/$0.50 per M; grok-4.6 $2.00/$6.00 per M.
  const rate = (m) => (m.includes("fast") ? { in: 0.2, out: 0.5 } : { in: 2.0, out: 6.0 });
  let usd = 0;
  for (const [model, calls] of Object.entries(usage.byModel)) {
    const share = calls / Math.max(1, usage.calls);
    const r = rate(model);
    usd += (usage.promptTokens * share * r.in + usage.completionTokens * share * r.out) / 1e6;
  }
  return { ...usage, estimatedUsd: Number(usd.toFixed(4)) };
}
