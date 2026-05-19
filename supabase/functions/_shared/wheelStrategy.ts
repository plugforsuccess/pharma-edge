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

// Wall-migration check: how many strikes (ladder steps, NOT dollars)
// the call wall must move over the 5-trading-day lookback to count as
// a trend rather than a held pin.
export const WALL_MIGRATION_STRIKE_THRESHOLD = 2
// Distinct prior trading days of history required before the
// migration check will assert a trend / established pin. Below this we
// fail safe to UNKNOWN — a "high pin probability" claim must be
// earned, not assumed from absent data.
export const WALL_MIGRATION_MIN_LOOKBACK_DAYS = 5

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
  /** Reconstructed call-wall position at prior trading days, for the
   *  wall-migration check. The edge function builds these from
   *  gex_history using the SAME wall logic as the live path. Absent /
   *  too few points → migration check returns UNKNOWN (fail safe). */
  wall_history?: WallObservation[]
}

/** Call wall as observed N trading days ago (reconstructed from a
 *  historical GEX snapshot). `call_wall_strike` is null when that
 *  day's snapshot had no qualifying wall. */
export interface WallObservation {
  trading_days_ago: number
  date: string
  call_wall_strike: number | null
}

export type WallTrend =
  | 'TRENDING_UP'
  | 'ESTABLISHED_PIN'
  | 'TRENDING_DOWN'
  | 'UNKNOWN'

export interface WallMigration {
  trend: WallTrend
  /** Which side(s) the strategy should actually sell given the trend.
   *  TRENDING_UP → puts only, TRENDING_DOWN → calls only,
   *  ESTABLISHED_PIN / UNKNOWN → full strangle. */
  trade_side: 'put_only' | 'call_only' | 'full'
  confidence: 'high' | 'reduced' | 'unknown'
  /** Signed strike-ladder steps the call wall moved over the lookback
   *  (+ = wall migrated higher). null when no comparable history. */
  strike_delta_5d: number | null
  /** Where the wall held, for the ESTABLISHED_PIN message. */
  held_strike: number | null
  lookback_trading_days: number | null
  observations: WallObservation[]
  /** Mechanical, display-ready. Risk sentences are verbatim from the
   *  owner's spec; factual numbers are parameterized so the tool never
   *  shows a count it didn't measure. */
  message: string
  warning: boolean
  /** Strikes to actually sell after applying the trade_side filter.
   *  The base §4.3 strikes on WheelDecision are left untouched as the
   *  structural reference. */
  effective_call_strike: number | null
  effective_put_strike: number | null
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
  /** Wall-migration overlay. Runs before the setup is acted on: it
   *  classifies the call wall's 5-trading-day trajectory and restricts
   *  which legs to sell. Always present; UNKNOWN when history is thin. */
  wall_migration: WallMigration
}

// §4.2 — wall identification. For one option wing (call or put),
// pick the strike with the largest dollar notional OI, but only if it
// clears the $500K floor. Below the floor there is "no clear wall".
export function identifyWall(
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

// Nearest index of `strike` on a sorted-ascending strike ladder. Used
// to measure wall movement in LADDER STEPS, not dollars — the spec's
// "2+ strikes" is a step count, and strike spacing varies per name.
function nearestStrikeIndex(ladderAsc: number[], strike: number): number {
  if (ladderAsc.length === 0 || !Number.isFinite(strike)) return -1
  let bestI = 0
  let bestD = Math.abs(ladderAsc[0] - strike)
  for (let i = 1; i < ladderAsc.length; i++) {
    const d = Math.abs(ladderAsc[i] - strike)
    if (d < bestD) {
      bestD = d
      bestI = i
    }
  }
  return bestI
}

// Wall-migration check (owner directive, run before any setup is
// acted on). Classifies the call wall's trajectory over the
// 5-trading-day lookback and restricts which legs to sell.
//
// Fail-safe contract: no comparable history, or a whipsawed wall →
// UNKNOWN. We never claim "high pin probability" without proof, and we
// never fabricate a trend (a one-sided trade) we didn't measure — so
// UNKNOWN keeps the full §4.1-valid strangle but withholds the
// confidence upgrade and surfaces the gap.
export function classifyWallMigration(
  currentCallWall: number | null,
  ladderAsc: number[],
  history: WallObservation[],
  baseCallStrike: number | null,
  basePutStrike: number | null,
): WallMigration {
  const usable = (history ?? [])
    .filter(
      (h) =>
        h &&
        h.call_wall_strike != null &&
        Number.isFinite(h.call_wall_strike) &&
        Number.isFinite(h.trading_days_ago) &&
        h.trading_days_ago >= 1,
    )
    .sort((a, b) => a.trading_days_ago - b.trading_days_ago)

  const full = (
    trend: WallTrend,
    confidence: WallMigration['confidence'],
    delta: number | null,
    held: number | null,
    lookback: number | null,
    message: string,
    warning: boolean,
    side: WallMigration['trade_side'],
  ): WallMigration => ({
    trend,
    trade_side: side,
    confidence,
    strike_delta_5d: delta,
    held_strike: held,
    lookback_trading_days: lookback,
    observations: usable,
    message,
    warning,
    effective_call_strike: side === 'put_only' ? null : baseCallStrike,
    effective_put_strike: side === 'call_only' ? null : basePutStrike,
  })

  if (
    currentCallWall == null ||
    ladderAsc.length === 0 ||
    usable.length === 0
  ) {
    return full(
      'UNKNOWN',
      'unknown',
      null,
      null,
      null,
      'Call wall history unavailable — pin durability cannot be established; ' +
        'no confidence upgrade applied.',
      true,
      'full',
    )
  }

  // The 5-day anchor: the furthest-back observation that is at least
  // the required lookback old. Its presence is what proves "≥5 trading
  // days of history exist" — the owner's check samples 1/3/5d, it does
  // not require 5 distinct sample rows.
  const anchor = [...usable]
    .reverse()
    .find((h) => h.trading_days_ago >= WALL_MIGRATION_MIN_LOOKBACK_DAYS)
  if (!anchor) {
    return full(
      'UNKNOWN',
      'unknown',
      null,
      null,
      null,
      `Call wall history unavailable (need ≥${WALL_MIGRATION_MIN_LOOKBACK_DAYS} ` +
        'prior trading days of GEX snapshots) — pin durability cannot be ' +
        'established; no confidence upgrade applied.',
      true,
      'full',
    )
  }

  const curIdx = nearestStrikeIndex(ladderAsc, currentCallWall)
  const anchorIdx = nearestStrikeIndex(ladderAsc, anchor.call_wall_strike as number)
  const delta = curIdx - anchorIdx // + = wall migrated higher
  const window = anchor.trading_days_ago

  const maxDev = usable.reduce((m, h) => {
    const d = Math.abs(curIdx - nearestStrikeIndex(ladderAsc, h.call_wall_strike as number))
    return d > m ? d : m
  }, 0)

  if (delta >= WALL_MIGRATION_STRIKE_THRESHOLD) {
    return full(
      'TRENDING_UP',
      'reduced',
      delta,
      null,
      window,
      `Call wall has migrated ${delta} strike${delta === 1 ? '' : 's'} higher over ` +
        `${window} trading days. Selling calls in trending regimes has elevated breach risk.`,
      true,
      'put_only',
    )
  }
  if (delta <= -WALL_MIGRATION_STRIKE_THRESHOLD) {
    const moved = Math.abs(delta)
    return full(
      'TRENDING_DOWN',
      'reduced',
      delta,
      null,
      window,
      `Call wall has migrated ${moved} strike${moved === 1 ? '' : 's'} lower over ` +
        `${window} trading days. Put walls may be at risk. Consider call-only strategy.`,
      true,
      'call_only',
    )
  }
  if (maxDev < WALL_MIGRATION_STRIKE_THRESHOLD) {
    return full(
      'ESTABLISHED_PIN',
      'high',
      delta,
      currentCallWall,
      window,
      `Call wall has held at $${fmt(currentCallWall)} for ${window} trading days. ` +
        'High pin probability.',
      false,
      'full',
    )
  }
  // |delta| < threshold but the wall whipsawed mid-window — not a
  // clean pin and not a sustained trend. Don't upgrade confidence.
  return full(
    'UNKNOWN',
    'unknown',
    delta,
    null,
    window,
    `Call wall whipsawed within the ${window}-trading-day window (max ${maxDev} ` +
      'strikes off current) — no stable pin; no confidence upgrade applied.',
    true,
    'full',
  )
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

  // Wall-migration overlay — run before the setup is acted on. Purely
  // additive: it does NOT touch the §4.1 gate or §4.3 base strikes
  // (keeps the §10 golden test invariant), it only classifies the
  // call wall's trajectory and exposes which legs to actually sell.
  const ladderAsc = [...input.strikes]
    .filter((s) => Number.isFinite(s))
    .sort((a, b) => a - b)
  const wallMigration = classifyWallMigration(
    suggestedCallStrike,
    ladderAsc,
    input.wall_history ?? [],
    suggestedCallStrike,
    suggestedPutStrike,
  )

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
    wall_migration: wallMigration,
  }
}
