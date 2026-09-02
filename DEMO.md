# Cascade — demo script

**Target: 3:00.** Judges see many demos. The first fifteen seconds decide whether
they watch the rest.

Record with the market **open** (14:30–21:00 WAT) so prices are live and the
agent can actually fire. Have `npm start` running with `AUTO_TRADE=true
RUN_DAEMON=true`, browser at `http://localhost:8787`, and a terminal ready.

---

## 0:00 — 0:20 · The hook

> "When news breaks, the stock it's about reprices in milliseconds. You are never
> beating that.
>
> But the supplier who books a third of their revenue from that company? That
> takes days. Nobody has connected the two yet.
>
> That gap is the whole product."

**On screen:** the cover image, or the UI sitting idle with the graph visible.
Do not narrate the interface yet.

---

## 0:20 — 0:50 · One real relationship

**Click SMG in the graph.** Right panel opens.

> "Scotts Miracle-Gro books thirty-four percent of its revenue from Home Depot.
> I did not ask a model for that — Scotts wrote it in their own 10-K, and this
> is the accession number.
>
> Sixty-five relationships, every one of them mined from a filing. If it isn't
> in a filing, Cascade won't trade it."

**Point at:** exposure `34.0%`, `FY 2025-09-30`, and the accession
`0000825542-25-000022`. **Click the accession link** — let the actual SEC filing
open for one second. That single click is worth more than a minute of claims.

---

## 0:50 — 1:35 · The cascade fires

**Click a live headline in the right column** (or select HD).

> "This headline just came off the wire. A cheap model triages it — most news is
> analyst chatter, and mapping that would burn the budget on noise."

**The graph propagates outward, ring by ring.**

> "Red in the middle is the epicentre. Already priced. Too late.
>
> Green on the outside is what we want: materially exposed, and the market has
> not moved them yet. Not 'hasn't moved much' — we strip out the market and the
> sector and measure what's left in that stock's own volatility. Under one sigma
> is unnoticed."

**Point at a green node's `z` value.**

> "This one is at zero-point-two-eight sigma. It is exposed and nobody has
> connected it."

---

## 1:35 — 2:10 · The part nobody else has

**Scroll to the refusal log.**

> "Most trading agents show you what they bought. This one shows you what it
> refused."

Read two aloud, verbatim:

> "'Median daily volume is under two million dollars.' — That gate exists because
> without it, 'exposed and hasn't moved' just finds stocks nobody trades. That is
> the failure mode that would have killed this."

> "And this one, from yesterday: Stellantis opened labour negotiations. Cascade
> refused all three of its suppliers — *'labour talks don't affect customer
> demand.'*
>
> Because these edges are typed. Duolingo makes sixty-one percent of its revenue
> through Apple's App Store. An iPhone recall is irrelevant to Duolingo. An App
> Store commission change is existential. Same relationship, opposite answers.
> A model assigns that type once, when the edge is created."

---

## 2:10 — 2:40 · It actually trades

**Switch to the terminal / agent log.**

> "This is not a dashboard. It is a daemon. It watches the wire, triages,
> propagates, gates, sizes and trades on its own — close the laptop and it keeps
> going.
>
> It trades options, because a cascade gives you the three things an option needs
> and a share can't use: a direction, a size of move still unclaimed, and a
> horizon in days. The unclaimed residual picks the strike. The ripple picks the
> expiry."

**Show an order line, then the Alpaca positions.**

> "Orders go through Alpaca's own MCP server. And Cascade runs an MCP server of
> its own, pointing the other way — so any Claude or Cursor agent can ask what
> is downstream of an event and get an answer with a citation."

---

## 2:40 — 3:00 · The honest close

> "Two days of paper trading cannot prove edge, and I am not going to pretend a
> number on a screen means anything.
>
> What it proves is the mechanism: a graph built entirely from companies' own
> disclosures, firing on real events, refusing for reasons it can state out loud,
> and taking positions that each explain themselves in one line.
>
> Markets price the obvious in milliseconds. Cascade trades what comes next."

---

## Notes

- **Do not** apologise for the P&L or dwell on it. State the honest limit once,
  with confidence, and stop.
- **Do** click the accession link. Provenance you can see beats provenance you
  are told about.
- If the live cascade produces nothing green, say so and click a different hub —
  an agent that finds nothing is behaving correctly, and saying that out loud is
  more convincing than a rehearsed hit.
- The refusal log is the differentiator. If you are running long, cut the
  architecture, never the refusals.

## One-liners worth memorising

- "It trades the ripple, not the splash."
- "No citation, no trade."
- "An iPhone recall is irrelevant to Duolingo. An App Store fee change is existential."
- "Without the liquidity gate, 'hasn't moved' just means 'nobody trades it'."
- "Most agents tell you what they bought. This one tells you what it refused."
