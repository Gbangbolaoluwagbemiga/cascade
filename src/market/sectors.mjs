// Sector ETF per filer, for the sector leg of the factor model.
//
// Keyed on SIC because we already have it from EDGAR submissions, so no extra
// classification step or third-party mapping is needed. Where no sector match
// exists we fall back to market-only, which is weaker but honest — the model
// reports `hasSector: false` rather than silently pretending.

const BY_SIC = [
  [/^(3674|3559|3672|3676|3677|3678|3679|3661|3663|3669)$/, "SMH", "semis & electronics"],
  [/^(3711|3713|3714|3715|3716|3751|3792|3694|3465)$/, "XLY", "autos & parts"],
  [/^(3721|3724|3728|3760|3761|3812|3480)$/, "ITA", "aerospace & defence"],
  [/^(2834|2836|8731|2833|3826|3827|3841|3845)$/, "XLV", "pharma & life science"],
  [/^(20\d\d|2111)$/, "XLP", "food & beverage"],
  [/^(2840|2844|2842|2841|3630|3634|2320|2300|3140|3021)$/, "XLP", "household & personal"],
  [/^(5331|5311|5411|5651|5912|5945|5990|5961)$/, "XRT", "retail"],
  [/^(3510|3523|3531|3532|3533|3537|3540|3550|3560|3561|3562|3564|3569|3585)$/, "XLI", "industrials"],
  [/^(2911|1311|1381|1389)$/, "XLE", "energy"],
  [/^(60\d\d|61\d\d|62\d\d|63\d\d)$/, "XLF", "financials"],
  [/^(49\d\d)$/, "XLU", "utilities"],
  [/^(73\d\d|737\d)$/, "XLK", "software & IT"],
];

export const MARKET_PROXY = "SPY";

export function sectorEtf(sic) {
  const key = String(sic ?? "").padStart(4, "0");
  for (const [re, etf, label] of BY_SIC) if (re.test(key)) return { etf, label };
  return { etf: null, label: "no sector match — market-only model" };
}

/** Every ETF we might need, so bars can be fetched in one call. */
export function allEtfs() {
  return [...new Set([MARKET_PROXY, ...BY_SIC.map(([, etf]) => etf)])];
}
