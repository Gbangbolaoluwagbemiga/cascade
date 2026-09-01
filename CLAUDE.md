# Cascade

**Read `BRIEF.md` in full before doing anything.** It contains the thesis, the
competitive situation, the UI bar and the seven-day plan. This file is only the
short version that must never be forgotten.

## What this is

An autonomous AI trading agent for the **Alpaca AI Trading Agents Hackathon**
(28 Aug – 4 Sep 2026, $5,000 prize pool, solo entry). We intend to win it.

**The thesis in one line:** markets price the obvious in milliseconds, but the
propagation through suppliers, customers and competitors takes hours to days —
and traversing that gap is knowledge reasoning, which is the one thing an LLM
does better than any existing trading algorithm.

> Cascade trades the ripple, not the splash.

Event → causal graph, 2–3 hops out → which downstream nodes are materially
exposed but have not moved yet → take the position → explain it in one line.

## Never break these

- **Build-time graph, runtime traversal.** Edges are mined from filings in
  advance and stored with accession number, URL and verbatim sentence. The LLM
  *ranks* verified edges; it never discovers relationships live. (BRIEF §2.1)
- **Every hop cites a source.** Not in the graph → does not exist → no trade.
- **Priced-in is a vol-normalised z-score**, never a flat percentage. Residual
  after stripping market and sector beta, scaled by trailing realised vol. Green
  under ~1σ, red over ~2σ. Same statistic is the exit trigger. (BRIEF §2.2)
- **Liquidity and materiality gates always on.** Otherwise "unmoved" selects for
  untradeable names — the fatal demo bug. (BRIEF §2.3)
- **We prove the mechanism, not the P&L.** Seven days of paper trading cannot
  establish edge. Never present noise as returns.
- **The agent must be unmistakably an autonomous trading agent.** Not a data
  product with an agent attached. That framing loses on theme.

## Decided — do not relitigate (BRIEF §8.1)

- Market data: **free tier, 15-min delayed SIP.** Consolidated beats real-time-
  but-thin, and our edge horizon is hours, not milliseconds.
- Events: Benzinga + **EDGAR 8-K watcher** (Items 1.01/1.02/2.06 first).
- Deploy: Railway (daemon) + Vercel (web). Neither auto-deploys from git.
- LLM: two-stage — cheap triage on every headline, expensive cascade only on
  survivors.
- Universe: 400–600 tickers in densely-disclosed sectors (semis, semicap,
  auto/EV, aerospace, pharma CDMO, industrials). Not the whole market.

## Graph schema — settled (BRIEF §2.1)

- **Edges are directional with asymmetric magnitude.** Store whose revenue the
  share belongs to. Never infer the reverse magnitude — leave it null, and treat
  null-magnitude direction as untradeable. A symmetric edge propagates the
  cascade backwards and produces confident garbage.
- **Two tiers.** Named + quantified → tradeable edge. Anonymous → node fragility
  attribute (`customer_concentration: 54%`), a confidence input only.
- **Never resolve an anonymous counterparty by inference**, however obvious. One
  inferred hop makes the citation rule decorative.

## Extraction — XBRL facts primary, HTML fallback

Filers tag concentration with period and counterparty attached. That kills period
misalignment, percentage-to-counterparty misassociation, and most resolver false
positives — and it arrives pre-shaped for the asymmetric schema. It is also the
stronger claim on stage: *the filer's own structured assertion*, not our regex.

**Two traps that yield confident wrong weights:**

1. **Filter `ConcentrationRiskByBenchmarkAxis` to revenue.** Filers tag accounts-
   receivable concentration just as often; that is credit exposure, not a revenue
   dependency. Store the benchmark on the edge.
2. **Check scale.** Facts are often pure decimals (`0.217` not `21.7`); read the
   `decimals` attribute. Assert `0 < share ≤ 1` and fail loudly.

Anonymous members (`CustomerOneMember`) exist in XBRL too — two-tier split
applies there as well. HTML numbers are for survey tiering only; they cannot
become edge weights without LLM adjudication, so they cost money and XBRL does
not.

## Gotchas that fail silently and asymmetrically

1. Inline XBRL splits percentages: `46 %`. Use `\s*%`, not `/[\d.]+%/`.
2. Table-form disclosure is invisible to a prose-only extractor — auto and
   aerospace tabulate more than they narrate.

Keep 2–3 known-good disclosers per sector as **canaries**. A zero on a canary is
a bug in the extractor until proven otherwise. All three bugs so far were found
this way, by spot-checking names expected to pass.

## Decided post-survey (13 Aug) — BRIEF §2.1

- **Named-customer edges only.** No market-access/tariff reframe, despite ~3.5×
  density. The causal claim is the moat; country screens are not novel.
- **Mine hub-first, not sector-first.** In-degree of 2.1 was an artefact of mining
  auto in isolation. Pick 20–30 mega-hubs, then find everyone who names them.
  Consumer/retail suppliers are the highest-yield untested seam.
- **Measured naming rates:** auto **63%**, semis **20%**. The brief's original
  "semis are dense" was survivorship from two cherry-picked filers.
- **Geographic exposure is subordinate** — later density layer, gated on proving
  extraction, never leads the pitch or demo.
- **Benchmark axis: default-deny.** Require an explicit revenue benchmark. The
  Chase→RIVN leak is probably a cash-concentration fact passing a permissive
  filter.
- **Order of work:** entity canonicalisation first (free ~2× on in-degree, and
  every downstream number depends on it), then unpositionable tier, then
  hub-first mining.
- **Conduits are a type, not noise.** Chase→RIVN is a real financing conduit, not
  a filter failure. `relationship_type` ∈ {customer, conduit_financing,
  conduit_distribution, government, unknown}, assigned by the LLM **once at
  ingest**. Each type transmits a different shock — tariffs do not travel down a
  financing edge. `unknown` blocks trading.
- **Resolution ≠ tradeability**, but positionability does NOT separate retail from
  auto. The 52% figure was hub-side, and we never position a hub — only observe
  it. Dependent side: auto 22/23, Walmart 12/12. **Retail wins on density alone.**
  Hub price data matters only for *event materiality calibration* (how big was
  this?) — use an ADR or sector-ETF residual when the hub is foreign.
- **Demo case: Duolingo, 61.6% through Apple's App Store.** Legible in one
  sentence, recurring live shocks (commission changes, DMA rulings), and not a
  supply chain — which is what makes it memorable. It also justifies the typed-
  edge enum outright: an iPhone recall is irrelevant to DUOL, an App Store
  commission change is existential.
- **Always report post-gate in-degree**, not just raw. Raw says connected;
  post-gate says it can fire.
- **Selection criterion underneath everything:** prefer hubs whose supplier base
  files with the SEC and lists on US exchanges.

## Priority right now

The **filing miner** — longest calendar risk, no upstream dependencies. The
15 days before the window open are the largest lever we have, and they belong to
the graph, not to daemon code. (BRIEF §8.2)

## Stack

Node daemon (long-running, not browser) · Alpaca Trading API + real-time data ·
MCP server exposing the causal engine · React web app with a live cascade graph ·
Telegram feed · SQLite + SSE.

## The UI bar

SecureFlow, Foreman and Patron all shipped distinctive, genuinely beautiful
interfaces, and it is a large part of why they placed. Cascade must match that
standard with its **own** identity — an instrument in a dark room, not Patron's
guild ledger.

Ground `#06080B` · surface `#0D1218` · border `#1B2530` · text `#F2F5F8` ·
muted `#93A6B8` · **signal `#7FE3A8`** · hot `#F26B52`.
Inter for UI, a monospace face for every number, `tabular-nums` everywhere.
One accent. Hairline borders. Real whitespace. Both themes must work.

Full detail — palette, type, motion, mobile rules — in `BRIEF.md` §7.

## How we work

1. Verify by driving the real thing, not by reading code.
2. Know the deploy path and prove the build landed (health endpoint with commit +
   uptime, from day one).
3. Never present a number that has not been read off the live system.
4. Honest failure messages. Never a raw stack trace, never false cheer.
5. Seed with real events before day 1. Mocks read as mocks.
