// Concentration edges read from the filer's own XBRL facts.
//
// This is the primary extraction path. We are not parsing prose — we are using
// the structured assertion the filer tagged, with the counterparty and fiscal
// period they attached to it.
//
// Two traps, both of which produce confident and wrong edge weights:
//
//   1. BENCHMARK AXIS. ConcentrationRiskPercentage is tagged against accounts
//      receivable at least as often as against revenue. A 30% AR concentration
//      is a credit exposure, not a revenue dependency; cascading on it would
//      open trades with no economic basis. We keep the benchmark on every fact
//      and only treat revenue-benchmarked ones as tradeable.
//
//   2. SCALE. Values are frequently tagged as decimals (0.217, scale -2) and
//      sometimes as percentage points. Misreading it is a silent 100x error
//      that still looks plausible. We normalise to a fraction and refuse to
//      store anything outside (0, 1] — loudly, rather than guessing.

import * as cheerio from "cheerio";

const CONCENTRATION_CONCEPT = /ConcentrationRiskPercentage/i;

const BENCHMARK_AXIS = /ByBenchmarkAxis/i;
const TYPE_AXIS = /ByTypeAxis/i;
const COUNTERPARTY_AXIS = /MajorCustomersAxis|CustomerAxis|SupplierAxis|ConcentrationRiskByCounterpartyAxis/i;

// Benchmarks that make a fact a revenue dependency.
const REVENUE_BENCHMARK = /SalesRevenue|RevenueFrom|RevenuesMember|SalesMember|RevenueMember/i;
// Benchmarks that explicitly are not, even if the string also matches above.
const NON_REVENUE_BENCHMARK = /Receivable|CreditRisk|Inventory|Purchase|CostOfGoods|AccountsPayable/i;

// A counterparty's name never exists in a standard taxonomy — it can only come
// from the filer's own namespace. Anything in us-gaap, country, srt and friends
// is a structural member, not a company: us-gaap:MinimumMember and
// country:US were both being read as customers before this check.
const STANDARD_NAMESPACES =
  /^(?:us-gaap|srt|country|currency|dei|stpr|naics|sic|exch|ecd|invest|ifrs-full)$/i;

// Members that disclose a counterparty without naming it. Filers phrase these
// every way round — CustomerOneMember, OneCustomerMember,
// TenLargestCustomersMember, CustomerFMember, LargestCustomerMember — so the
// ordinal/qualifier may lead or trail.
// Members that disclose a counterparty without naming it. Filers phrase these
// every way round — CustomerOneMember, OneCustomerMember,
// TenLargestCustomersMember, CustomerFMember, LargestCustomerMember — so counts
// and qualifiers may lead, trail or interleave.
//
// Token matching, not a regex. A case-insensitive `[A-Z]` alternative inside a
// repeated group silently matched any letter, so "Ford Motor Company" was
// consumed letter by letter and classified as anonymous.
const COUNT_TOKENS = new Set([
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "single", "first", "second", "third", "fourth", "fifth", "sixth", "seventh",
  "eighth", "ninth", "tenth",
]);

const QUALIFIER_TOKENS = new Set([
  "largest", "major", "significant", "principal", "top", "key", "primary",
  "certain", "other", "another", "remaining", "additional", "unidentified",
  "individual", "unnamed", "anonymous", "current", "existing", "combined",
]);

// The noun anchor is what keeps this safe: a real company is not called
// "Customers" or "Entities".
const ANONYMOUS_NOUNS = new Set([
  "customer", "customers", "client", "clients", "supplier", "suppliers",
  "vendor", "vendors", "distributor", "distributors", "company", "companies",
  "entity", "entities", "party", "parties", "purchaser", "purchasers",
  "reseller", "resellers",
]);

const isCountToken = (t) => COUNT_TOKENS.has(t) || /^\d+$/.test(t) || /^[a-z]$/.test(t);

/** True when every token is a count, qualifier or generic noun, and a noun is present. */
function isAnonymousMember(displayName) {
  const tokens = String(displayName).toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  let sawNoun = false;
  for (const t of tokens) {
    if (ANONYMOUS_NOUNS.has(t)) { sawNoun = true; continue; }
    if (isCountToken(t) || QUALIFIER_TOKENS.has(t)) continue;
    return false;
  }
  return sawNoun;
}

// Risk types that are not customer relationships. Geographic concentration is
// tagged against a revenue benchmark just like customer concentration is, so
// the benchmark filter alone does not catch it — AEIS discloses US 30.1%,
// MX 14.1%, TW 7.2% this way, which are countries, not counterparties.
const NON_CUSTOMER_RISK =
  /Geographic|Product|Segment|Credit|Supplier|Labor|Market|Equity/i;

/**
 * Aggregate or combined members, which carry a magnitude that belongs to no
 * single counterparty: "TotalCustomerMember", or UCTT's
 * "AppliedMaterialsInc.LamResearchCorporationAndASMLMember" at 41.9%.
 * Splitting a combined figure across its constituents would be inventing
 * weights, so these are excluded from edges entirely.
 *
 * Detection is by multiple corporate-form markers rather than the word "and",
 * so a genuine single name like "Procter And Gamble" survives.
 */
function isAggregateMember(displayName) {
  if (/^(?:total|all|aggregate|combined|various|other|remaining|top)\b/i.test(displayName)) return true;
  const suffixes = displayName.match(/\b(?:Inc|Corp|Corporation|Ltd|Limited|LLC|PLC|Co)\b/gi) || [];
  return suffixes.length >= 2;
}

/**
 * Relationship type — the physics of the edge, not its validity.
 *
 * Every one of these is a real disclosed dependency. What differs is which
 * shock travels along it:
 *
 *   customer             demand         (a guidance cut, a lost programme)
 *   conduit_financing    credit         (a lender exits a segment, rates move)
 *   conduit_distribution route-to-market (a distributor deshelves, a channel shift)
 *   government           appropriations  (a budget, a shutdown, a contract award)
 *   unknown              blocked until reviewed
 *
 * Rivian tags Chase Bank as customer concentration at 36% of revenue, and it is
 * genuinely material — Chase originates its retail financing. But tariff news
 * must not propagate down that edge, while a lender withdrawing from auto
 * lending must. An untyped edge fires on the wrong events, which is worse than
 * no edge.
 *
 * These are heuristic *hints* only. The type is assigned once at ingest by the
 * adjudication step reading the disclosure text — never inferred from the name
 * alone at trade time.
 */
export const RELATIONSHIP_TYPES = [
  "customer",
  "conduit_financing",
  "conduit_distribution",
  "government",
  "unknown",
];

const TYPE_HINTS = [
  [/\b(?:bank|banc|financial|capital|credit|lending|leasing|finance)\b/i, "conduit_financing"],
  [/\b(?:government|federal|dod|defense department|army|navy|air force|usaf|gsa|nasa)\b/i, "government"],
  [/\b(?:distribut|wholesal|reseller|dealer network)\b/i, "conduit_distribution"],
];

/** A starting guess for the adjudication step. Never authoritative. */
export function relationshipTypeHint(counterpartyName) {
  for (const [re, type] of TYPE_HINTS) if (re.test(counterpartyName)) return type;
  return "customer";
}

const localName = (tag) => String(tag || "").split(":").pop().replace(/Member$/i, "");

/** "GeneralMotorsMember" -> "General Motors" */
export function memberToName(tag) {
  return localName(tag)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

function parseContexts($) {
  const contexts = new Map();
  $("*")
    .filter((_, el) => /(^|:)context$/i.test(el.tagName || ""))
    .each((_, el) => {
      const id = $(el).attr("id");
      if (!id) return;

      const dims = [];
      $(el)
        .find("*")
        .filter((__, m) => /explicitmember$/i.test(m.tagName || ""))
        .each((__, m) => {
          dims.push({ dimension: $(m).attr("dimension") || "", member: $(m).text().trim() });
        });

      const pick = (re) =>
        $(el).find("*").filter((__, d) => re.test(d.tagName || "")).first().text().trim() || null;

      contexts.set(id, {
        dims,
        start: pick(/(^|:)startdate$/i),
        end: pick(/(^|:)enddate$/i),
        instant: pick(/(^|:)instant$/i),
      });
    });
  return contexts;
}

/**
 * @returns {{ facts: object[], suspect: object[], anonymous: object[] }}
 *   facts       — named counterparty, revenue benchmark, scale verified. Edges.
 *   anonymous   — disclosed but unnamed counterparty. Fragility attributes.
 *   aggregate   — combined/total members whose magnitude belongs to no one.
 *   nonCustomer — geographic/supplier/credit concentration. Not a cascade edge.
 *   suspect     — failed the scale sanity bound. Never stored as an edge.
 */
export function extractConcentrationFacts(html) {
  const $ = cheerio.load(html);
  const contexts = parseContexts($);

  const facts = [];
  const suspect = [];
  const anonymous = [];
  const aggregate = [];
  const nonCustomer = [];
  const empty = [];

  $("*")
    .filter((_, el) => /nonfraction$/i.test(el.tagName || ""))
    .each((_, el) => {
      const concept = $(el).attr("name") || "";
      if (!CONCENTRATION_CONCEPT.test(concept)) return;

      const ctx = contexts.get($(el).attr("contextref"));
      if (!ctx) return;

      const byAxis = (re) => ctx.dims.find((d) => re.test(d.dimension));
      const benchmarkDim = byAxis(BENCHMARK_AXIS);
      const typeDim = byAxis(TYPE_AXIS);
      let cpDim = byAxis(COUNTERPARTY_AXIS);

      // Some filers put the customer on a custom axis. Fall back to the single
      // dimension that is neither benchmark nor risk-type.
      if (!cpDim) {
        cpDim = ctx.dims.find(
          (d) => !BENCHMARK_AXIS.test(d.dimension) && !TYPE_AXIS.test(d.dimension)
        );
      }
      if (!cpDim) return;

      // Counterparty must come from the filer's own taxonomy.
      const ns = String(cpDim.member).includes(":") ? String(cpDim.member).split(":")[0] : "";
      if (!ns || STANDARD_NAMESPACES.test(ns)) return;

      const benchmark = benchmarkDim?.member || null;
      const isRevenue =
        benchmark != null &&
        REVENUE_BENCHMARK.test(benchmark) &&
        !NON_REVENUE_BENCHMARK.test(benchmark);

      const cellText = $(el).text().trim();
      const rawText = cellText.replace(/[^\d.\-]/g, "");
      const raw = rawText === "" ? NaN : Number(rawText);
      const scale = Number($(el).attr("scale") || 0);
      const sign = $(el).attr("sign") === "-" ? -1 : 1;
      const fraction = sign * raw * Math.pow(10, scale);

      const base = {
        counterpartyMember: cpDim.member,
        counterparty: memberToName(cpDim.member),
        concept,
        benchmark,
        benchmarkIsRevenue: isRevenue,
        riskType: typeDim?.member || null,
        periodStart: ctx.start,
        periodEnd: ctx.end || ctx.instant,
        raw,
        scale,
        fraction,
      };

      // Trap 2: refuse anything outside the sanity bound rather than storing a
      // silent 100x error.
      // Empty or zero-valued facts are not scale errors; conflating them hides
      // whether the scale guard has ever actually caught a 100x mistake.
      if (!Number.isFinite(fraction) || fraction === 0) {
        empty.push({ ...base, reason: `unparseable or zero value ("${cellText.slice(0, 24)}")` });
        return;
      }
      if (fraction < 0 || fraction > 1) {
        suspect.push({ ...base, reason: `fraction ${fraction} outside (0,1]` });
        return;
      }

      // Not a customer relationship at all (geographic, supplier, credit).
      if (typeDim && NON_CUSTOMER_RISK.test(typeDim.member)) {
        nonCustomer.push(base);
        return;
      }

      if (isAnonymousMember(base.counterparty)) {
        anonymous.push(base);
        return;
      }

      if (isAggregateMember(base.counterparty)) {
        aggregate.push(base);
        return;
      }

      facts.push(base);
    });

  return { facts, suspect, empty, anonymous, aggregate, nonCustomer };
}

/**
 * Combined members carry verified disclosure that no single counterparty owns:
 * UCTT's "Applied Materials Inc. Lam Research Corporation And ASML" at 41.9%.
 * Splitting that figure would invent weights, but discarding it throws away a
 * real bound — an event at any constituent hits UCTT with exposure of at most
 * 41.9%.
 *
 * So it becomes a set-edge: the members named, the aggregate as a CEILING, and
 * low confidence. The materiality gate decides whether a ceiling is enough to
 * trade on. Constituents are split from the filer's own label, never inferred;
 * when the split is not clean the raw label is kept and `constituentsParsed`
 * is false, leaving resolution to the graph-build step.
 */
export function aggregateToSetEdges(aggregate, { from }) {
  const latest = new Map();
  for (const f of aggregate) {
    if (!f.benchmarkIsRevenue) continue;
    const prev = latest.get(f.counterpartyMember);
    if (!prev || String(f.periodEnd) > String(prev.periodEnd)) latest.set(f.counterpartyMember, f);
  }

  return [...latest.values()]
    // "Total customers" style members name nobody; they are a node attribute,
    // not a set-edge, and are left to the fragility path.
    .filter((f) => !/^(?:total|all|aggregate|combined|various|other|remaining|top)\b/i.test(f.counterparty))
    .map((f) => {
      const parts = f.counterparty
        .split(/\s+And\s+|(?<=[a-z])\.(?=[A-Z])|\s*,\s*/)
        .map((s) => s.trim())
        .filter((s) => s.length > 2);
      const clean = parts.length >= 2;
      return {
        from,
        type: "customer_revenue_concentration_set",
        constituents: clean ? parts : null,
        constituentsParsed: clean,
        rawMember: f.counterpartyMember,
        rawLabel: f.counterparty,
        magnitudeOf: from,
        magnitudeCeiling: f.fraction,
        magnitude: null, // unknown per constituent, and never guessed
        confidence: "low",
        benchmark: f.benchmark,
        fiscalPeriodStart: f.periodStart,
        fiscalPeriodEnd: f.periodEnd,
      };
    });
}

/**
 * Collapse facts to one edge per counterparty, keeping the most recent period.
 * Direction is explicit and the magnitude belongs to `from` — never mirrored.
 */
export function factsToEdges(facts, { from }) {
  const latest = new Map();
  for (const f of facts) {
    if (!f.benchmarkIsRevenue) continue;
    const key = f.counterpartyMember;
    const prev = latest.get(key);
    if (!prev || String(f.periodEnd) > String(prev.periodEnd)) latest.set(key, f);
  }

  return [...latest.values()].map((f) => ({
    from,
    to: null, // resolved to a ticker downstream; never guessed
    counterparty: f.counterparty,
    counterpartyMember: f.counterpartyMember,
    type: "customer_revenue_concentration",
    // Explicitly a share of `from`'s revenue. The reverse is left unstated.
    magnitudeOf: from,
    magnitude: f.fraction,
    benchmark: f.benchmark,
    fiscalPeriodStart: f.periodStart,
    fiscalPeriodEnd: f.periodEnd,
    reverseMagnitude: null,
  }));
}
