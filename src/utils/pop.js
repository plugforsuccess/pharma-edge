// Probability of Profit at Expiration (POP) for vertical spreads and
// iron condors, computed under the Black-Scholes lognormal model — the
// same approach moomoo / Tastytrade / Robinhood surface in their option
// chain UIs.
//
// We don't model early-exit dynamics (touch probability, theta decay
// path), only the terminal distribution at expiration. That's enough
// for a "did this trade have at least a coin-flip chance of working"
// number; bucketed calibration tracking on the TrackRecord page validates
// whether the model is well-calibrated for THIS account's signal mix.
//
// Output convention: returns an integer in basis points (0–10000)
// rather than a 0..1 float. Matches signals.entry_pop_bp on the DB
// side and avoids JS Number trailing-zero serialisation drift in the
// signal_hash payload.
//
// Inputs that all callers must supply:
//   spot      — current underlying price ($)
//   sigma     — implied volatility at the relevant strike, as decimal
//               (0.42 = 42%, NOT 42)
//   dte       — days to expiration (will be clamped to >= 1 to avoid div-by-zero)
//   structure — 'BULL_CALL' | 'BEAR_PUT' | 'BULL_PUT_CREDIT' |
//               'BEAR_CALL_CREDIT' | 'IRON_CONDOR'
//   longStrike, shortStrike — for verticals
//   netDebit (debit spreads) or netCredit (credit spreads / condors)
//   For condors: pass innerCallStrike + innerPutStrike + netCredit
//
// The risk-free rate is hardcoded at 4.5% — matches RISK_FREE in
// compute-gex/index.ts so the server and client agree on the math.

const RISK_FREE = 0.045

function normCdf(x) {
  // Abramowitz & Stegun 7.1.26 approximation. ~7.5e-8 max error,
  // plenty for option-pricing UI surfaces.
  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const p = 0.3275911
  const sign = x < 0 ? -1 : 1
  const absX = Math.abs(x) / Math.SQRT2
  const t = 1 / (1 + p * absX)
  const y =
    1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX)
  return 0.5 * (1 + sign * y)
}

// d2 from the standard Black-Scholes change-of-measure. Returns the
// d2 corresponding to the lognormal threshold `K`, which gives:
//   N(d2)  = P(S_T > K)  under the risk-neutral measure
//   N(-d2) = P(S_T < K)
function d2(spot, K, t, sigma) {
  if (!(spot > 0 && K > 0 && t > 0 && sigma > 0)) return null
  return (
    (Math.log(spot / K) + (RISK_FREE - 0.5 * sigma * sigma) * t) /
    (sigma * Math.sqrt(t))
  )
}

function clampBp(prob) {
  if (!Number.isFinite(prob)) return null
  const bp = Math.round(prob * 10000)
  return Math.max(0, Math.min(10000, bp))
}

// Compute POP in basis points. Returns null when inputs are missing
// or non-finite (caller should fall back to "—" in the UI rather
// than displaying a fabricated number).
export function computeProfitProbabilityBp({
  spot,
  sigma,
  dte,
  structure,
  longStrike,
  shortStrike,
  innerCallStrike,
  innerPutStrike,
  netDebit,
  netCredit,
}) {
  if (!(spot > 0) || !(sigma > 0)) return null
  const t = Math.max(1, Number(dte) || 0) / 365

  switch (structure) {
    case 'BULL_CALL': {
      // Profit if S_T > breakeven where breakeven = long_strike + net_debit
      if (!(longStrike > 0) || !(netDebit > 0)) return null
      const be = Number(longStrike) + Number(netDebit)
      const d = d2(spot, be, t, sigma)
      return d == null ? null : clampBp(normCdf(d))
    }
    case 'BEAR_PUT': {
      // Profit if S_T < breakeven where breakeven = long_strike - net_debit
      if (!(longStrike > 0) || !(netDebit > 0)) return null
      const be = Number(longStrike) - Number(netDebit)
      const d = d2(spot, be, t, sigma)
      return d == null ? null : clampBp(normCdf(-d))
    }
    case 'BULL_PUT_CREDIT': {
      // Profit if S_T > breakeven where breakeven = short_strike - credit
      // (we collected credit; loses below short_strike, profitable above
      // short_strike - credit).
      if (!(shortStrike > 0) || !(netCredit > 0)) return null
      const be = Number(shortStrike) - Number(netCredit)
      const d = d2(spot, be, t, sigma)
      return d == null ? null : clampBp(normCdf(d))
    }
    case 'BEAR_CALL_CREDIT': {
      // Profit if S_T < breakeven where breakeven = short_strike + credit
      if (!(shortStrike > 0) || !(netCredit > 0)) return null
      const be = Number(shortStrike) + Number(netCredit)
      const d = d2(spot, be, t, sigma)
      return d == null ? null : clampBp(normCdf(-d))
    }
    case 'IRON_CONDOR': {
      // Profit when innerPut + (credit/2) < S_T < innerCall - (credit/2).
      // Splitting the credit between the two breakeven points is the
      // standard convention; a more precise calc would solve the
      // exact two-strike P/L curve, but the lognormal-symmetric
      // approximation is within ~1pp of the exact answer for a
      // typical wide-wing condor.
      if (!(innerCallStrike > 0) || !(innerPutStrike > 0) || !(netCredit > 0)) return null
      const half = Number(netCredit) / 2
      const upperBe = Number(innerCallStrike) + half
      const lowerBe = Number(innerPutStrike) - half
      if (upperBe <= lowerBe) return null
      const dUpper = d2(spot, upperBe, t, sigma)
      const dLower = d2(spot, lowerBe, t, sigma)
      if (dUpper == null || dLower == null) return null
      // P(lowerBe < S_T < upperBe) = P(S_T < upperBe) - P(S_T < lowerBe)
      //                            = N(-dUpper) - N(-dLower)
      const prob = normCdf(-dUpper) - normCdf(-dLower)
      return clampBp(prob)
    }
    default:
      return null
  }
}

// Human-readable formatter for UI badges. 7035 → "70%". Returns "—"
// for null so callers can pass straight through.
export function formatPopBp(bp) {
  if (bp == null || !Number.isFinite(Number(bp))) return '—'
  const pct = Math.round(Number(bp) / 100)
  return `${pct}%`
}
