// Server-side thesis verdict logic.
//
// **Keep in sync with `src/utils/thesisVerdict.js`.** Same rules,
// same wording. Edge functions can't share modules with the Vite
// frontend (Deno vs Node + different bundle layout), so we duplicate
// the logic and pin them via comment + same test fixtures.
//
// See the frontend file for the full rationale + verdict ladder.

const STRIKE_DRIFT_THRESHOLD = 3
const STRIKE_GEX_REINFORCE_RATIO = 1.3
const STRIKE_GEX_MELT_RATIO = 0.5
const DEX_FLIP_MAGNITUDE_RATIO = 0.1
const VEX_FLIP_MAGNITUDE_RATIO = 0.1
// Regime-flip deadband — see src/utils/thesisVerdict.js for rationale.
const REGIME_DEADBAND_RATIO = 0.10
const REGIME_DEADBAND_FLOOR = 20_000_000
// Pin-thesis thresholds scaled by spot — see src/utils/thesisVerdict.js.
// Calibrated so $100 spot → $5/$8 (matches original absolute thresholds).
const PIN_DRIFT_PCT = 0.05
const PIN_INVALIDATE_PCT = 0.08
// Entry-spot-equals-target tolerance — see src/utils/thesisVerdict.js.
const ENTRY_SPOT_AMBIGUOUS_TOLERANCE = 0.25

export interface EntrySnapshot {
  spot: number | null
  net_gex: number | null
  // Signed dealer-book net delta. Calls positive, puts negative; same
  // convention as compute-gex's MatrixOutput. Optional for legacy
  // snapshots predating the field.
  net_dex?: number | null
  // Signed dealer-book net vanna exposure. Optional for legacy snapshots.
  net_vex?: number | null
  // Signed GEX at the trade's short strike, summed across the matrix's
  // expirations. Optional for legacy snapshots.
  wall_gex_at_short_strike?: number | null
  largest_wall: { strike: number; expiration: string; gex_net: number } | null
}

export interface LiveSnapshot {
  spot: number | null
  net_gex: number | null
  net_dex?: number | null
  net_vex?: number | null
  wall_gex_at_short_strike?: number | null
  largest_wall: { strike: number; expiration: string; gex_net: number } | null
}

export interface TradeShape {
  long_strike: number
  short_strike: number
  strategy_type: string
  expiration?: string | null
  // Phase 3a structured thesis fields. When present, the verdict
  // takes the structured fast-path; when null, falls back to the
  // strategy_type-derived heuristics for legacy v1/v2 signals.
  target_king_node?: 'call_wall' | 'put_wall' | 'flip' | null
  target_strike?: number | null
  target_expiration?: string | null
  target_thesis_kind?: 'pin_to' | 'break_through' | 'fade' | null
  regime_at_entry?: 'A' | 'B' | 'mixed' | null
  // Audit #12: production callers pass remaining DTE + live P&L so
  // the structured verdict can width-scale the pin band and
  // cross-check against the market mark. Optional — fixtures and
  // legacy callers omit them (multiplier 1.0, P&L check skipped).
  dte?: number | null
  pnl_pct?: number | null
}

export type VerdictState = 'intact' | 'drifting' | 'invalidated' | 'not_evaluable'

export interface Verdict {
  state: VerdictState
  reasons: string[]
}

export function computeThesisVerdict(
  entry: EntrySnapshot | null,
  live: LiveSnapshot | null,
  trade: TradeShape,
): Verdict {
  // Hard gates — only spot is required on both sides. net_gex is
  // OPTIONAL because compute-gex's Yahoo fallback path doesn't always
  // populate it. See src/utils/thesisVerdict.js for the full rationale.
  if (!entry || !Number.isFinite(entry.spot)) {
    return { state: 'not_evaluable', reasons: ['No entry snapshot — signal logged before dynamic-thesis tracking landed.'] }
  }
  if (!live || !Number.isFinite(live.spot)) {
    return { state: 'not_evaluable', reasons: ['No live spot price right now — try refreshing in a moment.'] }
  }

  const reasons: string[] = []
  let state: VerdictState = 'intact'

  // Phase 3a structured fast-path. See src/utils/thesisVerdict.js for
  // the full rationale; mirror in lock-step.
  if (trade.target_thesis_kind && Number.isFinite(Number(trade.target_strike))) {
    return computeStructuredVerdict(entry, live, trade)
  }

  // Regime-flip with deadband — mirror src/utils/thesisVerdict.js.
  // trade.regime_at_entry intentionally ignored; both sides classified
  // by the same function with entry's magnitude as the reference.
  if (Number.isFinite(entry.net_gex) && Number.isFinite(live.net_gex)) {
    const entryRegime = regimeFromNetGex(entry.net_gex!, entry.net_gex)
    const liveRegime = regimeFromNetGex(live.net_gex!, entry.net_gex)
    if (entryRegime !== liveRegime && entryRegime !== 'mixed' && liveRegime !== 'mixed') {
      reasons.push(`Regime flipped ${entryRegime} → ${liveRegime} since entry. Dealer hedging dynamics have inverted.`)
      state = 'invalidated'
    }
  }

  // Wall pierced — context-aware. See src/utils/thesisVerdict.js
  // for the full rationale; mirror in lock-step.
  const PIERCE = 0.5
  const wallGex = entry.largest_wall?.gex_net
  const isBullish = ['BULL_CALL', 'BULL_PUT_CREDIT'].includes(trade.strategy_type)
  const isBearish = ['BEAR_PUT', 'BEAR_CALL_CREDIT'].includes(trade.strategy_type)
  const wallType: 'call' | 'put' | null =
    Number.isFinite(wallGex) && (wallGex as number) > 0
      ? 'call'
      : Number.isFinite(wallGex) && (wallGex as number) < 0
        ? 'put'
        : isBullish
          ? 'call'
          : isBearish
            ? 'put'
            : null
  // Tracks whether spot pierced the trade's directional wall IN THE
  // TRADE'S FAVOR. Mirrors src/utils/thesisVerdict.js — same gating.
  let breakThroughFired = false
  const entryWallStrike = entry.largest_wall?.strike
  if (Number.isFinite(entryWallStrike) && entryWallStrike != null && wallType) {
    const crossedUp = entry.spot! < entryWallStrike && live.spot! >= entryWallStrike + PIERCE
    const crossedDown = entry.spot! > entryWallStrike && live.spot! <= entryWallStrike - PIERCE
    if (wallType === 'call' && crossedUp) {
      if (isBullish) {
        reasons.push(`Spot broke through the entry call wall at ${formatStrike(entryWallStrike)} — resistance failed, structural target zone. Check the P&L card.`)
        breakThroughFired = true
      } else if (isBearish) {
        reasons.push(`Spot pierced the entry call wall at ${formatStrike(entryWallStrike)}. Bullish breakout — bearish thesis broken.`)
        state = 'invalidated'
      }
    }
    if (wallType === 'put' && crossedDown) {
      if (isBearish) {
        reasons.push(`Spot broke through the entry put wall at ${formatStrike(entryWallStrike)} — support failed, structural target zone. Check the P&L card.`)
        breakThroughFired = true
      } else if (isBullish) {
        reasons.push(`Spot pierced the entry put wall at ${formatStrike(entryWallStrike)}. Bearish breakdown — bullish thesis broken.`)
        state = 'invalidated'
      }
    }
  }

  if (state === 'invalidated') {
    return { state, reasons }
  }

  // Drift — context-aware. See src/utils/thesisVerdict.js for the
  // full rationale; mirror in lock-step.
  if (entry.largest_wall && live.largest_wall && !breakThroughFired) {
    const entryStrike = Number(entry.largest_wall.strike)
    const liveStrike = Number(live.largest_wall.strike)
    const targetStrike = Number(trade.short_strike)
    const tradeExpiration = trade.expiration ?? null
    const STRIKE_TARGET_TOLERANCE = 1
    const liveAtTradeTarget =
      Number.isFinite(targetStrike) &&
      Math.abs(liveStrike - targetStrike) <= STRIKE_TARGET_TOLERANCE
    const liveExpAtTradeExp =
      tradeExpiration != null && live.largest_wall.expiration === tradeExpiration

    // Wall-running-past-target safe-harbor (audit #10). Mirror of
    // src/utils/thesisVerdict.js.
    const liveWallPastTargetInFavor =
      Number.isFinite(targetStrike) &&
      ((isBullish && liveStrike > targetStrike + STRIKE_TARGET_TOLERANCE) ||
        (isBearish && liveStrike < targetStrike - STRIKE_TARGET_TOLERANCE))

    if (Number.isFinite(entryStrike) && Number.isFinite(liveStrike)) {
      const strikeDrift = Math.abs(liveStrike - entryStrike)
      if (strikeDrift >= STRIKE_DRIFT_THRESHOLD) {
        if (liveAtTradeTarget && liveExpAtTradeExp) {
          reasons.push(`Dominant wall has migrated to ${formatStrike(liveStrike)} @ ${live.largest_wall.expiration} — your structural target zone. Thesis playing out.`)
        } else if (liveAtTradeTarget) {
          reasons.push(`Dominant wall now at ${formatStrike(liveStrike)} — your trade's short strike. Strike target reached.`)
        } else if (liveWallPastTargetInFavor) {
          const direction = isBullish ? 'above' : 'below'
          reasons.push(`Dominant wall has run to ${formatStrike(liveStrike)} — past your ${formatStrike(targetStrike)} target ${direction} entry's level. Dealer book reconcentrated in your direction.`)
        } else {
          reasons.push(`Dominant wall shifted from ${formatStrike(entryStrike)} → ${formatStrike(liveStrike)}. Thesis anchor moved.`)
          state = 'drifting'
        }
      }
    }
    // Loosened safe-harbor: wall expiration migrating TO the trade's
    // expiration is movement toward the trade, regardless of strike.
    if (
      entry.largest_wall.expiration !== live.largest_wall.expiration &&
      !liveExpAtTradeExp
    ) {
      reasons.push(`Dominant wall expiration moved from ${entry.largest_wall.expiration} → ${live.largest_wall.expiration}. Different cluster anchoring the regime now.`)
      state = 'drifting'
    }
  }

  // Wall at YOUR strike — trade-specific anchor health. See client
  // module for full rationale; mirror in lock-step.
  const entryGAtK = entry.wall_gex_at_short_strike ?? null
  const liveGAtK = live.wall_gex_at_short_strike ?? null
  if (
    !breakThroughFired &&
    Number.isFinite(entryGAtK) &&
    Number.isFinite(liveGAtK) &&
    Math.abs(entryGAtK as number) > 0
  ) {
    const e = entryGAtK as number
    const l = liveGAtK as number
    const signFlipped =
      Math.sign(e) !== 0 && Math.sign(l) !== 0 && Math.sign(e) !== Math.sign(l)
    const magnitudeRatio = Math.abs(l) / Math.abs(e)
    if (signFlipped) {
      reasons.push(`Wall at your ${formatStrike(trade.short_strike)} strike flipped sign (${fmtMillions(e)} → ${fmtMillions(l)}). Structure inverted since entry.`)
      state = 'drifting'
    } else if (magnitudeRatio < STRIKE_GEX_MELT_RATIO) {
      reasons.push(`Wall at your ${formatStrike(trade.short_strike)} strike melted to ${Math.round(magnitudeRatio * 100)}% of entry. Anchor eroding.`)
      state = 'drifting'
    } else if (magnitudeRatio > STRIKE_GEX_REINFORCE_RATIO) {
      reasons.push(`Wall at your ${formatStrike(trade.short_strike)} strike reinforcing (+${Math.round((magnitudeRatio - 1) * 100)}% since entry).`)
    }
  }

  // Net DEX flip — independent axis from GEX. See client module for
  // full rationale; mirror in lock-step.
  const entryDexVal = entry.net_dex ?? null
  const liveDexVal = live.net_dex ?? null
  if (
    !breakThroughFired &&
    Number.isFinite(entryDexVal) &&
    Number.isFinite(liveDexVal) &&
    Math.abs(entryDexVal as number) > 0
  ) {
    const eD = entryDexVal as number
    const lD = liveDexVal as number
    const dexSignFlipped =
      Math.sign(eD) !== 0 && Math.sign(lD) !== 0 && Math.sign(eD) !== Math.sign(lD)
    const liveDexMeaningful = Math.abs(lD) > DEX_FLIP_MAGNITUDE_RATIO * Math.abs(eD)
    if (dexSignFlipped && liveDexMeaningful) {
      const dealerBehavior = lD > 0 ? 'now buy rallies' : 'now sell rallies'
      const againstTrade = (isBullish && lD < 0) || (isBearish && lD > 0)
      if (againstTrade) {
        reasons.push(`Net DEX flipped ${fmtMillions(eD)} → ${fmtMillions(lD)}. Dealers ${dealerBehavior} — headwind for your direction.`)
        state = 'drifting'
      } else if (isBullish || isBearish) {
        reasons.push(`Net DEX flipped ${fmtMillions(eD)} → ${fmtMillions(lD)}. Dealers ${dealerBehavior} — tailwind for your direction.`)
      }
    }
  }

  // Net VEX flip — vega-sensitivity gated by strategy_type. See
  // src/utils/thesisVerdict.js for full rationale; mirror in lock-step.
  const isDebitVertical = ['BULL_CALL', 'BEAR_PUT'].includes(trade.strategy_type)
  const entryVexVal = entry.net_vex ?? null
  const liveVexVal = live.net_vex ?? null
  if (
    !breakThroughFired &&
    Number.isFinite(entryVexVal) &&
    Number.isFinite(liveVexVal) &&
    Math.abs(entryVexVal as number) > 0
  ) {
    const eV = entryVexVal as number
    const lV = liveVexVal as number
    const vexSignFlipped =
      Math.sign(eV) !== 0 && Math.sign(lV) !== 0 && Math.sign(eV) !== Math.sign(lV)
    const liveVexMeaningful = Math.abs(lV) > VEX_FLIP_MAGNITUDE_RATIO * Math.abs(eV)
    if (vexSignFlipped && liveVexMeaningful) {
      if (isDebitVertical) {
        reasons.push(`Net VEX flipped ${fmtMillions(eV)} → ${fmtMillions(lV)}. Dealer vol-hedging regime inverted — vega-sensitive trade exposed.`)
        state = 'drifting'
      } else {
        reasons.push(`Net VEX flipped ${fmtMillions(eV)} → ${fmtMillions(lV)}. Informational only — your structure is roughly vega-neutral.`)
      }
    }
  }

  // Net GEX transition-zone collapse. Suppressed when breakThroughFired
  // for the same reason as the wall checks above.
  const entryAbs = Math.abs(entry.net_gex!)
  const liveAbs = Math.abs(live.net_gex!)
  if (!breakThroughFired && entryAbs > 0 && liveAbs / entryAbs < 0.2 && state === 'intact') {
    reasons.push(`Net GEX collapsed from ${fmtMillions(entry.net_gex!)} to ${fmtMillions(live.net_gex!)} — transition zone.`)
    state = 'drifting'
  }

  if (state === 'intact' && reasons.length === 0) {
    reasons.push('Entry-time positioning still holds. Wall, flip, and regime are all intact.')
  }

  return { state, reasons }
}

// Structured-thesis verdict (Phase 3a). Mirror of frontend
// computeStructuredVerdict; keep in lock-step.
function computeStructuredVerdict(
  entry: EntrySnapshot,
  live: LiveSnapshot,
  trade: TradeShape,
): Verdict {
  const reasons: string[] = []
  let state: VerdictState = 'intact'

  const targetStrike = Number(trade.target_strike)
  const targetKind = trade.target_thesis_kind!
  const liveSpot = Number(live.spot)
  const entrySpot = Number(entry.spot)

  // Regime-flip with deadband — see src/utils/thesisVerdict.js.
  if (Number.isFinite(entry.net_gex) && Number.isFinite(live.net_gex)) {
    const entryRegime = regimeFromNetGex(entry.net_gex!, entry.net_gex)
    const liveRegime = regimeFromNetGex(live.net_gex!, entry.net_gex)
    if (entryRegime !== liveRegime && entryRegime !== 'mixed' && liveRegime !== 'mixed') {
      reasons.push(`Regime flipped ${entryRegime} → ${liveRegime} since entry. Dealer hedging dynamics have inverted.`)
      state = 'invalidated'
      return { state, reasons }
    }
  }

  let breakThroughFired = false
  if (targetKind === 'break_through') {
    const PIERCE = 0.5
    // Audit #8: ambiguous direction → not_evaluable.
    if (Math.abs(entrySpot - targetStrike) < ENTRY_SPOT_AMBIGUOUS_TOLERANCE) {
      return {
        state: 'not_evaluable',
        reasons: [
          `Entry spot ${entrySpot.toFixed(2)} was at the target ${formatStrike(targetStrike)} — break-through direction is ambiguous. Re-log the signal with a clearer entry context.`,
        ],
      }
    }
    const wantsUp = entrySpot < targetStrike - ENTRY_SPOT_AMBIGUOUS_TOLERANCE
    const wantsDown = entrySpot > targetStrike + ENTRY_SPOT_AMBIGUOUS_TOLERANCE
    if (wantsUp && liveSpot >= targetStrike + PIERCE) {
      reasons.push(`Spot has broken through the target wall at ${formatStrike(targetStrike)} — structural target reached. Check the P&L card.`)
      breakThroughFired = true
    } else if (wantsDown && liveSpot <= targetStrike - PIERCE) {
      reasons.push(`Spot has broken through the target wall at ${formatStrike(targetStrike)} — structural target reached. Check the P&L card.`)
      breakThroughFired = true
    } else if (wantsUp && liveSpot < entrySpot - 1) {
      reasons.push(`Spot drifted from ${entrySpot.toFixed(2)} → ${liveSpot.toFixed(2)} — moving away from the target wall at ${formatStrike(targetStrike)}.`)
      state = 'drifting'
    } else if (wantsDown && liveSpot > entrySpot + 1) {
      reasons.push(`Spot drifted from ${entrySpot.toFixed(2)} → ${liveSpot.toFixed(2)} — moving away from the target wall at ${formatStrike(targetStrike)}.`)
      state = 'drifting'
    }
  } else if (targetKind === 'pin_to') {
    // Audit #7: pct-of-spot thresholds. Audit #12: also cap by
    // spread width × DTE multiplier (see src/utils/thesisVerdict.js
    // for the full rationale — these two files must agree).
    const distance = Math.abs(liveSpot - targetStrike)
    const width = Math.abs(Number(trade.short_strike) - Number(trade.long_strike))
    const dteVal = Number(trade.dte)
    const dteMult = Number.isFinite(dteVal) ? Math.min(1, Math.max(0.3, dteVal / 7)) : 1
    const widthCap = Number.isFinite(width) && width > 0 ? width * dteMult : Infinity
    const driftMin = Math.min(liveSpot * PIN_DRIFT_PCT, widthCap)
    const invalidateMin = Math.min(liveSpot * PIN_INVALIDATE_PCT, widthCap * 2)
    if (distance >= driftMin) {
      const direction = liveSpot > targetStrike ? 'above' : 'below'
      const pctMove = ((distance / liveSpot) * 100).toFixed(2)
      reasons.push(`Spot at ${liveSpot.toFixed(2)} is ${direction} the pin target ${formatStrike(targetStrike)} by ${distance.toFixed(2)} (${pctMove}%). Pin thesis weakening.`)
      state = distance > invalidateMin ? 'invalidated' : 'drifting'
    }
  } else if (targetKind === 'fade') {
    const entryDistance = Math.abs(entrySpot - targetStrike)
    const liveDistance = Math.abs(liveSpot - targetStrike)
    if (liveDistance < entryDistance * 0.3) {
      reasons.push(`Spot has reverted to ${liveSpot.toFixed(2)} — close to the fade target ${formatStrike(targetStrike)}. Thesis playing out.`)
    } else if (liveDistance > entryDistance * 1.5) {
      reasons.push(`Spot at ${liveSpot.toFixed(2)} has stretched further from the fade target ${formatStrike(targetStrike)} — thesis weakening.`)
      state = 'drifting'
    }
  }

  // Audit #10: live-wall migration with directional safe-harbor for
  // break_through. Threshold scales by spot (audit #7).
  if (live.largest_wall && !breakThroughFired && state === 'intact') {
    const liveWallStrike = Number(live.largest_wall.strike)
    const wallDistance = Math.abs(liveWallStrike - targetStrike)
    const wallDriftMin = liveSpot * 0.05
    if (Number.isFinite(liveWallStrike) && wallDistance >= wallDriftMin) {
      let favorable = false
      if (targetKind === 'break_through') {
        const wantsUp = entrySpot < targetStrike - ENTRY_SPOT_AMBIGUOUS_TOLERANCE
        const wantsDown = entrySpot > targetStrike + ENTRY_SPOT_AMBIGUOUS_TOLERANCE
        favorable =
          (wantsUp && liveWallStrike > targetStrike) ||
          (wantsDown && liveWallStrike < targetStrike)
      }
      if (favorable) {
        const direction = liveWallStrike > targetStrike ? 'above' : 'below'
        reasons.push(`Live dominant wall has run to ${formatStrike(liveWallStrike)} — past your ${formatStrike(targetStrike)} target ${direction} entry. Dealer book reconcentrated in your direction.`)
      } else {
        reasons.push(`Live dominant wall is at ${formatStrike(liveWallStrike)} — your target was ${formatStrike(targetStrike)}. Different cluster anchoring the regime now.`)
        state = 'drifting'
      }
    }
  }

  // Audit #12: P&L cross-check (see src/utils/thesisVerdict.js).
  const pnlPct = Number(trade.pnl_pct)
  if (!breakThroughFired && Number.isFinite(pnlPct)) {
    if (pnlPct <= -90 && state !== 'invalidated') {
      state = 'invalidated'
      reasons.push(`Position is at ${pnlPct.toFixed(0)}% — thesis cannot be salvaged regardless of structural read. Mark is ground truth.`)
    } else if (pnlPct <= -75 && state === 'intact') {
      state = 'drifting'
      reasons.push(`Structural thesis reads intact but the position is at ${pnlPct.toFixed(0)}%. The market disagrees with the structure — re-read the wall before holding.`)
    }
  }

  if (state === 'intact' && reasons.length === 0) {
    reasons.push('Entry-time thesis still holds. Wall, regime, and price action all consistent with the structural target.')
  }

  return { state, reasons }
}

// Regime classifier with deadband — see src/utils/thesisVerdict.js.
function regimeFromNetGex(
  netGex: number,
  referenceGex?: number | null,
): 'A' | 'B' | 'mixed' {
  if (!Number.isFinite(netGex)) return 'mixed'
  const ref =
    referenceGex != null && Number.isFinite(referenceGex)
      ? Math.abs(referenceGex)
      : 0
  const threshold = Math.max(ref * REGIME_DEADBAND_RATIO, REGIME_DEADBAND_FLOOR)
  if (Math.abs(netGex) < threshold) return 'mixed'
  if (netGex > 0) return 'A'
  if (netGex < 0) return 'B'
  return 'mixed'
}

function formatStrike(s: number): string {
  if (!Number.isFinite(s)) return '—'
  return s >= 1000 ? s.toFixed(0) : s.toFixed(1)
}

function fmtMillions(v: number): string {
  if (!Number.isFinite(v)) return '—'
  const sign = v >= 0 ? '+' : '−'
  return `${sign}$${(Math.abs(v) / 1e6).toFixed(1)}M`
}
