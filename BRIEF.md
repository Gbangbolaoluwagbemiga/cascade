# Cascade — build brief

**Read this whole file before writing a line of code.** It is the difference
between shipping the obvious thing and shipping the thing that wins.

---

## 0. The situation

**Alpaca AI Trading Agents Hackathon**, run by lablab.ai.

| | |
|---|---|
| Build window | 28 August – 4 September 2026 (7 days, fully online) |
| Prizes | 🥇 $2,500 · 🥈 $1,500 · 🥉 $1,000 |
| Registrants | ~6,000 (real submissions will be far fewer — see §6) |
| Team | Solo. Gbangbola Oluwagbemiga. |
| Environment | Alpaca **paper trading** — real market data, simulated funds |

**Stated theme:** *"CODE THE NEXT GENERATION OF ALGORITHMIC TRADING… your code
doesn't move money on-chain, it trades the markets… with an autonomous agent at
the wheel."*

**Toolkit the organisers named, in their order of emphasis:**

1. **MCP server** — "the core of the theme"; let Claude/Cursor/VS Code talk to markets
2. **Trading API** — programmatic orders across stocks, options, ETFs, crypto
3. **Alpaca CLI** — built for long-running agent sessions and cron jobs

Whatever we build must be *unmistakably* an autonomous trading agent. Not a data
product with an agent bolted on. This was the failure mode of the first idea we
discarded, and it is the most likely way to lose.

---

## 1. The thesis — read this twice

Every other submission will use an LLM to **predict prices**. News sentiment →
score → trade. Chart image → "analysis" → trade. Perhaps a multi-agent "crew"
that argues about it first.

LLMs are genuinely bad at this. Price prediction is numerical and probabilistic —
their weakest axis. Thirty teams will build it, every P&L curve will be noise
dressed as edge, and the judges will have seen it all by the fourth demo.

**But there is one thing an LLM does better than any trading algorithm in
existence: it knows how things are connected.**

Markets price the obvious in milliseconds. A fab burns down and that ticker gaps
before any human can react — no hackathon project is beating HFT to first-order
news, and any project claiming to is lying.

**The propagation, though, takes hours to days.** Who buys those chips? Which
competitor just gained share? Which equipment supplier now has a replacement
order coming? Which customer three steps downstream is about to miss guidance?

That is not prediction. It is **world knowledge and relationship reasoning** —
exactly what an LLM is best at, and exactly what no quant system can do, because
those relationships do not exist in price data.

> **Cascade trades the ripple, not the splash.**

That sentence is the whole product. If a feature does not serve it, cut it.

---

## 2. What Cascade actually does

An autonomous agent running continuously:

1. **Event detection** — watches news, filings, press releases, unusual volume.
2. **Cascade mapping** — for each material event, builds a causal graph outward:
   direct hit → suppliers, customers, competitors, substitutes → two and three
   hops out.
3. **Exposure scoring** — how materially is each downstream node exposed? Revenue
   concentration, supplier share, segment dependence.
4. **Priced-in check** — has this node already reacted? **This check is the
   entire edge — do not treat it as a detail.** See §2.2 for the correct
   statistic; a flat percentage threshold is wrong.
5. **Liquidity and materiality gates** — see §2.3. Without these, "unmoved"
   selects for untradeable names.
6. **Position** — sized by exposure × confidence, executed through Alpaca.
7. **Exit** — when the residual finally arrives, or on a declared horizon.

Every position carries its causal chain in one readable line:

> *Taiwan fab fire → largest customer is X (34% of supply) → X unmoved → long X*

---

### 2.1 Where a "sourced hop" comes from — DECIDED

Two shapes were possible and picking wrong costs the week:

- **(a) Runtime sourcing** — event fires, LLM web-searches for relationships,
  cites what it finds.
- **(b) Build-time graph, runtime traversal** — mine filings in advance into a
  verified edge store; at runtime the LLM traverses and *ranks* edges it cannot
  invent.

**We are doing (b). This is not optional.**

Why: it converts hallucination from an unfixable runtime risk into a build-time
data-quality problem; it makes "every hop cites a source" structurally true
rather than aspirational; it is fast (local traversal, not live search); and
critically **it is deterministic** — the same event yields the same candidate set
every time, which is the only way the demo can be rehearsed, debugged, or shown
twice. Runtime discovery is undemoable.

The division of labour: **the graph supplies what is connected and by how much,
provably. The LLM decides which of the fifteen verified downstream edges matter
for this specific event, and how much.** Ranking and relevance — its strength.
Never fact retrieval.

**Each stored edge carries:** `from`, `to`, relationship type (customer /
supplier / competitor / geographic), magnitude, **whose revenue the magnitude is
a share of**, fiscal year, accession number, filing URL, and **the verbatim
sentence**. The verbatim sentence is what appears in the UI. No sentence, no edge.

#### Edges are DIRECTIONAL with asymmetric magnitude

A disclosure gives you one direction precisely and its mirror only qualitatively.
ICHR stating *"Lam = 37% of our sales"* means:

- Bad news for **Lam** → ICHR is materially hit (37% of revenue). Tradeable.
- Bad news for **ICHR** → Lam barely notices. One supplier among many.

A symmetric edge will propagate the cascade in the wrong direction and produce
confident garbage — and it is hard to spot, because the *relationship* is real
even when the direction is wrong. **Never infer the reverse magnitude.** Leave it
null; the traversal treats null-magnitude direction as untradeable.

#### Two tiers of disclosure

| Tier | Form | Use |
|---|---|---|
| **Named** | *"Lam Research and Applied Materials accounted for 76% of total sales"* | A graph edge, weighted and cited. **Tradeable.** |
| **Anonymous** | *"three customers accounted for 23%, 19% and 12%"* | A node **fragility attribute** (`customer_concentration: 54%`). Not tradeable alone, but a real confidence input — a node whose revenue is 54% concentrated in three unnamed buyers is structurally fragile even when we cannot name them. |

The UI says so honestly: *"this node is exposed — we cannot prove to whom."*

**Never resolve an anonymous counterparty by inference, however obvious.** When
one filer names Lam and another says "three unnamed customers", industry
structure makes the guess tempting and sometimes near-certain. It stays forbidden
for tradeable edges: the moment a chain contains one inferred hop, the citation
rule is decorative and the entire defence collapses. Inference may inform a
fragility *confidence* score. It may never create an edge.

#### XBRL facts are the PRIMARY extraction path. HTML is fallback.

Filers tag concentration disclosures as XBRL facts with the period and the
counterparty attached by the filer. Lear, extracted this way:

```
LEA → GM        21.7% (FY2025)   21.8% (FY2024)   19.8% (FY2023)
LEA → F         11.5%            11.1%            11.4%
LEA → Mercedes   9.9%            10.5%            10.4%
```

This eliminates three whole classes of problem rather than mitigating them:

- **Period misalignment.** Visteon's HTML table gave three numbers against one
  header cell with no way to know which year each belonged to. XBRL carries
  `2025-01-01..2025-12-31` per fact.
- **Percentage-to-counterparty misassociation.** A prose extractor attaches every
  percentage in the window to the nearest name because proximity is all it has.
  XBRL joins value to counterparty by context ID.
- **Most of the resolver's false-positive surface.** `GeneralMotorsMember` is a
  clean token, not a capitalised n-gram hunted through a sentence.

It also arrives pre-shaped for the asymmetric schema: the fact *is* "21.7% of
Lear's revenue", so direction and magnitude-ownership come attached rather than
inferred.

**And it is a credibility asset, not just an engineering one.** *"We use the
numbers the filer tagged themselves, with the period and counterparty the filer
attached"* is a different claim from *"we parsed prose with a regex"* — it turns
the citation rule from *we quoted the sentence* into *we used the filer's own
structured assertion*. That is close to unattackable on stage, and it answers the
only serious technical objection available against the graph.

**Two traps unique to this path — both yield confident, wrong weights:**

1. **Filter the benchmark axis.** `ConcentrationRiskPercentage` carries
   `ConcentrationRiskByBenchmarkAxis`, and filers tag concentration against
   **accounts receivable** as often as revenue. A 30% AR concentration is a
   credit exposure, not a revenue dependency — cascading on it produces trades
   with no economic basis. Take revenue benchmarks only, and **store the
   benchmark on the edge** so it can be proven. Suspiciously many edges → check
   this first.
2. **Check the scale.** Facts are frequently tagged as pure decimals (`0.217`,
   not `21.7`); the `decimals` attribute says which. Wrong by 100× still looks
   plausible in a table. Assert `0 < share ≤ 1` after normalisation and fail
   loudly rather than storing.

**Anonymous members exist here too** — `CustomerOneMember`, `CustomerAMember`.
The two-tier split applies inside the structured path, not only in HTML fallback.

**Aggregate members are a third form — store, do not discard.** UCTT fuses
Applied/Lam/ASML into one 41.9% fact. That cannot be split without inventing
weights, so it is not a normal edge — but it is real verified disclosure: an
event at *any* member hits UCTT with exposure **bounded above by 41.9%**. Store
as a set-edge with the aggregate as a ceiling and a low-confidence flag, and let
the materiality gate decide. Never split an aggregate into per-member weights.

**Tagging propensity and naming propensity are different variables.** AMBQ tags
14 concentration facts and names none — a filer disciplined about XBRL who yields
nothing tradeable. Tagging looks like a *capability* (tracks filer size, agent,
recency); naming looks like a *situation* (tracks industry structure — you name
when there are three customers and everyone knows anyway). **The universe wants
the intersection.** Anonymous-but-tagged filers remain fragility attributes.

**Naming may be a materiality attestation, not a preference.** Reg S-K requires
naming a ≥10% customer *when the loss of that customer would have a material
adverse effect*. If that is the operative standard — verify the current form
before leaning on it — then named edges are the ones the filer has attested are
material, which makes the tradeable tier self-selecting for exactly the property
we want. If it holds, it belongs in the pitch: *"we only trade dependencies the
filer was legally required to name."*

**HTML fallback is for survey tiering only** (does a share figure exist at all).
Its numbers cannot become edge weights without LLM adjudication from the quote —
so HTML-derived edges cost money and XBRL-derived edges do not. Another reason to
weight the universe toward filers who tag.

#### Extractor gotchas — both fail silently

1. **Inline XBRL splits the percentage.** Tagged numbers are wrapped in elements,
   so stripping tags leaves `46 %` with a space and `/[\d.]+%/` misses it. ICHR
   had 99 spaced occurrences against 25 tight; VC 132 against 61. Use `\s*%`.
2. **Table-form disclosure is invisible to a prose-only extractor.** Concentration
   data frequently lives in tables, especially in segment and customer notes, and
   auto/aerospace suppliers tabulate more than they narrate. A prose-only miner
   reports a clean zero for a filer that disclosed everything.

Both share the same shape and it is the dangerous one: **silent and asymmetric.**
A company that discloses everything looks identical to one that discloses
nothing, and the miner reports success either way.

**Standing defence:** keep two or three known-good disclosers per sector as
canaries. A zero on a canary is a bug in the extractor until proven otherwise.

**Expect a lower yield than it sounds.** Customer-concentration disclosures are
frequently anonymised — *"Customer A accounted for 34% of revenue"* is the
standard form, and resolving Customer A to a ticker is often impossible from the
filing alone. Naming rates are decent in semiconductors, semicap, auto/EV
suppliers, aerospace, pharma CDMOs and contract manufacturers; poor almost
everywhere else.

### DECIDED (13 Aug, post-survey) — named-customer edges, mined hub-first

**Measured, correcting this brief:** auto names counterparties at **63%**, semis
at **20%**. The brief originally named semis as the dense sector; that was wrong,
and it came from two filers (ICHR, UCTT) chosen *because* they were known to
disclose. Survivorship, in the document that warns against survivorship.

**We build (A): named-customer edges. We do NOT reframe around market-access
events** (tariffs, export controls, sanctions) despite ~3.5× edge density and a
livelier news cycle.

Cascade's entire defensibility is one claim: every hop is a dependency the filer
disclosed, quantified, and attested was material. Country-exposure screening is
not novel — a competent analyst does it in a spreadsheet, and several submissions
will have a version of it. Trading a weaker causal claim per edge for volume
trades away the only moat.

**And volume is not the scoring criterion.** This is judged on a demo, not on
uptime. Nothing rewards an agent that finds something to do daily. Five tradeable
hubs is thin for a product and sufficient for a demo — GM and Ford produce
material news most weeks. A precision instrument that fires rarely and is
unarguable beats a dense one that invites *"isn't this just a country screen?"*

### The in-degree problem was mis-diagnosed — mine hub-first

Top-10 in-degree of 2.1 (≈4.2 after alias merge) is **an artefact of mining one
sector in isolation, not a property of named-customer edges.**

Hubs accumulate in-degree from every sector that names them, not from their own.
Mining auto suppliers yields GM and Ford with a few inbound edges. Apple's
in-degree lives across semis, optics, EMS, materials and connectors; Walmart's
lives in consumer staples and household goods. The survey measured the in-degree
of a *sector*, not of a *hub*.

**So select the universe by target, not by sector.** Pick 20–30 mega-hubs — Apple,
GM, Ford, Tesla, Boeing, Airbus, Walmart, Amazon, Costco, Lam, Applied, TSMC,
Nvidia — then find everyone who names them, wherever they file. That is a
full-text-search problem, not a sector-sampling problem, and it puts every mined
edge onto a node that actually generates events. Attacks density without touching
the causal claim.

**Highest-yield untested seam: consumer/retail suppliers.** Retailer
concentration is disclosed constantly and by name, often 20–40% from a single
retailer. Walmart alone may carry more inbound named edges than every auto OEM
combined.

### Conduit counterparties are a TYPE, not noise

Rivian genuinely tags Chase Bank as customer concentration on a revenue
benchmark: receivables are due from Chase because Chase originates Rivian's
retail vehicle financing. Every filter behaved correctly — this is not a bug, and
no filter can separate it, because a conduit is structurally identical to a
customer in XBRL.

**But it is not causally useless.** Chase tightening credit or exiting auto
lending hits Rivian hard. What differs is not validity but **shock semantics**:

| Edge type | Transmits |
|---|---|
| `customer` | demand |
| `conduit_financing` | credit availability |
| `conduit_distribution` | route to market |
| `government` | appropriations, procurement policy |
| `unknown` | nothing — blocks trading until reviewed |

Same graph structure, different physics. An untyped conduit edge fires on the
wrong events, which is worse than not having it: tariff news does not travel down
a financing edge, but a rate shock or a lender exiting a segment does.

**So the adjudication layer types conduits rather than filtering them.** The LLM
assigns `relationship_type` from the disclosure text **once at ingest**, not at
every event. `unknown` is a valid answer and is untradeable.

This also yields a cascade nobody else will demo — *"a bank exits auto lending →
here is the EV maker with 36% of receivables through that bank"* — which reads as
sophisticated precisely because it is not the obvious customer relationship.

### Positionability — CORRECTED. It does not separate retail from auto.

An earlier version of this section claimed retail won on both density and
positionability. That was wrong, and the error is instructive: the 52%
untradeable figure was **hub-side** (VW, Geely, Daimler are OEMs), and **we never
position a hub — only observe it.**

On the dependent side, which is the side we trade: **auto 22/23 positionable,
Walmart 12/12.** Retail wins on **density alone.**

Resolution succeeding and tradeability remain different questions — tradeability
comes from the exchange field, and conflating them produces orders Alpaca
rejects. But it is a per-edge flag, not a universe criterion.

**Hub positionability still matters, for a different purpose:** *event materiality
calibration.* If GM gaps 8%, that is the market sizing the event, and it scales
how far down the graph to propagate. An OTC-quoted VW line cannot tell us that.
Mitigation for foreign hubs: use a US-listed ADR where one exists, else the
sector ETF residual as a coarse read on whether the market reacted. Keeps foreign
hubs usable as **epicentres** while never being positions.

**Report raw in-degree AND post-gate in-degree.** Raw says the graph is
connected; post-gate (§2.3 dollar-volume and materiality floors applied) says it
can fire.

**On the selection criterion:** "prefer hubs whose supplier base files with the
SEC and lists on US exchanges" is **under test and may not survive.** Apple's
dependents in the data (Qorvo, SiTime, Immersion, Pixelworks, Globalstar) are all
US-listed. If Apple returns 8–10 tradeable dependents, the criterion collapses to
the simpler and better **"prefer hubs we can discover properly"** — and the sector
commitment disappears with it.

### Hub discoverability is predictable from supplier-sector naming rates

Semis have **dense supply chains and sparse disclosure** — the relationships
exist, the citations do not. An earlier version of this brief said "semis are
dense" without separating the two, which is the root of the original bad sector
call.

**Working model:** a hub's discoverable in-degree ≈ the naming rate of its
supplier base's sectors, weighted by how much of that base sits in each.

- Apple → suppliers are semis (20% named) → predicted poor
- Auto OEMs → suppliers are auto parts (63% named) → predicted good
- Walmart → suppliers are consumer goods → measurable the same way

This makes universe selection a **prediction computable before mining** rather
than a sweep to be ranked afterwards, and it is falsifiable: predict each
candidate hub's in-degree from its supplier-sector mix, mine, compare. If the
prediction tracks, the remaining universe can be chosen without mining it.

**Check QRVO and SWKS directly** — do they name Apple in prose while tagging an
anonymous member? That distinguishes two very different situations:

- **Pure anonymisation** → the hub is genuinely poor; move on.
- **Named in prose, anonymous in XBRL** → the edges are *recoverable* via HTML
  fallback plus LLM adjudication on that specific set of filers. This is the
  division of labour already built, applied surgically.

### The disclosure threshold is a feature, not a gap

Nothing below ~10% of revenue is disclosed at all, so a hub that is everyone's 6%
customer is invisible however many suppliers it has.

State this positively: **Cascade can only see dependencies material enough to be
disclosed, which is exactly the set worth trading.** A 4% relationship would fail
the materiality gate anyway. The graph's blind spot and the strategy's
indifference are the same line.

### Discovery method is a measurement, and it fails silently too

Target returned 0 and Apple 1 — **not because of common words, but relevance
ranking.** The filings that mention "Target Corporation" most are Target's own,
so suppliers ranked below the result budget. Fix: require concentration language
alongside the name (conjunctive discovery).

This is the fourth instance of one failure shape in this project:

| | measured instead |
|---|---|
| spaced percentages | tight-format disclosures only |
| prose-only extraction | narrated disclosure only |
| sector-scoped in-degree | in-degree of a sector, not a hub |
| relevance-ranked discovery | filings *about* the hub, not filings *naming* it |

Each returned a plausible number while answering a different question.

**Standing guard — pre-registration.** Before reading any measurement, write one
line: *what would make this number low for an uninteresting reason?* "Because my
search ranked Target's own filings first" is an obvious candidate that costs
thirty seconds to think of beforehand and days to discover afterwards.

### Geographic exposure — subordinate, gated, never leads

Keep it as a later density layer for days when no named dependency is in the
news. Gated on proving the extraction end-to-end on one company first. **It does
not go in the pitch and does not lead the demo.** If it ships, it ships labelled:
*"when no named dependency is in the news, here is the weaker signal, and here is
why it is weaker."*

### Default-deny on benchmark axis

The Chase Bank → RIVN 36% leak is most likely a **cash-and-cash-equivalents**
concentration — filers routinely tag "X% of our cash is held at one institution"
with the bank as the member. A bank appears as a customer whenever the filter
*passes* anything not explicitly excluded, including facts with a missing or
unexpected benchmark axis.

**Require an explicit revenue benchmark. Do not exclude known-bad ones.**
Default-deny, not default-allow.

---

**The universe is chosen on measured tagging coverage, not intuition.** Run the
naming-rate survey first — random sample, 30–40 per sector, no cherry-picking —
and report per sector:

1. **% with XBRL-tagged concentration** ← the number that decides the universe.
   These edges need no adjudication: exact on arrival, deterministic, free.
2. % with any concentration disclosure
3. % with a named counterparty
4. % named **and** quantified
5. median tradeable edges per ticker
6. median filing recency (fiscal year stored on every edge)
7. **in-degree distribution over counterparties** — which companies are named
   most often as the target. This predicts how much cascade the graph can
   actually produce, because **events happen at hubs**: 500 edges concentrated on
   fifteen hubs (GM, Lam, Applied, Apple, Walmart) is a working engine; 500 edges
   spread evenly is a directory. A supplier with one named customer contributes
   nothing until that specific customer has news. Report alongside XBRL coverage
   as a headline figure.

**Sectors to sample:** semis/semicap · auto/EV suppliers · aerospace · pharma
CDMO · industrials · **contract manufacturers / EMS** (Jabil, Flex, Celestica,
Sanmina — enormous named concentration, connective tissue between semis and
consumer electronics) · **consumer & retail suppliers** (Walmart/Amazon/Costco
concentration is disclosed constantly and by name, often 20–40% from one
retailer; gives a very dense hub and a structurally *different* cascade — a
retail demand shock hits dozens of named suppliers at once, which diversifies
what we can demo) · **plus one control sector expected to fail** (regional banks
or utilities). If the control also scores 60%, the discriminator is broken and we
need to know before trusting the ranking.

**Capture filer status and filing agent per ticker if cheap.** XBRL tagging
discipline may track filer size, agent and recency more than industry — if it
does, the universe should be selected on tagging propensity and the sector
framing quietly retires.

**Do not mine the whole market.** A dense graph over a narrow universe demos far
better than a sparse one over everything — and
it is honest: *"we mapped the sectors where the relationships are disclosed."*

Mining sources, roughly in yield order: risk factors naming specific
dependencies · concentration-of-credit-risk note · segment and geographic revenue
tables · named material agreements in 8-K Item 1.01 · facility and property
disclosures for geographic exposure. SEC full-text search (`efts.sec.gov`) makes
phrase-level hunting tractable.

---

### 2.2 The priced-in check — vol-normalised, not a flat threshold

A flat "moved 6%" threshold is wrong. Six percent is nothing for a semicap name
and a catastrophe for a utility; a flat rule marks half the universe as priced-in
and lets the rest through wrongly.

**Define priced-in as the residual return after stripping market and sector-ETF
beta, scaled by trailing realised vol — a z-score of unexplained move.**

- Green (unpriced, tradeable): residual **under ~1σ**
- Red (already moved, too late): residual **over ~2σ**
- Beta estimated over a trailing ~60 sessions; realised vol over ~20.

**The same statistic gives the exit for free:** the thesis is spent when the
residual finally arrives. One piece of math, two jobs. Build it once, carefully.

---

### 2.3 Liquidity and materiality gates — prevents the fatal demo bug

Three hops out, many nodes are "unmoved" because **nobody trades them**, not
because the market missed something. Without gates, the green nodes will
systematically be the untradeable ones — a failure a judge who trades will spot
in ten seconds.

- **Dollar-volume floor** — average daily dollar volume minimum (start ~$5M/day)
- **Materiality floor** — exposure below ~5% of revenue is noise, not a thesis
- **Spread check at execution** — if the quoted spread is a meaningful fraction
  of the expected move, there is no trade

Make all three **visible in the UI**, so we are seen to be applying them. Showing
the filter is part of the credibility.

---

### The non-negotiable safety rail

**Every hop must cite a source** — accession number, filing URL, verbatim
sentence. If the edge is not in the verified graph, it does not exist and the
trade does not happen. §2.1 is what makes this enforceable rather than a promise.

A hallucinated supply-chain relationship is the single most likely way this
product embarrasses us on stage. "It only acts on relationships it can prove" is
both the engineering rule and the best line in the pitch.

---

## 3. Why this wins

- **Nobody else is in this category.** We are not competing against thirty
  sentiment bots on execution quality; we are the only entrant with this
  mechanism. Same position Patron was in, and it is the position that wins.
- **It is a defensible thesis, not a vibe.** "Markets price first-order news in
  milliseconds and second-order effects in hours, and an LLM can traverse that
  gap" is an argument a judge who actually trades will respect.
- **It is dead-centre on theme.** An autonomous agent, at the wheel, trading real
  markets through Alpaca, running long sessions. No retrofitting.
- **MCP is native.** Expose the causal engine as an MCP server: *"given this
  event, what is downstream and how exposed?"* Any Claude/Cursor agent can query
  and act on it. That is the theme's stated core doing real work rather than
  wrapping an API.
- **Alpaca is load-bearing twice** — real-time prices power the priced-in check
  (the edge itself), and execution spans stocks/ETFs so a whole cascade can be
  expressed as a basket. Remove Alpaca and the product does not exist.
- **The demo is unforgettable** — see §5.

---

## 4. What we do NOT claim

Seven days cannot establish trading edge. Any team presenting a profitable equity
curve from a week of paper trading is presenting noise, and good judges know it.

**We prove the mechanism, not the P&L.** One real event where Cascade flagged a
non-obvious node that subsequently moved is worth more than any fabricated
backtest. Find that example, and lead with it.

If asked about returns, the honest answer is the strong one: *"Seven days of
paper trading proves nothing about edge and I won't pretend otherwise. What it
proves is that the mechanism fires correctly on real events — here is one."*

---

## 5. The demo (design the product backwards from this)

**A live causal graph.** News breaks. The epicentre lights up red — already
priced, too late. The cascade propagates outward hop by hop. Nodes three steps
out glow green, because they are materially exposed and have not moved. Positions
open on them.

You can *watch the reasoning happen*. Nobody else will have this.

Then a second beat: click any open position and read its chain in plain English,
with every hop's source cited.

Build the UI to make that sequence beautiful. It is the winning artefact.

---

## 6. The competitive reality

6,000 registrants is not the competition. Registration is free and costs nothing
to abandon; on a 7-day hackathon expect low hundreds of real submissions, of
which perhaps **30–50** are deployed, working and demoed competently. That is the
field.

**Our advantages:** we finish things (Patron ran with 26 real users and settled
disputes in a week); our UI is a genuine outlier in a format where most
dashboards are unstyled; we seed with real data rather than mocks.

**Our risks:** solo against teams of up to six; seven days is tight; and the
graph can hallucinate.

**The thing most likely to beat us is our own scope**, not another team. See §9.

---

## 7. The UI bar — this is not optional

SecureFlow, Foreman and Patron all shipped with distinctive, genuinely beautiful
interfaces. That is a large part of why they placed. **Cascade must clear the
same bar, with its own identity.**

Do not reuse Patron's look. Patron was *a ledger in a guild hall* — warm black,
antique gold, serif display face, old-world bookkeeping. Cascade is a different
animal.

### Cascade's identity: an instrument, not a dashboard

The feeling is a **precision instrument in a dark room** — a trading terminal
built by someone with taste. Calm, dense, confident. Nothing decorative.

**Palette**

| Role | Value | Use |
|---|---|---|
| Ground | `#06080B` | page background, near-black, very slightly cool |
| Surface | `#0D1218` | cards, panels |
| Border | `#1B2530` | hairlines, 1px, never heavier |
| Text | `#F2F5F8` | primary |
| Muted | `#93A6B8` | secondary |
| Faint | `#5B7288` | labels, axis, metadata |
| **Signal** | `#7FE3A8` | **the accent — unpriced opportunity, live state** |
| Hot | `#F26B52` | the event, already priced, too late |
| Warn | `#F5C451` | degraded, stale data, low confidence |

One accent. Green means *opportunity that has not been taken yet* — it should
appear rarely enough that the eye goes straight to it.

**Type**

- UI/body: **Inter** (400/500/700). Tight letter-spacing on headings (`-0.03em`).
- Every number, ticker, price, percentage: **a monospace face** (JetBrains Mono
  or IBM Plex Mono). Non-negotiable — tabular figures are what make a financial
  interface feel real. Use `font-variant-numeric: tabular-nums` everywhere.
- Never centre body text. Left-align everything.

**Layout**

- Generous whitespace despite the density. Panels breathe.
- 1px hairline borders, never shadows-as-borders.
- Radius: 10–12px on panels, 6px on controls. Consistent.
- The graph is the hero and gets the largest area on the main view.

**Motion**

- Cascade propagation animates outward hop by hop, ~180ms per ring, eased.
- Everything else is near-instant. No decorative animation anywhere.
- Respect `prefers-reduced-motion`.

**Hard rules learned from Patron:**

- Dark **and** light must both work. Define the full light palette on bare
  `:root`, redefine tokens under `@media (prefers-color-scheme: dark)` and under
  `[data-theme="dark"]`. Never let a colour exist only inside a media query.
- Mobile must not scroll horizontally. Grid children need `minmax(0, 1fr)`, not
  `1fr`. Long tokens (tickers are fine, but hashes and IDs are not) need
  `overflow-wrap: anywhere`.
- **Measure the layout, don't eyeball it.** A headless-Chrome CDP script that
  reports `documentElement.scrollWidth` vs viewport at 360/390/768/1440 found
  bugs in Patron that four rounds of guessing did not.

---

## 8. Architecture

```
Alpaca (market data + execution)
      ▲
      │
CASCADE DAEMON  (Node, long-running — NOT in the browser)
      ├─ event ingestion        news · filings · unusual volume
      ├─ cascade engine         event → causal graph, sourced, 2–3 hops
      ├─ exposure scoring       revenue concentration, supplier share
      ├─ priced-in filter       Alpaca real-time reaction check  ← the edge
      ├─ execution              position sizing, orders, exits
      ├─ MCP server             "what is downstream of this event?"
      └─ SQLite + SSE
      ▼
Web app (live graph, positions, reasoning chains)  +  Telegram feed
```

The agent lives in a daemon, not the page. An agent that only thinks while a tab
is open is a UI, not an autonomous actor. Close the laptop and Cascade keeps
running — this is both true and a good line.

**Telegram** is the distribution channel and it is close to free: push each
detected cascade as it fires (*"⚡ Event → 3 hops → long X, unmoved, 41% revenue
exposure"*). Traders would want that feed even if it never traded. Patron proved
Telegram out-recruits the web app.

---

## 8.1 Decisions taken (13 Aug) — do not relitigate

**Market data: free tier, 15-minute delayed SIP. We are not paying for real-time.**

The thesis is that first-order news is priced in milliseconds and *we are not
competing for it*. Our edge horizon is hours to days. A mechanism that needed
tick-level data would be contradicting its own premise.

Delayed SIP is **consolidated and complete**, which is what a residual-return
calculation on hourly or daily bars actually requires. IEX real-time is neither —
a few percent of volume — and on the mid-caps three hops out it is the worst of
both worlds: you would be calling nodes unmoved on thin, unrepresentative quotes.

Say it plainly on stage: *"We use delayed consolidated data because our edge is
measured in hours, not milliseconds. If this needed real-time ticks it would be a
different and much worse business."* That is a strong answer, not an excuse.

**Event sources**

- **Benzinga** (comes with the Alpaca account) — headline breadth
- **EDGAR 8-K watcher** — higher quality for our purposes: structured, timestamped,
  material by definition. Prioritise **Item 1.01 / 1.02** (material agreement
  entered or terminated) and **Item 2.06** (material impairment) — a terminated
  supply agreement is a disclosed relationship *changing*, i.e. the graph edge
  and the event in the same document. These produce the best cascades.
- Day-2 addition, not a day-1 dependency: Federal Register and BIS entity-list
  RSS, for export controls and regulatory action — the events Benzinga covers
  worst and that cascade furthest.

**Deploy**

Railway for the daemon, Vercel for the web app. Known-good from Patron, and the
deploy path is already understood — **including that neither auto-deploys from
git** (§10.2). Build marker on `/healthz` from the first commit.

**LLM cost control — designed in, not bolted on**

Unbounded cascade mapping over a headline feed burns budget fast. Two stages:

1. **Triage** — a cheap, fast model answers one question: is this event material
   enough to map at all? The overwhelming majority of headlines are not.
2. **Cascade** — only survivors reach the expensive step, and even then the model
   is *ranking pre-verified edges*, not reasoning open-endedly, which keeps the
   context small.

This bounds spend by construction. Set the triage threshold from the monthly
ceiling, not the other way round.

---

## 8.2 The 15 days before the window — the largest lever we have

The window opens 28 August. Nothing in the rules restricts building a dataset
beforehand, and **a graph mined over two weeks is the one asset a six-person team
cannot replicate inside seven days.**

Spend the pre-window on the graph, not on daemon code:

- The filing miner and edge store (§2.1) — highest calendar risk, zero upstream
  dependencies, start immediately
- Universe selection and validation — are the edges real, are the magnitudes
  right, spot-check by hand against the source filings
- Beta/vol baselines for the universe, so the priced-in check has history on
  day 1
- A library of historical events run through the graph, to find the one or two
  clean examples that become the demo (§4)

Arriving on day 1 with a verified graph and a worked example is the difference
between a good demo and an obvious winner.

---

## 9. Seven days

| Day | Deliverable |
|---|---|
| 1 | Event ingestion + Alpaca price/volume reaction check. One real event end to end. |
| 2–3 | **The cascade engine.** Event → graph → exposure, every hop sourced. This is the product; give it the time. |
| 4 | Priced-in filter, position sizing, execution, exits. |
| 5–6 | **The live graph UI** + Telegram feed. Where the win is decided. |
| 7 | MCP server, seeded real examples, demo recording. |

**Cut order if day 5 arrives and the agent is not trading:** drop consensus
signals, drop options, drop the leaderboard, drop anything clever. The
non-negotiables are: real events detected, a graph that propagates and is
beautiful, positions opening on Alpaca with legible reasoning, MCP endpoint live.

**Start collecting real events before day 1.** Nothing in the rules prevents
running ingestion beforehand. Arriving with a library of real cascades — one of
which visibly worked — is what turns a good demo into an obvious winner. This is
exactly what made Patron credible.

---

## 10. How we work (learned expensively on Patron — do not relearn these)

1. **Verify by driving the real thing, not by reading the code.** Every serious
   bug in Patron was found by measuring production, and several "fixes" that
   looked right in the source changed nothing.
2. **Know your deploy path and prove it landed.** Patron's daemon and web app
   both deploy by CLI, not by git push. Hours were lost re-diagnosing bugs
   against production running old code. Put a build marker on a health endpoint
   from day one: commit, boot time, uptime.
3. **Never present an unverified number.** Read figures off the live system
   before they go into a demo, a deck or a post. Patron's dispute figures were
   wrong twice because they were inferred instead of read from the source of
   truth.
4. **Prefer the honest failure message.** A raw stack trace shown to a user is a
   bug. So is a cheerful message about something that did not happen.
5. **Seed with reality.** Real events, real tickers, real reactions. Mocks read
   as mocks.
6. **One idea per screen. One accent colour. Real whitespace.**

---

## 11. Identity

- **Name:** Cascade
- **Tagline:** *Markets price the obvious in milliseconds. We trade what comes next.*
- **Cover image:** `cascade-cover.png` in this folder — the mechanism as a
  diagram: dull red epicentre, dimming grey hops, glowing green unpriced edge.
  The visual language of the whole product is in that image; match it.

**The founder narrative this belongs to:** SecureFlow made escrow trustworthy.
Patron made an AI employer trustworthy. Cascade makes an autonomous trader
*legible* — every position explains itself, sourced, before it is taken.

We build the layer that lets people trust systems they would otherwise be right
to distrust.
