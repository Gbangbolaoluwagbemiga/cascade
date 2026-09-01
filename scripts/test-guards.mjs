// Every silent guard must be shown to fire, on purpose, before its silence is
// evidence of anything. A guard that has never triggered is untested, not clean.
//
// Each case below is a deliberately malformed filing fragment fed through the
// real extractor — not a mock of it.

import { extractConcentrationFacts } from "../src/mining/xbrl.mjs";

const ctx = (id, dims, start = "2025-01-01", end = "2025-12-31") => `
<xbrli:context id="${id}">
  <xbrli:entity><xbrli:segment>
    ${dims.map((d) => `<xbrldi:explicitMember dimension="${d.axis}">${d.member}</xbrldi:explicitMember>`).join("\n    ")}
  </xbrli:segment></xbrli:entity>
  <xbrli:period><xbrli:startDate>${start}</xbrli:startDate><xbrli:endDate>${end}</xbrli:endDate></xbrli:period>
</xbrli:context>`;

const fact = (ctxRef, text, scale = "-2") =>
  `<ix:nonFraction name="us-gaap:ConcentrationRiskPercentage" contextRef="${ctxRef}" scale="${scale}" decimals="3">${text}</ix:nonFraction>`;

const CUSTOMER_AXIS = "us-gaap:MajorCustomersAxis";
const BENCH_AXIS = "us-gaap:ConcentrationRiskByBenchmarkAxis";
const TYPE_AXIS = "us-gaap:ConcentrationRiskByTypeAxis";

const REV = { axis: BENCH_AXIS, member: "us-gaap:SalesRevenueNetMember" };
const AR = { axis: BENCH_AXIS, member: "us-gaap:AccountsReceivableMember" };
const CUST = { axis: TYPE_AXIS, member: "us-gaap:CustomerConcentrationRiskMember" };
const GEO = { axis: TYPE_AXIS, member: "us-gaap:GeographicConcentrationRiskMember" };

const cases = [
  {
    name: "scale guard: percentage points tagged as if a fraction (100x error)",
    // 21.7 with scale 0 -> fraction 21.7, which is 2170%. Must be rejected.
    html:
      ctx("c1", [{ axis: CUSTOMER_AXIS, member: "test:GeneralMotorsMember" }, REV, CUST]) +
      fact("c1", "21.7", "0"),
    expect: (r) => r.suspect.length === 1 && r.facts.length === 0,
    describe: (r) => `suspect=${r.suspect.length} facts=${r.facts.length} reason="${r.suspect[0]?.reason}"`,
  },
  {
    name: "scale guard: a correctly scaled fact still passes",
    html:
      ctx("c2", [{ axis: CUSTOMER_AXIS, member: "test:GeneralMotorsMember" }, REV, CUST]) +
      fact("c2", "21.7", "-2"),
    expect: (r) => r.facts.length === 1 && Math.abs(r.facts[0].fraction - 0.217) < 1e-9,
    describe: (r) => `facts=${r.facts.length} fraction=${r.facts[0]?.fraction}`,
  },
  {
    name: "benchmark guard: receivables concentration is not a revenue edge",
    html:
      ctx("c3", [{ axis: CUSTOMER_AXIS, member: "test:FordMotorCompanyMember" }, AR, CUST]) +
      fact("c3", "18.0"),
    expect: (r) => r.facts.length === 1 && r.facts[0].benchmarkIsRevenue === false,
    describe: (r) => `benchmarkIsRevenue=${r.facts[0]?.benchmarkIsRevenue}`,
  },
  {
    name: "risk-type guard: geographic split on a revenue benchmark is not a customer",
    html: ctx("c4", [{ axis: CUSTOMER_AXIS, member: "test:TWMember" }, REV, GEO]) + fact("c4", "7.2"),
    expect: (r) => r.nonCustomer.length === 1 && r.facts.length === 0,
    describe: (r) => `nonCustomer=${r.nonCustomer.length} facts=${r.facts.length}`,
  },
  {
    name: "anonymous guard: CustomerOneMember is fragility, never an edge",
    html:
      ctx("c5", [{ axis: CUSTOMER_AXIS, member: "test:CustomerOneMember" }, REV, CUST]) +
      fact("c5", "23.0"),
    expect: (r) => r.anonymous.length === 1 && r.facts.length === 0,
    describe: (r) => `anonymous=${r.anonymous.length} facts=${r.facts.length}`,
  },
  {
    name: "aggregate guard: a fused multi-company member is not one counterparty",
    html:
      ctx("c6", [
        { axis: CUSTOMER_AXIS, member: "test:AppliedMaterialsInc.LamResearchCorporationAndASMLMember" },
        REV,
        CUST,
      ]) + fact("c6", "41.9"),
    expect: (r) => r.aggregate.length === 1 && r.facts.length === 0,
    describe: (r) => `aggregate=${r.aggregate.length} facts=${r.facts.length}`,
  },
  {
    name: "aggregate guard: a genuine single name containing 'And' survives",
    html:
      ctx("c7", [{ axis: CUSTOMER_AXIS, member: "test:ProcterAndGambleMember" }, REV, CUST]) +
      fact("c7", "12.0"),
    expect: (r) => r.facts.length === 1 && r.facts[0].counterparty === "Procter And Gamble",
    describe: (r) => `facts=${r.facts.length} counterparty="${r.facts[0]?.counterparty}"`,
  },
];

let failed = 0;
for (const c of cases) {
  const r = extractConcentrationFacts(c.html);
  const pass = c.expect(r);
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${c.name}\n        ${c.describe(r)}`);
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
