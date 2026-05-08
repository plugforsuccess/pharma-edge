// Black-Scholes second-order Greeks for the Cash Moves exposure layer.
//
// dxFeed's Greeks event delivers delta, gamma, theta, vega, rho, IV —
// but NOT vanna or charm (∂delta/∂σ and ∂delta/∂t respectively). Both
// are second-order, both matter for dealer hedging, and both are cheap
// to compute in-edge from the inputs we already have (spot, strike,
// IV, DTE, r).
//
// Conventions:
//   - All formulas use risk-free rate r = 4.5% (matches RISK_FREE in
//     index.ts). Dividend yield q = 0 — this is an options-on-equity
//     model, not options-on-futures, and dividend cash drift is small
//     enough at <30 DTE that ignoring it is the right tradeoff.
//   - Vanna here is per-unit-of-IV (i.e. % change in delta per 1.0
//     change in σ, NOT per 1% change). Caller should scale if they
//     want "per vol point."
//   - Charm here is per-day (∂delta/∂t in years, divided by 365 to
//     give daily delta decay). Sign convention: charm > 0 means the
//     option's delta moves toward parity (deep-ITM goes to ±1) as
//     time passes; charm < 0 means it bleeds toward 0.
//
// All four exposure measures (GEX, VEX, CEX, DEX) follow the same
// dealer-hedging convention used in index.ts:
//   call OI contributes positively, put OI negatively, scaled by
//   spot² for GEX/VEX/CEX (notional-aware) and spot for DEX.

const R = 0.045

function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI)
}

function normCdf(x: number): number {
  // Abramowitz & Stegun 7.1.26 — same accuracy as scipy.stats.norm.cdf
  // to ~7 decimal places, no external dependency.
  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const p = 0.3275911
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x) / Math.sqrt(2)
  const t = 1 / (1 + p * ax)
  const y =
    1 -
    ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax)
  return 0.5 * (1 + sign * y)
}

function d1d2(spot: number, strike: number, t: number, sigma: number): { d1: number; d2: number } | null {
  if (!(spot > 0 && strike > 0 && t > 0 && sigma > 0)) return null
  const sqrtT = Math.sqrt(t)
  const d1 = (Math.log(spot / strike) + (R + 0.5 * sigma * sigma) * t) / (sigma * sqrtT)
  const d2 = d1 - sigma * sqrtT
  return { d1, d2 }
}

// Gamma — kept here for symmetry with the other Greeks. index.ts has
// its own bsGamma() inline; this is identical.
export function bsGamma(spot: number, strike: number, t: number, sigma: number): number {
  const r = d1d2(spot, strike, t, sigma)
  if (!r) return 0
  return normPdf(r.d1) / (spot * sigma * Math.sqrt(t))
}

// Vanna = ∂delta/∂σ = ∂vega/∂spot.
// Same for calls and puts (sign convention: positive vanna means
// delta rises as σ rises, which holds for OTM calls and ITM puts;
// the OI-side aggregation handles the dealer-direction sign).
//
// Formula: -e^(-q*t) * φ(d1) * d2 / σ ≈ -φ(d1) * d2 / σ (q=0)
export function bsVanna(spot: number, strike: number, t: number, sigma: number): number {
  const r = d1d2(spot, strike, t, sigma)
  if (!r) return 0
  return -normPdf(r.d1) * r.d2 / sigma
}

// Charm = -∂delta/∂t (negative because charm is conventionally
// reported as "delta DECAY per year"; we return per-year here, the
// caller converts to per-day if desired).
//
// Calls:  charm = -φ(d1) * (2*r*t - d2*σ*√t) / (2*t*σ*√t)
// Puts:   charm =  φ(d1) * (2*r*t - d2*σ*√t) / (2*t*σ*√t)  (sign flips)
//
// We return the call-side value; aggregator multiplies puts by -1.
export function bsCharm(spot: number, strike: number, t: number, sigma: number): number {
  const r = d1d2(spot, strike, t, sigma)
  if (!r) return 0
  const sqrtT = Math.sqrt(t)
  const numerator = 2 * R * t - r.d2 * sigma * sqrtT
  const denom = 2 * t * sigma * sqrtT
  if (denom === 0) return 0
  return -normPdf(r.d1) * (numerator / denom)
}

// Delta — needed when dxFeed didn't deliver a delta value (Yahoo
// fallback, or an option whose Greeks event hasn't arrived yet).
// Returns call-side delta in [0,1]; put delta = call delta - 1.
export function bsCallDelta(spot: number, strike: number, t: number, sigma: number): number {
  const r = d1d2(spot, strike, t, sigma)
  if (!r) return 0
  return normCdf(r.d1)
}

// Expected move — 1-stddev underlying move over the given DTE at
// the supplied IV. This is the canonical "options market is pricing
// in ±$X" number. Returned as a dollar amount (so spot=$500, IV=0.20,
// DTE=7 → ~$13.30).
//
// Formula: spot * sigma * sqrt(t).
export function expectedMove(spot: number, sigma: number, daysToExpiration: number): number {
  if (!(spot > 0 && sigma > 0 && daysToExpiration > 0)) return 0
  const t = daysToExpiration / 365
  return spot * sigma * Math.sqrt(t)
}

// Pinning probability heuristic.
//
// Pinning is the empirical observation that spot tends to settle near
// a high-OI strike at expiration when dealers are long gamma there.
// It's not a model-derived probability — there isn't a clean closed
// form. We score 0..1 from three signals:
//
//   1. Concentration: how much of total |GEX| sits at the top strike.
//      0.5 = a single strike holds half the matrix's gamma; 0.1 means
//      gamma is diffuse across many strikes.
//   2. Proximity: how close spot is to the largest-positive (call wall)
//      or largest-negative (put wall) strike, normalized by expected
//      move. Inside 0.5σ → strong pin signal; >2σ → no pin.
//   3. Regime: positive net GEX above flip → pin-friendly; negative
//      net GEX below flip → anti-pin (trending). Modeled as a
//      multiplier (0.3..1.0).
//
// Returns 0..1. Values >0.6 → strong pin setup. <0.3 → no pin.
export function pinningProbability(
  netGex: number,
  largestAbsGex: number,
  totalAbsGex: number,
  spot: number,
  largestStrike: number,
  expectedMoveDollars: number,
): number {
  if (totalAbsGex <= 0 || expectedMoveDollars <= 0 || spot <= 0) return 0

  // 1. Concentration in [0,1]
  const concentration = Math.min(1, largestAbsGex / totalAbsGex)

  // 2. Proximity: distance from spot to wall, in units of expected move.
  //    Tighter clamp than the obvious one — past 2σ the pin signal is gone.
  const distSigma = Math.abs(spot - largestStrike) / expectedMoveDollars
  const proximity = Math.max(0, 1 - distSigma / 2)

  // 3. Regime multiplier: positive net GEX is pin-friendly.
  const regime = netGex > 0 ? 1.0 : 0.3

  // Weight: concentration 40%, proximity 50%, regime 10% (regime is
  // already partially priced into proximity since walls only act as
  // pins in positive-gamma territory).
  return Math.min(1, regime * (0.4 * concentration + 0.5 * proximity + 0.1))
}
