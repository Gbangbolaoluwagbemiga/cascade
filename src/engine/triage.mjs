// Stage one of the two-stage design: is this headline material enough to map?
//
// The brief specifies a cheap LLM here and an expensive cascade only on
// survivors. There is no Anthropic key in this environment, so stage one is
// currently a deterministic classifier — and it is deliberately conservative,
// because a false positive costs a trade while a false negative costs nothing
// but a missed one.
//
// `adjudicate` below is the seam the LLM slots into. It is not a stub that
// pretends to work: with no key it returns `powered: false`, and the daemon
// reports that rather than implying a judgement was made.

const NEGATIVE = [
  "cuts guidance", "lowers guidance", "guidance cut", "misses", "miss", "shortfall",
  "recall", "lawsuit", "sues", "sued", "ftc", "doj", "antitrust", "investigation",
  "probe", "downgrade", "downgrades", "warns", "warning", "plunge", "plunges",
  "slump", "slumps", "tumbles", "halts", "halt", "closure", "closes plant",
  "strike", "layoffs", "job cuts", "bankruptcy", "chapter 11", "weak", "weakness",
  "declines", "decline", "slowdown", "no sign of", "headwind", "shortage",
  "disruption", "tariff", "export control", "sanction", "fine", "penalty",
];

const POSITIVE = [
  "raises guidance", "beats", "beat", "record quarter", "record revenue", "upgrade",
  "upgrades", "surges", "soars", "jumps", "wins contract", "awarded", "expansion",
  "expands", "strong demand", "tailwind", "approval", "approved",
];

// Headlines that are commentary rather than events. These dominate a news feed
// and mapping them would burn the whole budget on noise.
const NOISE = [
  "price target", "analyst forecasts", "insights into", "industry comparison",
  "peer comparison", "versus peers", "options activity", "unusual options",
  "stock is trading", "here's how much", "if you invested", "market update",
  "earnings preview", "what to expect", "compared to", "evaluating",
];

export function triage(headline, { hub, symbols = [] } = {}) {
  const h = String(headline || "").toLowerCase();

  if (NOISE.some((n) => h.includes(n)))
    return { material: false, reason: "commentary, not an event", score: 0 };

  // A headline naming a dozen tickers is a roundup, not an event about the hub.
  if (symbols.length > 6)
    return { material: false, reason: `roundup naming ${symbols.length} tickers`, score: 0 };

  const neg = NEGATIVE.filter((k) => h.includes(k));
  const pos = POSITIVE.filter((k) => h.includes(k));
  if (!neg.length && !pos.length)
    return { material: false, reason: "no material-event language", score: 0 };

  // Direction: negative wins ties — a mixed headline is more often bad news.
  const direction = neg.length >= pos.length ? -1 : 1;
  const score = Math.max(neg.length, pos.length) + (symbols[0] === hub ? 1 : 0);

  return {
    material: score >= 1,
    direction,
    score,
    matched: (direction < 0 ? neg : pos).slice(0, 3),
    reason: `${direction < 0 ? "negative" : "positive"} event language: ${(direction < 0 ? neg : pos).slice(0, 3).join(", ")}`,
  };
}

/**
 * Stage two seam: assign relationship_type and judge whether this specific
 * shock travels down this specific edge. An App Store fee change reaches
 * Duolingo; an iPhone recall does not. That judgement needs a model.
 */
export async function adjudicate() {
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      powered: false,
      reason: "no ANTHROPIC_API_KEY — edge-type adjudication unavailable; " +
        "relationship types remain heuristic hints and shock-compatibility is not checked",
    };
  }
  return { powered: false, reason: "adjudication client not yet implemented" };
}
