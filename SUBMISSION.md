# Cascade — one-page write-up

**Alpaca AI Trading Agents Hackathon** · Gbangbola Oluwagbemiga (solo)
Repo: https://github.com/Gbangbolaoluwagbemiga/cascade · Paper account: `PA39JCS4DLS9`

> Markets price the obvious in milliseconds. Cascade trades what comes next.

---

## The AI logic

Every other approach points a language model at price prediction — its weakest
axis. Cascade points it at the one thing it does better than any trading system:
**knowing how things are connected.**

A fab burns down and that ticker gaps before a human can react. But the
*propagation* — who buys from them, whose guidance is now at risk, which supplier
three steps out is materially exposed and hasn't moved yet — takes hours to days.
That gap is a relationship problem, not a forecasting one.

**The model never discovers a relationship.** Edges are mined in advance from
filers' own **XBRL concentration facts** — structured data companies tag
themselves in their 10-K, with the counterparty, the share of revenue and the
fiscal period attached. Every edge carries an SEC accession number and a URL.
65 edges across 60 companies, each one citable.

This matters legally: under **ASC 280-10-50-42**, a company with a ≥10% customer
*must* disclose the amount and **need not disclose the identity**. So when a
filer names General Motors at 21.7% of revenue, that identity is volunteered — a
materiality judgement they made and signed. We only trade dependencies filers
chose to put their name on.

The LLM does two jobs, in two stages so cost is bounded by construction:

1. **Triage** (`openai/gpt-oss-20b`, every headline) — is this a material event,
   or is it a price target, a peer comparison, a listicle? Most news is the latter.
2. **Adjudication** (`openai/gpt-oss-120b`, once per edge at ingest) — assign the
   edge's *type*, because every dependency is real but each transmits a different
   shock. `customer` transmits demand; `conduit_financing` transmits credit;
   `conduit_distribution` transmits route-to-market; `government` transmits
   appropriations; `unknown` is blocked from trading.

The clearest case in the live graph: **Duolingo derives 61.6% of revenue through
Apple's App Store.** The model classified it `conduit_distribution` unprompted —
*"Apple provides platform, takes commission, not ownership."* So:

```
blocked   DUOL ← AAPL   "Apple recalls iPhone 17 over battery defect"
TRAVELS   DUOL ← AAPL   "Apple cuts App Store commission to 15% under DMA ruling"
```

Same edge, same 61.6%, opposite answers. An untyped graph fires on the wrong
events, which is worse than having no edge.

---

## The risk gates

**The edge itself is a gate.** "Has this already moved?" cannot be answered with
a percentage — a 6% move is noise for a semicap name and a catastrophe for a food
producer, and half of any move is the market and sector carrying the stock along.

```
residual = actual return − (market β + sector β explain)
z        = residual ÷ (residual volatility × √periods)
```

Under 1σ: exposed and unmoved — **this is the trade**. Over 2σ: already priced,
we're late. Moving *against* the thesis is reported as contradicted, not as
headroom. The same statistic is the exit trigger: the thesis is spent when the
residual arrives.

Six gates, and **every refusal is output** — an agent that only reports what it
bought is not legible:

| Gate | Refuses when | Why |
|---|---|---|
| `relationship_type` | edge type unknown | untyped edges fire on wrong events |
| `positionable` | not on a tradeable exchange | avoids orders the broker rejects |
| `materiality` | exposure < 5% of revenue | below this it's noise |
| `liquidity` | median daily volume < $2M | **"unmoved" must not mean "untraded"** |
| `priced_in` | \|z\| ≥ 1σ | the market already has it |
| `shock_type` | this shock doesn't travel this edge | real dependency, wrong channel |

The liquidity gate is the one that matters most: without it, "exposed and
unmoved" systematically selects illiquid names — the fatal failure mode. On a
live Amazon cascade it refused 6 of 11 dependents, one trading $0.01M a day.

The shock-type gate refused an entire Stellantis cascade in production: *"Labour
talks don't affect customer demand"* — three auto suppliers we'd otherwise have
shorted on a story that doesn't touch them.

Position sizing is exposure × confidence, where confidence decays as the residual
approaches the priced-in threshold, capped at 5% of equity per name and 25% per
cascade.

---

## Options — the cascade's natural expression

A cascade produces three things a share position cannot use, and an option needs
exactly: a **direction** (the thesis sign), a **magnitude** (how much residual is
still unclaimed, in σ) and a **horizon** (the ripple arrives in days). So the
residual gap sizes the strike, the ripple horizon sets the expiry, and long
premium gives an autonomous agent defined, known-in-advance downside.

Options carry their own liquidity gate, because the equity gate says nothing
about them — deep OTM contracts routinely quote with a zero bid. On a live Home
Depot cascade the agent took SMG, SWK and FBIN as puts and refused JELD, UFPI,
GFF and UE at 88–137% spreads, falling back to shares there.

## The Alpaca implementation

Alpaca is load-bearing in four places; remove it and the product does not exist.

**Alpaca's official MCP server is the execution path.** Cascade launches
`alpaca-mcp-server` over stdio and places every order through its
`place_option_order` / `place_stock_order` tools, falling back to REST only if
the server cannot start — and recording which route each order took. There are
two MCP surfaces here pointing opposite ways: Cascade's own server exposes the
causal engine *outward* so any agent can query it; Alpaca's server is what
Cascade calls *inward* to trade.

- **Market data** — daily and hourly bars drive the entire priced-in calculation.
  We use **delayed consolidated SIP deliberately**: the edge horizon is hours, so
  a mechanism needing tick data would contradict its own thesis, and IEX
  real-time is a few percent of volume — exactly wrong for the mid-caps three
  hops out. Events under 3 days old are scored on **hourly** bars, because a
  same-day event has no daily bar after it and the agent must react within the
  horizon it claims.
- **News** — the Benzinga feed is one of two event sources. The daemon polls
  headlines on graph hubs, triages them with a cheap model, and cascades the
  survivors. The second source is the **EDGAR 8-K watcher**: a headline is
  somebody's judgement that something mattered, an 8-K is the company's own,
  with a numbered item saying what kind of event it was. Item 1.02 —
  termination of a material definitive agreement — is a disclosed relationship
  *ending*, so the graph edge and the event arrive in the same document.
- **Execution** — paper orders, sized and submitted, with short sales converted to
  whole shares (Alpaca rejects fractional quantities on a short).

Architecture: a **Node daemon** that runs continuously — close the laptop and it
keeps working — serving a web UI, a JSON API and an **MCP server** in one
process. The MCP server exposes the causal engine over stdio so any Claude or
Cursor agent can ask *"what is downstream of this event, and where's the
citation?"* and get an answer no other tool can give.

`/healthz` carries the commit SHA, uptime, edge count, gate configuration and
whether Alpaca and the LLM are actually reachable — so which code is live is
provable, not assumed.

---

## What we don't claim

Seven days of paper trading cannot establish edge, and any equity curve from that
window is noise. **We prove the mechanism, not the P&L.** What the run
demonstrates is that a graph built entirely from filers' own structured
disclosures fires correctly on real events, refuses for reasons it can state, and
takes positions that each explain themselves in one line with a citation.
