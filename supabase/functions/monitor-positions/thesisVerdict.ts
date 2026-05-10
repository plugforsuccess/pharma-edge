// Server-side thesis verdict logic.
//
// **Keep in sync with `src/utils/thesisVerdict.js`.** Same rules,
// same wording. Edge functions can't share modules with the Vite
// frontend (Deno vs Node + different bundle layout), so we duplicate
// the logic and pin them via comment + same test fixtures.
//
// See the frontend file for the full rationale + verdict ladder.

const STRIKE_DRIFT_THRESHOLD = 3

export interface EntrySnapshot {
  spot: number | null
  net_gex: number | null
  largest_wall: { strike: number; expiration: string; gex_net: number } | null
}

export interface LiveSnapshot {
  spot: number | null
  net_gex: number | null
  largest_wall: { strike: number; expiration: string; gex_net: number } | null
}

export interface TradeShape {
  long_strike: number
  short_strike: number
  strategy_type: string
  expiration?: string | null
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
  if (!entry || !Number.isFinite(entry.spot) || !Number.isFinite(entry.net_gex)) {
    return { state: 'not_evaluable', reasons: ['No entry snapshot — signal logged before dynamic-thesis tracking landed.'] }
  }
  if (!live || !Number.isFinite(live.spot) || !Number.isFinite(live.net_gex)) {
    return { state: 'not_evaluable', reasons: ['No live GEX data right now.'] }
  }

  const reasons: string[] = []
  let state: VerdictState = 'intact'

  const entryRegime = regimeFromNetGex(entry.net_gex!)
  const liveRegime = regimeFromNetGex(live.net_gex!)
  if (entryRegime !== liveRegime && entryRegime !== 'mixed' && liveRegime !== 'mixed') {
    reasons.push(`Regime flipped ${entryRegime} → ${liveRegime} since entry. Dealer hedging dynamics have inverted.`)
    state = 'invalidated'
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
  const entryWallStrike = entry.largest_wall?.strike
  if (Number.isFinite(entryWallStrike) && entryWallStrike != null && wallType) {
    const crossedUp = entry.spot! < entryWallStrike && live.spot! >= entryWallStrike + PIERCE
    const crossedDown = entry.spot! > entryWallStrike && live.spot! <= entryWallStrike - PIERCE
    if (wallType === 'call' && crossedUp) {
      if (isBullish) {
        reasons.push(`Spot broke through the entry call wall at ${formatStrike(entryWallStrike)} — resistance failed, structural target zone. Check the P&L card.`)
      } else if (isBearish) {
        reasons.push(`Spot pierced the entry call wall at ${formatStrike(entryWallStrike)}. Bullish breakout — bearish thesis broken.`)
        state = 'invalidated'
      }
    }
    if (wallType === 'put' && crossedDown) {
      if (isBearish) {
        reasons.push(`Spot broke through the entry put wall at ${formatStrike(entryWallStrike)} — support failed, structural target zone. Check the P&L card.`)
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
  if (entry.largest_wall && live.largest_wall) {
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

    if (Number.isFinite(entryStrike) && Number.isFinite(liveStrike)) {
      const strikeDrift = Math.abs(liveStrike - entryStrike)
      if (strikeDrift >= STRIKE_DRIFT_THRESHOLD) {
        if (liveAtTradeTarget && liveExpAtTradeExp) {
          reasons.push(`Dominant wall has migrated to ${formatStrike(liveStrike)} @ ${live.largest_wall.expiration} — your structural target zone. Thesis playing out.`)
        } else if (liveAtTradeTarget) {
          reasons.push(`Dominant wall now at ${formatStrike(liveStrike)} — your trade's short strike. Strike target reached.`)
        } else {
          reasons.push(`Dominant wall shifted from ${formatStrike(entryStrike)} → ${formatStrike(liveStrike)}. Thesis anchor moved.`)
          state = 'drifting'
        }
      }
    }
    if (
      entry.largest_wall.expiration !== live.largest_wall.expiration &&
      !(liveAtTradeTarget && liveExpAtTradeExp)
    ) {
      reasons.push(`Dominant wall expiration moved from ${entry.largest_wall.expiration} → ${live.largest_wall.expiration}. Different cluster anchoring the regime now.`)
      state = 'drifting'
    }
  }

  const entryAbs = Math.abs(entry.net_gex!)
  const liveAbs = Math.abs(live.net_gex!)
  if (entryAbs > 0 && liveAbs / entryAbs < 0.2 && state === 'intact') {
    reasons.push(`Net GEX collapsed from ${fmtMillions(entry.net_gex!)} to ${fmtMillions(live.net_gex!)} — transition zone.`)
    state = 'drifting'
  }

  if (state === 'intact' && reasons.length === 0) {
    reasons.push('Entry-time positioning still holds. Wall, flip, and regime are all intact.')
  }

  return { state, reasons }
}

function regimeFromNetGex(netGex: number): 'A' | 'B' | 'mixed' {
  if (!Number.isFinite(netGex)) return 'mixed'
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
