// The priced-in check. This is the edge.
//
// "Has this ticker already reacted?" cannot be answered with a flat percentage.
// A 6% move is noise for a semicap name and a catastrophe for a food producer,
// and half of any move is usually just the market and the sector carrying the
// stock along. What matters is the part of the move that is *unexplained*,
// measured in units of that stock's own volatility.
//
//   residual = actual return − (market + sector explain)
//   z        = residual / (residual volatility × √periods)
//
// Green under ~1σ: materially exposed and the market has not noticed.
// Red over ~2σ: already priced, we are late.
//
// The same statistic is the exit trigger — the thesis is spent when the
// residual finally arrives. One piece of maths doing two jobs.

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

function covariance(xs, ys, mx, my) {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += (xs[i] - mx) * (ys[i] - my);
  return s / (xs.length - 1);
}

const variance = (xs, m) => covariance(xs, xs, m, m);

/** Log returns from a bar series. Log returns aggregate additively over a window. */
export function logReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    if (!(closes[i] > 0) || !(closes[i - 1] > 0)) { out.push(0); continue; }
    out.push(Math.log(closes[i] / closes[i - 1]));
  }
  return out;
}

/**
 * Two-factor fit over the estimation window.
 *
 * The sector ETF is heavily collinear with the market, so regressing on both
 * directly gives unstable betas. We orthogonalise first: strip the market out
 * of the sector series, leaving the sector's own idiosyncratic component. The
 * two regressors are then uncorrelated by construction, which means the
 * multivariate coefficients equal the univariate ones and no matrix inversion
 * is needed.
 */
export function fitFactorModel({ asset, market, sector = null, minObservations = 60 }) {
  const n = asset.length;
  if (n !== market.length) throw new Error(`asset/market length mismatch: ${n} vs ${market.length}`);
  if (sector && sector.length !== n) throw new Error(`sector length mismatch: ${sector.length} vs ${n}`);
  if (n < minObservations) {
    return { ok: false, reason: `only ${n} observations, need ${minObservations}`, n };
  }

  const mm = mean(market);
  const vm = variance(market, mm);
  if (!(vm > 0)) return { ok: false, reason: "market has zero variance", n };

  // Sector component orthogonal to the market.
  let sectorResid = null;
  let betaSectorOnMarket = 0;
  if (sector) {
    const ms = mean(sector);
    betaSectorOnMarket = covariance(sector, market, ms, mm) / vm;
    const alphaS = ms - betaSectorOnMarket * mm;
    sectorResid = sector.map((s, i) => s - (alphaS + betaSectorOnMarket * market[i]));
  }

  const ma = mean(asset);
  const betaMarket = covariance(asset, market, ma, mm) / vm;

  let betaSector = 0;
  let msr = 0;
  if (sectorResid) {
    msr = mean(sectorResid);
    const vsr = variance(sectorResid, msr);
    betaSector = vsr > 1e-12 ? covariance(asset, sectorResid, ma, msr) / vsr : 0;
  }

  const alpha = ma - betaMarket * mm - betaSector * msr;

  const residuals = asset.map(
    (a, i) => a - (alpha + betaMarket * market[i] + betaSector * (sectorResid ? sectorResid[i] : 0))
  );
  const residualSigma = Math.sqrt(variance(residuals, mean(residuals)));

  if (!(residualSigma > 0)) return { ok: false, reason: "residual volatility is zero", n };

  return {
    ok: true,
    n,
    alpha,
    betaMarket,
    betaSector,
    betaSectorOnMarket,
    residualSigma,
    hasSector: Boolean(sector),
  };
}

/**
 * Score an event window against the fitted model.
 *
 * `periods` is how many bars the window spans; residual volatility scales with
 * its square root, so a 3-day move is not judged against a 1-day yardstick.
 */
export function residualZ(model, { assetReturn, marketReturn, sectorReturn = 0, periods = 1 }) {
  if (!model.ok) return { ok: false, reason: model.reason };
  if (!(periods >= 1)) throw new Error(`periods must be >= 1, got ${periods}`);

  const sectorResidReturn = model.hasSector
    ? sectorReturn - model.betaSectorOnMarket * marketReturn
    : 0;

  const expected =
    model.alpha * periods + model.betaMarket * marketReturn + model.betaSector * sectorResidReturn;

  const residual = assetReturn - expected;
  const scale = model.residualSigma * Math.sqrt(periods);
  const z = residual / scale;

  return { ok: true, expected, residual, z, scale, periods };
}

// Thresholds from the brief: green under ~1σ, red over ~2σ.
export const UNPRICED_MAX_Z = 1.0;
export const PRICED_MIN_Z = 2.0;

/**
 * `direction` is the sign the cascade thesis predicts (+1 expects the dependent
 * to rise, -1 to fall). A move in the *opposite* direction is not evidence the
 * thesis is priced in — it is evidence against the thesis, and is reported as
 * such rather than being read as headroom.
 */
export function pricedInVerdict(z, direction = 1) {
  const aligned = z * Math.sign(direction || 1);
  const magnitude = Math.abs(aligned);

  if (aligned <= -PRICED_MIN_Z) {
    return { state: "contradicted", z, aligned, tradeable: false,
      reason: `moved ${magnitude.toFixed(2)}σ against the thesis` };
  }
  if (aligned >= PRICED_MIN_Z) {
    return { state: "priced", z, aligned, tradeable: false,
      reason: `already moved ${aligned.toFixed(2)}σ — we are late` };
  }
  // The unpriced band is symmetric. A drift of -1.5σ against the thesis is not
  // "exposed and unmoved" — it is the market leaning the other way, and taking
  // the position anyway would be trading through contrary evidence.
  if (magnitude >= UNPRICED_MAX_Z) {
    return { state: "partial", z, aligned, tradeable: false,
      reason: aligned > 0
        ? `partially priced at ${aligned.toFixed(2)}σ`
        : `drifting ${magnitude.toFixed(2)}σ against the thesis` };
  }
  return { state: "unpriced", z, aligned, tradeable: true,
    reason: `unexplained move only ${aligned.toFixed(2)}σ — exposed and unmoved` };
}

/** Exit when the ripple arrives: the residual the thesis predicted shows up. */
export function exitVerdict(z, direction = 1, { target = PRICED_MIN_Z } = {}) {
  const aligned = z * Math.sign(direction || 1);
  if (aligned >= target) return { exit: true, reason: `thesis arrived at ${aligned.toFixed(2)}σ`, aligned };
  if (aligned <= -target) return { exit: true, reason: `thesis broken, ${aligned.toFixed(2)}σ against`, aligned };
  return { exit: false, reason: `still developing at ${aligned.toFixed(2)}σ`, aligned };
}
