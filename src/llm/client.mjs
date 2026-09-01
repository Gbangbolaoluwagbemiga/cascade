// The two-stage LLM: cheap triage on every headline, expensive adjudication
// once per edge at ingest.
//
// Provider-agnostic, because Groq and xAI are both OpenAI-compatible and the
// two are easy to confuse by name:
//
//   Groq  — inference provider (Llama, Qwen, gpt-oss) at api.groq.com
//   Grok  — xAI's own model at api.x.ai
//
// Whichever key is present is used. The model is validated against the live
// /models list rather than assumed — model IDs get retired, and a stale default
// fails on the first real call instead of at startup.
//
// The division of labour never changes: the model ranks and types edges that
// were already mined from filings and already carry a citation. It never
// discovers a relationship.

import "../env.mjs";

const PROVIDERS = {
  groq: {
    envKey: "GROQ_API_KEY",
    base: process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
    // Preference order; the first that the account actually has wins.
    triage: ["openai/gpt-oss-20b", "groq/compound-mini", "qwen/qwen3.6-27b"],
    adjudicator: ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "openai/gpt-oss-20b"],
  },
  xai: {
    envKey: "XAI_API_KEY",
    base: process.env.XAI_BASE_URL || "https://api.x.ai/v1",
    triage: ["grok-4.1-fast", "grok-4.3"],
    adjudicator: ["grok-4.6", "grok-4.5", "grok-4.3"],
  },
};

const TYPES = ["customer", "conduit_financing", "conduit_distribution", "government", "unknown"];

export const usage = { calls: 0, promptTokens: 0, completionTokens: 0, byModel: {}, errors: 0, rateLimitWaits: 0 };

export function provider() {
  for (const [name, p] of Object.entries(PROVIDERS)) {
    const key = process.env[p.envKey];
    if (key) return { ok: true, name, key, ...p };
  }
  return {
    ok: false,
    reason: "no LLM key — set GROQ_API_KEY (api.groq.com) or XAI_API_KEY (x.ai) in .env",
  };
}

let resolved = null;

/** Pick models that exist on this account, once, and remember the choice. */
export async function resolveModels({ refresh = false } = {}) {
  if (resolved && !refresh) return resolved;
  const p = provider();
  if (!p.ok) return (resolved = { ok: false, reason: p.reason });

  let available = [];
  try {
    const res = await fetch(`${p.base}/models`, { headers: { Authorization: `Bearer ${p.key}` } });
    if (!res.ok) return (resolved = { ok: false, reason: `${p.name} ${res.status}: ${(await res.text()).slice(0, 140)}` });
    available = ((await res.json()).data || []).map((m) => m.id);
  } catch (err) {
    return (resolved = { ok: false, reason: `${p.name} unreachable: ${err.message}` });
  }

  const pick = (envVar, preferences) => {
    const wanted = process.env[envVar];
    if (wanted && available.includes(wanted)) return { id: wanted, source: "configured" };
    const fallback = preferences.find((m) => available.includes(m));
    if (!fallback) return { id: null, source: "none" };
    // A configured-but-missing model is reported, never silently swapped.
    return { id: fallback, source: wanted ? `fallback (configured "${wanted}" is not available)` : "default" };
  };

  const triage = pick("TRIAGE_MODEL", p.triage);
  const adjudicator = pick("ADJUDICATOR_MODEL", p.adjudicator);

  resolved = {
    ok: Boolean(triage.id && adjudicator.id),
    provider: p.name,
    base: p.base,
    available,
    triage,
    adjudicator,
    reason: triage.id && adjudicator.id ? null : `no usable model on ${p.name} among ${available.length} available`,
  };
  return resolved;
}

/**
 * One completion, returned as parsed JSON.
 *
 * Reasoning models (gpt-oss, qwen3) intermittently emit their reasoning before
 * the object. Groq's strict `json_object` mode then rejects the generation
 * server-side with `json_validate_failed`, which surfaces as a 400 rather than
 * as recoverable output — so a strict-mode failure is retried in free mode and
 * the object is extracted from whatever came back. `reasoning_effort: "low"`
 * keeps the preamble short in the first place.
 */
async function chat({ model, system, user, maxTokens = 700, schema = null }) {
  const p = provider();
  if (!p.ok) throw new Error(p.reason);

  const body = (responseFormat) => ({
    model,
    temperature: 0,
    max_tokens: maxTokens,
    reasoning_effort: "low",
    ...(responseFormat ? { response_format: responseFormat } : {}),
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const attempts = [
    schema ? { type: "json_schema", json_schema: { name: "result", strict: true, schema } } : { type: "json_object" },
    null, // free-form, parsed leniently
  ];

  let lastError = null;
  for (const format of attempts) {
    let res, text;
    try {
      res = await fetch(`${p.base}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${p.key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body(format)),
      });
      text = await res.text();
    } catch (err) { lastError = err; continue; }

    // Rate limits are transient, not a verdict. Honour Retry-After and wait.
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after")) * 1000 ||
        Number((text.match(/try again in ([\d.]+)s/i) || [])[1]) * 1000 || 4000;
      usage.rateLimitWaits++;
      await new Promise((r) => setTimeout(r, Math.min(wait + 250, 30000)));
      const retry = await fetch(`${p.base}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${p.key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body(format)),
      });
      const retryText = await retry.text();
      if (!retry.ok) { lastError = new Error(`${p.name} ${retry.status} after retry on ${model}: ${retryText.slice(0, 140)}`); continue; }
      res = retry; text = retryText;
    } else if (!res.ok) {
      lastError = new Error(`${p.name} ${res.status} on ${model}: ${text.slice(0, 160)}`); continue;
    }

    let j;
    try { j = JSON.parse(text); } catch { lastError = new Error(`non-JSON envelope: ${text.slice(0, 140)}`); continue; }

    usage.calls++;
    usage.promptTokens += j.usage?.prompt_tokens ?? 0;
    usage.completionTokens += j.usage?.completion_tokens ?? 0;
    usage.byModel[model] = (usage.byModel[model] || 0) + 1;

    const content = j.choices?.[0]?.message?.content;
    if (!content) { lastError = new Error("empty content"); continue; }

    const parsed = extractJson(content);
    if (parsed) return parsed;
    lastError = new Error(`no JSON object in response: ${String(content).slice(0, 140)}`);
  }

  usage.errors++;
  throw lastError ?? new Error("chat failed");
}

/** Pull the first balanced JSON object out of a response that may wrap it. */
function extractJson(raw) {
  const text = String(raw).replace(/```(?:json)?/gi, "");
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

// ── stage 1: triage ──────────────────────────────────────────────────────────
const TRIAGE_SYSTEM = `You triage financial news for a trading agent that maps second-order effects.

The agent already knows which companies depend on which. Your only job: is THIS headline a real, material event at the named company — something that could plausibly change the economics of its suppliers or partners within days?

Material: guidance changes, demand shifts, regulatory or legal action, recalls, plant or supply disruption, contract wins or losses, tariffs, strikes, major product decisions.
NOT material: analyst price targets, ratings changes, "what $1000 invested would be worth", peer comparisons, options-flow notes, listicles, generic market recaps.

Be strict. A false positive costs a real trade; a false negative costs only a missed one.

Respond with JSON only, no prose:
{"material": true|false, "direction": "down"|"up"|null, "confidence": 0.0-1.0, "reason": "under 12 words"}
"direction" is the effect on the company's DEPENDENTS, not on its own share price.`;

export async function triage(headline, { hub, symbols = [], summary = "" } = {}) {
  const r = await resolveModels();
  if (!r.ok) throw new Error(r.reason);
  const out = await chat({
    model: r.triage.id,
    system: TRIAGE_SYSTEM,
    maxTokens: 400,
    schema: {
      type: "object", additionalProperties: false,
      required: ["material", "direction", "confidence", "reason"],
      properties: {
        material: { type: "boolean" },
        direction: { type: ["string", "null"], enum: ["down", "up", null] },
        confidence: { type: "number" },
        reason: { type: "string" },
      },
    },
    user: `Company: ${hub}\nTickers in headline: ${symbols.join(", ") || "none"}\nHeadline: ${headline}${summary ? `\nSummary: ${summary.slice(0, 400)}` : ""}`,
  });
  return {
    material: Boolean(out.material),
    direction: out.direction === "up" ? 1 : out.direction === "down" ? -1 : null,
    confidence: Number(out.confidence ?? 0),
    reason: String(out.reason ?? "").slice(0, 120),
    model: r.triage.id,
  };
}

// ── stage 2: adjudication ────────────────────────────────────────────────────
const ADJUDICATE_SYSTEM = `You classify a disclosed business relationship between two public companies, using the exact wording a filer used in its SEC filing. Do not speculate beyond it.

Every one of these is a REAL dependency. What differs is which kind of shock travels along it:
- "customer": the dependent sells goods or services to the counterparty. Transmits DEMAND.
- "conduit_financing": the counterparty finances or originates the dependent's sales (a bank, a leasing arm). Transmits CREDIT AVAILABILITY, not demand.
- "conduit_distribution": the counterparty never buys the goods — it provides ACCESS to end customers and takes a fee or commission (an app store, a marketplace where the dependent is the seller of record, an agent). Transmits ROUTE-TO-MARKET.

THE TEST that separates customer from conduit_distribution: does the counterparty TAKE OWNERSHIP and pay for the goods?
- A retailer buying inventory wholesale (Walmart, Target, Costco, Home Depot buying products to resell) is a "customer". Its demand IS the dependent's demand. Do not call it a conduit.
- A platform taking a commission on a sale the dependent makes to a consumer (Apple's App Store, a marketplace) is "conduit_distribution".
If in doubt about a retailer, answer "customer".
- "government": the counterparty is a government body. Transmits APPROPRIATIONS.
- "unknown": the wording does not let you tell. A valid and safe answer.

Respond with JSON only, no prose:
{"relationship_type": "customer"|"conduit_financing"|"conduit_distribution"|"government"|"unknown", "confidence": 0.0-1.0, "reason": "under 15 words"}`;

export async function adjudicateEdge({ from, to, disclosedAs, magnitude, toCompany }) {
  const r = await resolveModels();
  if (!r.ok) throw new Error(r.reason);
  const out = await chat({
    model: r.adjudicator.id,
    system: ADJUDICATE_SYSTEM,
    maxTokens: 500,
    schema: {
      type: "object", additionalProperties: false,
      required: ["relationship_type", "confidence", "reason"],
      properties: {
        relationship_type: { type: "string", enum: TYPES },
        confidence: { type: "number" },
        reason: { type: "string" },
      },
    },
    user:
      `Dependent: ${from}\nCounterparty: ${to}${toCompany ? ` (${toCompany})` : ""}\n` +
      `The filer tagged the counterparty as: "${disclosedAs}"\n` +
      `Share: ${(magnitude * 100).toFixed(1)}% of ${from}'s revenue`,
  });
  return {
    relationshipType: TYPES.includes(out.relationship_type) ? out.relationship_type : "unknown",
    confidence: Number(out.confidence ?? 0),
    reason: String(out.reason ?? "").slice(0, 140),
    model: r.adjudicator.id,
  };
}

const TRANSMITS = {
  customer: "demand — guidance cuts, lost programmes, volume shifts",
  conduit_financing: "credit availability — a lender exiting a segment, a rate shock",
  conduit_distribution: "route-to-market — platform fees, delisting, channel or shelf changes",
  government: "appropriations — budgets, shutdowns, contract awards",
};

/** Does THIS shock travel down THIS edge? An App Store fee change reaches
 *  Duolingo; an iPhone recall does not. Same edge, opposite answers. */
export async function shockTravels({ headline, relationshipType, from, to }) {
  if (relationshipType === "unknown") return { travels: false, reason: "edge type unknown — blocked" };
  const r = await resolveModels();
  if (!r.ok) throw new Error(r.reason);
  const out = await chat({
    model: r.adjudicator.id,
    maxTokens: 400,
    schema: {
      type: "object", additionalProperties: false,
      required: ["travels", "reason"],
      properties: { travels: { type: "boolean" }, reason: { type: "string" } },
    },
    system:
      `Decide whether a news event at one company propagates to a dependent along a specific kind of relationship.\n` +
      `This edge transmits ${TRANSMITS[relationshipType]}.\n` +
      `If the event does not act through that channel, it does NOT travel — even though the relationship is real.\n` +
      `Respond with JSON only: {"travels": true|false, "reason": "under 15 words"}`,
    user: `Event at ${to}: ${headline}\nDependent: ${from}\nRelationship type: ${relationshipType}`,
  });
  return { travels: Boolean(out.travels), reason: String(out.reason ?? "").slice(0, 140) };
}

export const stats = () => ({ ...usage });
