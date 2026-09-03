# Cascade — demo script

**Written for someone who codes and has never traded.** Every trading term is
explained the first time it appears. You do not need to understand markets to
present this well — you need to understand *what the software decides and why*,
and that part is ordinary engineering.

Target length **3:00**. Judges watch many of these; the first fifteen seconds
decide whether they watch the rest.

---

## Before you press record

### The five words you will say

| word | what it means | say it like |
|---|---|---|
| **short** | a bet a price will go **down** | "we bet against it" |
| **long** | a bet a price will go **up** | "we bet on it" |
| **priced in** | everyone already knows, so the price already moved | "the market already reacted" |
| **sigma (σ)** | how unusual a move is *for that particular stock* | "how surprising this move is" |
| **position** | one open bet | "one trade we're holding" |

That is the whole vocabulary. Anything else you can describe in plain language.

### The one idea

> A headline about Company A moves Company A's price in **milliseconds**.
> But the supplier that earns a third of its money from Company A?
> Nobody connects that for **hours**. Cascade trades that gap.

If you say only that and nothing else, the demo still works.

### The one number to have ready

Open the UI and read the header **out loud once before recording** so you are not
surprised on camera:

```
equity · total P/L · realised · open · positions · edges
```

- **equity** — what the practice account is worth now
- **realised** — money from trades already closed. Locked in, cannot change.
- **open** — money on trades still running. Moves every second.
- **edges** — how many company-to-company relationships the graph holds

### Setup checklist

- [ ] `npm start` running, browser at `http://localhost:8787`
- [ ] Market **open** (14:30–21:00 WAT) so prices are live
- [ ] Phone in frame if Telegram is on — a notification landing mid-take is
      strong proof it runs by itself
- [ ] Cascade view selected, **WMT** clicked so the graph is already drawn

---

## 0:00 — 0:20 · The hook

**Say:**

> "When news breaks about a big company, that company's stock moves in
> milliseconds. You are never beating that — there are machines doing it.
>
> But the supplier that earns a third of its revenue from that company? Nobody
> has connected the two yet. That takes hours.
>
> That gap is the entire product."

**On screen:** the cascade graph, still. Do not describe the interface yet.

---

## 0:20 — 0:55 · One real relationship

**Do:** click **SMG** in the graph. The right panel fills.

**Say:**

> "Scotts Miracle-Gro earns thirty-four percent of its revenue from Home Depot.
>
> I did not ask an AI for that. Scotts wrote it in their own annual report to
> the SEC, and this is the document number."

**Do:** **click the accession number.** Let the real SEC filing open for one
second. Then come back.

> "Every relationship in this graph works like that — seventy-eight of them,
> each one traceable to a filing. If it isn't in a filing, Cascade won't trade
> it."

**Why this beat matters:** every other project will *claim* its data is sourced.
Clicking through to the actual government document is the cheapest, strongest
thing in your three minutes.

---

## 0:55 — 1:35 · Watch it think

**Do:** click a headline in **Events on hubs**, or click a hub and press
**Run this cascade**.

**Say:**

> "A cheap model reads every headline and answers one question — is this a real
> event, or is it just commentary? Almost all news is commentary: analyst
> opinions, market recaps, listicles. Those get thrown away."

**Do:** let the graph animate outward.

> "Red in the middle is where the news happened. That price already moved. Too
> late.
>
> Green on the outside is what we want: companies that genuinely depend on it,
> where the market hasn't reacted yet."

**Do:** point at a green node's σ number.

> "This one is at 0.2 sigma. Sigma just means 'how surprising is this move for
> this particular stock'. Under 1 means nothing unusual has happened to it yet —
> nobody has noticed. That's the trade."

**If a judge is technical, add one line:**

> "We strip out the whole market's movement and the sector's movement first, so
> we're only looking at the part nobody can explain."

---

## 1:35 — 2:15 · The part nobody else has

**Do:** scroll to **Refused — and why**.

**Say:**

> "Most trading bots show you what they bought. This one shows you what it
> refused, and why."

**Read two aloud, exactly as written on screen.** For example:

> "'Median daily volume is under two million dollars.'
>
> That check exists because without it, 'exposed and hasn't moved' just finds
> companies nobody trades. Of course they haven't moved — there's nobody there.
> That was the mistake that would have killed this project."

> "And yesterday, Stellantis started union negotiations. Cascade refused all
> three of its suppliers, and said why: *labour talks don't affect customer
> demand*.
>
> Because the relationships are typed. Duolingo earns sixty-one percent of its
> revenue through Apple's App Store. An iPhone recall is irrelevant to Duolingo.
> An App Store fee change is existential. Same relationship, opposite answers —
> and a model works out which is which when the relationship is first created."

**This is your strongest 40 seconds.** If you run long, cut anything else.

---

## 2:15 — 2:40 · It runs by itself and it really trades

**Do:** point at the **agent log** along the bottom.

**Say:**

> "This isn't a dashboard I click. It's a service. Every three minutes it reads
> the news, decides, and acts. Close the laptop and it keeps going.
>
> Orders go through Alpaca's own MCP server — and Cascade runs an MCP server of
> its own pointing the other way, so any Claude or Cursor agent can ask what's
> downstream of an event and get an answer with a citation."

**Do:** switch to the **Portfolio** tab.

> "Every position here shows the company it depends on, the percentage, and the
> filing it came from."

---

## 2:40 — 3:00 · The honest close

**Do:** stay on Portfolio, where the losses are visible. Do not hide them.

**Say:**

> "Two days of practice trading proves nothing about whether a strategy makes
> money, and I'm not going to pretend otherwise. We're down about five percent,
> and most of that was me sizing option trades wrong — which is now fixed and
> written up.
>
> What it does prove is the mechanism: a graph built entirely from companies'
> own filings, firing on real events, refusing for reasons it can state out
> loud, and closing positions when the thesis is spent.
>
> Markets price the obvious in milliseconds. Cascade trades what comes next."

---

## If something goes wrong on camera

| what happens | what to say |
|---|---|
| No green nodes | "Nothing qualifies right now — that's the filter working." Click another hub. |
| Cascade finds 0 material events | "Most news is noise. It fired this morning on a real one." |
| A trade is refused | Perfect — read the reason aloud. It's the best material you have. |
| Something errors | Say so and move on. Judges have seen live demos before; recovering calmly reads better than a rehearsed take. |

**Do not** apologise for the P&L more than once. State it plainly, once, with
confidence, and move on.

---

## Lines worth memorising

- "It trades the ripple, not the splash."
- "No citation, no trade."
- "An iPhone recall is irrelevant to Duolingo. An App Store fee change is existential."
- "Without the liquidity check, 'hasn't moved' just means 'nobody trades it'."
- "Most agents tell you what they bought. This one tells you what it refused."

---

## Thirty-second version

If you only get thirty seconds:

> "News about a big company moves that company's stock instantly. Its suppliers
> take hours. Cascade reads SEC filings to find who depends on whom, checks
> whether the market has noticed yet, and trades the ones it hasn't — and every
> position cites the filing it came from. Here's it refusing three trades
> because labour talks don't affect customer demand."
