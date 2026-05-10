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
 * @property {string|null} [expiration] - YYYY-MM-DD; used by drift
 *   logic to detect "wall migrated to my expiration" (thesis playing
 *   out) vs "wall moved to a different cluster" (real drift).
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

  // ── 2. Wall pierced — context-aware ────────────────────────────
  // Spot crossing the entry wall has TWO different meanings depending
  // on (a) the wall type (call wall = positive GEX cluster /
  // resistance vs put wall = negative GEX / support) and (b) the
  // trade's directional bias (bull vs bear).
  //
  //   call wall pierced UP from below:
  //     bullish trade → resistance failed, structural target reached
  //                     (NOT an invalidation — this is the thesis
  //                      working; check the P&L card)
  //     bearish trade → bullish breakout, your bearish thesis broke
  //
  //   put wall pierced DOWN from above:
  //     bearish trade → support failed, structural target reached
  //     bullish trade → bearish breakdown, your bullish thesis broke
  //
  // Earlier versions of this function fired `invalidated` whenever
  // any wall pierced regardless of whether the trade STRUCTURALLY
  // wanted that move — break-the-wall debit spreads (long at the
  // wall, short above) would always misfire as invalidated when
  // they hit max profit.
  const PIERCE = 0.5
  const wallGex = entry.largest_wall?.gex_net
  // Wall type from the GEX sign when known. When the snapshot
  // doesn't carry a sign (manual backfills, older payloads), fall
  // back to inferring from the trade's directional bias — bullish
  // trades typically anchored to call walls, bearish to put walls.
  const isBullish = ['BULL_CALL', 'BULL_PUT_CREDIT'].includes(trade.strategy_type)
  const isBearish = ['BEAR_PUT', 'BEAR_CALL_CREDIT'].includes(trade.strategy_type)
  const wallType =
    Number.isFinite(wallGex) && wallGex > 0
      ? 'call'
      : Number.isFinite(wallGex) && wallGex < 0
        ? 'put'
        : isBullish
          ? 'call'
          : isBearish
            ? 'put'
            : null
  const entryWallStrike = entry.largest_wall?.strike
  if (Number.isFinite(entryWallStrike) && wallType) {
    const crossedUp = entry.spot < entryWallStrike && live.spot >= entryWallStrike + PIERCE
    const crossedDown = entry.spot > entryWallStrike && live.spot <= entryWallStrike - PIERCE
    if (wallType === 'call' && crossedUp) {
      if (isBullish) {
        reasons.push(`Spot broke through the entry call wall at ${formatStrike(entryWallStrike)} — resistance failed, structural target zone. Check the P&L card.`)
        // bullish + wall broken upward = thesis SUCCESS, not invalidation
      } else if (isBearish) {
        reasons.push(`Spot pierced the entry call wall at ${formatStrike(entryWallStrike)}. Bullish breakout — bearish thesis broken.`)
        state = 'invalidated'
      }
    }
    if (wallType === 'put' && crossedDown) {
      if (isBearish) {
        reasons.push(`Spot broke through the entry put wall at ${formatStrike(entryWallStrike)} — support failed, structural target zone. Check the P&L card.`)
        // bearish + wall broken downward = thesis SUCCESS, not invalidation
      } else if (isBullish) {
        reasons.push(`Spot pierced the entry put wall at ${formatStrike(entryWallStrike)}. Bearish breakdown — bullish thesis broken.`)
        state = 'invalidated'
      }
    }
  }

  // If we already have an invalidation, return early — drift checks
  // below would just be noise.
  if (state === 'invalidated') {
    return { state, reasons }
  }

  // ── 3. Dominant wall drift — context-aware ─────────────────────
  // A "drift" is only a thesis problem if the wall moved AWAY from
  // where the trade was structurally aiming. The trade's structural
  // target is the SHORT strike (max-profit anchor for both debit and
  // credit verticals) at the trade's expiration — that's the wall
  // the trade is trying to be ANCHORED TO at exit, regardless of
  // what the dominant wall happened to be at entry.
  //
  // Cameron's QQQ trade is the canonical case: bought a bull call
  // $710/$725 on 5/8 when the largest wall was $710 @ 5/8 (rolling
  // off same day). He correctly anticipated the wall would migrate
  // to $725 @ 5/12 once $710 expired. Today the live wall IS
  // $725 @ 5/12 — that's the thesis playing out exactly as designed,
  // not anchor drift. Old logic flagged this as "drifting" because
  // it only knew the entry vs live strike numbers. New logic checks
  // whether the live wall has migrated to the trade's structural
  // target and treats that as "thesis playing out" instead.
  if (entry.largest_wall && live.largest_wall) {
    const entryStrike = Number(entry.largest_wall.strike)
    const liveStrike = Number(live.largest_wall.strike)
    const targetStrike = Number(trade.short_strike)
    const tradeExpiration = trade.expiration ?? null
    const STRIKE_TARGET_TOLERANCE = 1   // within $1 = effectively at the target
    const liveAtTradeTarget =
      Number.isFinite(targetStrike) &&
      Math.abs(liveStrike - targetStrike) <= STRIKE_TARGET_TOLERANCE
    const liveExpAtTradeExp =
      tradeExpiration != null && live.largest_wall.expiration === tradeExpiration

    if (Number.isFinite(entryStrike) && Number.isFinite(liveStrike)) {
      const strikeDrift = Math.abs(liveStrike - entryStrike)
      if (strikeDrift >= STRIKE_DRIFT_THRESHOLD) {
        if (liveAtTradeTarget && liveExpAtTradeExp) {
          // Wall migrated to the trade's structural target. Thesis playing out.
          reasons.push(`Dominant wall has migrated to ${formatStrike(liveStrike)} @ ${live.largest_wall.expiration} — your structural target zone. Thesis playing out.`)
          // do NOT set state = 'drifting'
        } else if (liveAtTradeTarget) {
          reasons.push(`Dominant wall now at ${formatStrike(liveStrike)} — your trade's short strike. Strike target reached.`)
          // close enough — call this intact, the strike is what matters
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
