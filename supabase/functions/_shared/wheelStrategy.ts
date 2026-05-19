// Wheel Strategy decision engine — pure, dependency-free logic.
//
// Implements the build prompt §4.1 (regime detection), §4.2 (wall
// identification) and §4.3 (strike selection) EXACTLY as written. No
// I/O, no clock, no randomness — every output is a deterministic
// function of the input, which is what lets the golden-set fixture
// (build prompt §10) be an exact spec test.
//
// The First Slice stops at regime/walls/strikes. Sizing (§4.5),
// premium validation (§4.6), limit price (§4.7) and the catalyst
// calendar (§4.4 disqualifiers) are Phase 1 — deliberately NOT built
// here. `catalysts_in_window` is threaded through as an opaque
// passthrough so the record shape is stable for Phase 1.
//
// Mechanical language only — this module never says "buy"/"good
// trade"; it reports whether the structural conditions hold.

// Minimum notional open interest for a strike to qualify as a wall
// (§4.2). Notional = OI × 100 (contract multiplier) × strike.
export const WALL_MIN_NOTIONAL = 500_000

export interface WheelInput {
  ticker: string
  spot: number
  /** Dollar net gamma exposure across the matrix slice. */
  net_gex: number
  /** Pin probability on a 0–100 scale (compute-gex returns 0–1; the
   *  edge function multiplies by 100 before calling in). */
  pin_probability: number
  /** 1-stddev underlying dollar move at front-expiry IV. */
  expected_move: number
  /** IV rank 0–100. `null` = could not be sourced → fail closed. */
  iv_rank: number | null
  /** The expiration the walls/regime are evaluated against (§4.2
   *  targets 7–10 DTE; the edge function picks it). */
  expiration: { date: string; dte: number }
  /** Strikes, any order; aligned index-for-index with the OI arrays. */
  strikes: number[]
  /** Per-strike call open interest, aligned to `strikes`. */
  call_oi: number[]
  /** Per-strike put open interest, aligned to `strikes`. */
  put_oi: number[]
  /** Opaque Phase-1 passthrough (earnings/fomc/cpi…). Not evaluated
   *  in the First Slice. */
  catalysts_in_window?: string[]
}

export interface WallSide {
  strike: number
  oi: number
  notional: number
}

export interface WheelDecision {
  ticker: string
  regime: 'A' | 'B'
  /** True iff regime === 'A' AND every §4.1 condition holds. */
  tradeable: boolean
  spot: number
  net_gex: number
  pin_probability: number
  expected_move: number
  iv_rank: number | null
  expiration: { date: string; dte: number }
  call_wall: WallSide | null
  put_wall: WallSide | null
  /** Sell AT the call wall (§4.3). null when no clear call wall. */
  suggested_call_strike: number | null
  /** Sell ONE strike above the put wall — the soft zone (§4.3).
   *  null when no clear put wall. */
  suggested_put_strike: number | null
  conditions: {
    net_gex_positive: boolean
    pin_ok: boolean
    spot_above_put_wall: boolean
    spot_below_call_wall: boolean
    expected_move_ok: boolean
    iv_rank_ok: boolean
  }
  /** Human, mechanical reasons every failed condition produced. Empty
   *  iff tradeable. Rendered inline on the setup screen (§7). */
  disqualify_reasons: string[]
  catalysts_in_window: string[]
}

// §4.2 — wall identification. For one option wing (call or put),
// pick the strike with the largest dollar notional OI, but only if it
// clears the $500K floor. Below the floor there is "no clear wall".
function identifyWall(
  strikes: number[],
  oi: number[],
): WallSide | null {
  let best: WallSide | null = null
  for (let i = 0; i < strikes.length; i++) {
    const strike = strikes[i]
    const contracts = oi[i]
    if (!Number.isFinite(strike) || !Number.isFinite(contracts) || contracts <= 0) continue
    const notional = contracts * 100 * strike
    if (best === null || notional > best.notional) {
      best = { strike, oi: contracts, notional }
    }
  }
  if (best === null || best.notional < WALL_MIN_NOTIONAL) return null
  return best
}

function fmt(n: number): string {
  return Number.isFinite(n)
    ? n.toLocaleString('en-US', { maximumFractionDigits: 2 })
    : String(n)
}

// §4.1 + §4.2 + §4.3 orchestrated. A ticker is Regime A (tradeable)
// only when ALL six §4.1 conditions hold; any failure → Regime B with
// the reason(s) recorded for inline display.
export function evaluateWheelSetup(input: WheelInput): WheelDecision {
  const {
    ticker,
    spot,
    net_gex,
    pin_probability,
    expected_move,
    iv_rank,
    expiration,
  } = input

  const reasons: string[] = []

  const callWall = identifyWall(input.strikes, input.call_oi)
  const putWall = identifyWall(input.strikes, input.put_oi)

  if (callWall === null) {
    reasons.push(`no clear call wall (no strike ≥ $${fmt(WALL_MIN_NOTIONAL)} call notional OI)`)
  }
  if (putWall === null) {
    reasons.push(`no clear put wall (no strike ≥ $${fmt(WALL_MIN_NOTIONAL)} put notional OI)`)
  }

  // §4.1 condition 1: dealers long gamma.
  const netGexPositive = net_gex > 0
  if (!netGexPositive) {
    reasons.push(`net_gex ${fmt(net_gex)} ≤ 0 (dealers not long gamma)`)
  }

  // §4.1 condition 2: pin probability ≥ 35.
  const pinOk = pin_probability >= 35
  if (!pinOk) {
    reasons.push(`pin_probability ${fmt(pin_probability)} < 35`)
  }

  // §4.1 conditions 3 & 4: spot strictly inside the walls.
  const spotAbovePutWall = putWall !== null && spot > putWall.strike
  if (putWall !== null && !spotAbovePutWall) {
    reasons.push(`spot ${fmt(spot)} ≤ put wall ${fmt(putWall.strike)}`)
  }
  const spotBelowCallWall = callWall !== null && spot < callWall.strike
  if (callWall !== null && !spotBelowCallWall) {
    reasons.push(`spot ${fmt(spot)} ≥ call wall ${fmt(callWall.strike)}`)
  }

  // §4.1 condition 5: expected move < 0.8 × distance to nearest wall.
  let expectedMoveOk = false
  if (callWall !== null && putWall !== null) {
    const distToNearestWall = Math.min(
      Math.abs(spot - callWall.strike),
      Math.abs(spot - putWall.strike),
    )
    const threshold = distToNearestWall * 0.8
    expectedMoveOk = expected_move < threshold
    if (!expectedMoveOk) {
      reasons.push(
        `expected move $${fmt(expected_move)} ≥ 0.8 × $${fmt(distToNearestWall)} ` +
          `nearest-wall distance ($${fmt(threshold)})`,
      )
    }
  }

  // §4.1 condition 6: IV rank ≥ 30. iv_rank === null means it could
  // not be sourced — fail closed (do not silently skip the gate).
  let ivRankOk = false
  if (iv_rank === null || iv_rank === undefined || !Number.isFinite(iv_rank)) {
    reasons.push('iv_rank unavailable — gate fails closed')
  } else {
    ivRankOk = iv_rank >= 30
    if (!ivRankOk) {
      reasons.push(`iv_rank ${fmt(iv_rank)} < 30`)
    }
  }

  const conditions = {
    net_gex_positive: netGexPositive,
    pin_ok: pinOk,
    spot_above_put_wall: spotAbovePutWall,
    spot_below_call_wall: spotBelowCallWall,
    expected_move_ok: expectedMoveOk,
    iv_rank_ok: ivRankOk,
  }

  const tradeable =
    callWall !== null &&
    putWall !== null &&
    conditions.net_gex_positive &&
    conditions.pin_ok &&
    conditions.spot_above_put_wall &&
    conditions.spot_below_call_wall &&
    conditions.expected_move_ok &&
    conditions.iv_rank_ok

  // §4.3 — strike selection. Computed whenever the wall exists so the
  // debug/setup screen can show the structure even on a Regime-B
  // ticker; the canonical trade only fires when tradeable.
  const suggestedCallStrike = callWall !== null ? callWall.strike : null
  const suggestedPutStrike = putWall !== null ? putWall.strike + 1 : null

  return {
    ticker,
    regime: tradeable ? 'A' : 'B',
    tradeable,
    spot,
    net_gex,
    pin_probability,
    expected_move,
    iv_rank: iv_rank ?? null,
    expiration,
    call_wall: callWall,
    put_wall: putWall,
    suggested_call_strike: suggestedCallStrike,
    suggested_put_strike: suggestedPutStrike,
    conditions,
    disqualify_reasons: reasons,
    catalysts_in_window: input.catalysts_in_window ?? [],
  }
}
