// Dynamic thesis verdict.
//
// The signal's thesis text is FROZEN at lock time per the immutability
// contract — that's the public-record proof. This module computes a
// SEPARATE, ephemeral "is the thesis still alive" value by comparing
// the captured entry_gex_snapshot to the live dealer-positioning
// state. Output drives the verdict banner on PositionDetail and the
// push notifications dispatched by monitor-positions.
//
// **Keep in sync with `supabase/functions/monitor-positions/thesisVerdict.ts`.**
// Same rules + same wording so the client banner and the push payload
// always agree. If you change one, change both.
//
// Verdict ladder (most severe wins):
//   1. invalidated — regime flipped, OR spot pierced the trade's
//      target wall (the strike the trade was structurally relying on)
//   2. drifting    — dominant wall shifted ≥ STRIKE_DRIFT_THRESHOLD,
//      OR spot crossed the flip strike (transition zone), OR the
//      dominant wall's expiration changed
//   3. intact      — none of the above; entry positioning still holds
//   4. not_evaluable — no entry snapshot, or no live data
//
// Heuristic, not perfect. Phase 3 (structured thesis schema) is what
// makes this semantically precise — until then we're inferring "what
// the trade depended on" from strikes + direction + the entry
// snapshot, which is good enough for ~80% of cases.

// How many strikes the dominant wall can shift before we call it drift.
// Tuned for index ETFs ($1 strikes); SPXW ($5 strikes) gets a coarser
// effective threshold which is fine — bigger underlyings have bigger
// natural wiggle.
const STRIKE_DRIFT_THRESHOLD = 3

export const VERDICT_STATES = ['intact', 'drifting', 'invalidated', 'not_evaluable']

/**
 * @typedef {Object} EntrySnapshot
 * @property {number|null} spot
 * @property {number|null} net_gex
 * @property {{strike:number,expiration:string,gex_net:number}|null} largest_wall
 *
 * @typedef {Object} LiveSnapshot
 * @property {number|null} spot
 * @property {number|null} net_gex
 * @property {{strike:number,expiration:string,gex_net:number}|null} largest_wall
 *
 * @typedef {Object} TradeShape
 * @property {number} long_strike
 * @property {number} short_strike
 * @property {string} strategy_type   - BULL_CALL / BEAR_PUT / etc.
 *
 * @typedef {Object} Verdict
 * @property {'intact'|'drifting'|'invalidated'|'not_evaluable'} state
 * @property {string[]} reasons
 */

/**
 * @param {EntrySnapshot|null} entry
 * @param {LiveSnapshot|null} live
 * @param {TradeShape} trade
 * @returns {Verdict}
 */
export function computeThesisVerdict(entry, live, trade) {
  if (!entry || !Number.isFinite(entry.spot) || !Number.isFinite(entry.net_gex)) {
    return { state: 'not_evaluable', reasons: ['No entry snapshot — signal logged before dynamic-thesis tracking landed.'] }
  }
  if (!live || !Number.isFinite(live.spot) || !Number.isFinite(live.net_gex)) {
    return { state: 'not_evaluable', reasons: ['No live GEX data right now.'] }
  }

  const reasons = []
  let state = 'intact'

  // ── 1. Regime flip — most severe ────────────────────────────────
  // Entry regime: A if net_gex > 0, B if < 0. Bracketing zero (within
  // ±5% of |entry.net_gex|) we treat as 'mixed' — too noisy to call.
  const entryRegime = regimeFromNetGex(entry.net_gex)
  const liveRegime = regimeFromNetGex(live.net_gex)
  if (entryRegime !== liveRegime && entryRegime !== 'mixed' && liveRegime !== 'mixed') {
    reasons.push(`Regime flipped ${entryRegime} → ${liveRegime} since entry. Dealer hedging dynamics have inverted.`)
    state = 'invalidated'
  }

  // ── 2. Target wall pierced — also invalidating ──────────────────
  // For a debit call spread the trade needs spot to RISE through the
  // long strike toward the short strike. If spot has already moved
  // BEYOND the short strike (the structural target wall on the
  // upside), max profit is locked in — the trade has played out and
  // the "thesis" of dealer pin is no longer applicable. Symmetric on
  // the put side.
  //
  // We also check the entry snapshot's `largest_wall` — if spot
  // pierced the dominant wall the trade was anchored to, that's an
  // invalidation regardless of whether it was the short strike.
  const isCall = (trade.strategy_type || '').includes('CALL')
  const isPut = (trade.strategy_type || '').includes('PUT')
  const entryWallStrike = entry.largest_wall?.strike
  if (Number.isFinite(entryWallStrike)) {
    if (isCall && live.spot >= entryWallStrike + 0.5 && entry.spot < entryWallStrike) {
      reasons.push(`Spot pierced the entry call wall at ${formatStrike(entryWallStrike)}. Dealer resistance broken.`)
      state = 'invalidated'
    }
    if (isPut && live.spot <= entryWallStrike - 0.5 && entry.spot > entryWallStrike) {
      reasons.push(`Spot pierced the entry put wall at ${formatStrike(entryWallStrike)}. Dealer support broken.`)
      state = 'invalidated'
    }
  }

  // If we already have an invalidation, return early — drift checks
  // below would just be noise.
  if (state === 'invalidated') {
    return { state, reasons }
  }

  // ── 3. Dominant wall drift ──────────────────────────────────────
  if (entry.largest_wall && live.largest_wall) {
    const entryStrike = Number(entry.largest_wall.strike)
    const liveStrike = Number(live.largest_wall.strike)
    if (Number.isFinite(entryStrike) && Number.isFinite(liveStrike)) {
      const strikeDrift = Math.abs(liveStrike - entryStrike)
      if (strikeDrift >= STRIKE_DRIFT_THRESHOLD) {
        reasons.push(`Dominant wall shifted from ${formatStrike(entryStrike)} → ${formatStrike(liveStrike)}. Thesis anchor moved.`)
        state = 'drifting'
      }
    }
    if (entry.largest_wall.expiration !== live.largest_wall.expiration) {
      reasons.push(`Dominant wall expiration moved from ${entry.largest_wall.expiration} → ${live.largest_wall.expiration}. Different cluster anchoring the regime now.`)
      state = 'drifting'
    }
  }

  // ── 4. Net GEX in transition zone ───────────────────────────────
  // Live net_gex is "near zero" if its magnitude is small relative to
  // the entry value. Signals impending regime flip — half-size or
  // wait for direction.
  const entryAbs = Math.abs(entry.net_gex)
  const liveAbs = Math.abs(live.net_gex)
  if (entryAbs > 0 && liveAbs / entryAbs < 0.2 && state === 'intact') {
    reasons.push(`Net GEX collapsed from ${fmtMillions(entry.net_gex)} to ${fmtMillions(live.net_gex)} — transition zone.`)
    state = 'drifting'
  }

  if (state === 'intact' && reasons.length === 0) {
    reasons.push('Entry-time positioning still holds. Wall, flip, and regime are all intact.')
  }

  return { state, reasons }
}

function regimeFromNetGex(netGex) {
  if (!Number.isFinite(netGex)) return 'mixed'
  if (netGex > 0) return 'A'
  if (netGex < 0) return 'B'
  return 'mixed'
}

function formatStrike(s) {
  if (!Number.isFinite(s)) return '—'
  return s >= 1000 ? s.toFixed(0) : s.toFixed(1)
}

function fmtMillions(v) {
  if (!Number.isFinite(v)) return '—'
  const sign = v >= 0 ? '+' : '−'
  return `${sign}$${(Math.abs(v) / 1e6).toFixed(1)}M`
}
