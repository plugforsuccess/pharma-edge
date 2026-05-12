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
//   2. drifting    — dominant wall shifted ≥ STRIKE_DRIFT_THRESHOLD
//      AWAY from the target, OR spot crossed the flip strike
//      (transition zone), OR the dominant wall's expiration changed
//      AWAY from the trade expiration, OR the wall AT the trade's
//      short strike melted to <50% of entry / flipped sign, OR net
//      DEX flipped against the trade's directional bias
//   3. intact      — none of the above; entry positioning still holds.
//      Sub-reasons surface POSITIVE signals (wall reinforcing,
//      structural target reached, DEX tailwind) without changing state.
//   4. not_evaluable — no entry snapshot, or no live data
//
// Heuristic, not perfect. Phase 3 (structured thesis schema) is what
// makes this semantically precise — until then we're inferring "what
// the trade depended on" from strikes + direction + the entry
// snapshot, which is good enough for ~80% of cases.
//
// The wall-pierced branch (section 2) sets a `breakThroughFired`
// flag when the trade's directional wall breaks IN THE TRADE'S FAVOR;
// the post-pierce drift checks (section 3+) skip when that flag is
// set, because any further wall migration is informational once the
// structural target has been hit (otherwise winning trades misfire as
// "drifting" — exactly the 93% gain that motivated this refactor).

// How many strikes the dominant wall can shift before we call it drift.
// Tuned for index ETFs ($1 strikes); SPXW ($5 strikes) gets a coarser
// effective threshold which is fine — bigger underlyings have bigger
// natural wiggle.
const STRIKE_DRIFT_THRESHOLD = 3

// Wall-at-your-strike thresholds. The dominant wall in the matrix may
// drift, but the question that matters for a debit/credit spread is
// "is the wall AT MY STRIKE still there?" Reinforcement (>1.3× entry)
// surfaces as a positive intact-state reason; melt (<0.5× entry) or
// sign flip surfaces as drift.
const STRIKE_GEX_REINFORCE_RATIO = 1.3
const STRIKE_GEX_MELT_RATIO = 0.5

// Net DEX is an independent axis from GEX. A sign flip with meaningful
// magnitude (>10% of entry |DEX|) tells us dealer hedging behavior has
// inverted — buy-the-dip regime → sell-the-rip, or vice versa. Tiny
// flips around zero are noise (DEX hovers near zero at flip-strike
// crossings) so we gate on the magnitude threshold.
const DEX_FLIP_MAGNITUDE_RATIO = 0.1

// Regime-flip deadband (audit #3 + #4). Net GEX flips around zero are
// noise — a position entered at +$1M and now sitting at -$1M shouldn't
// auto-close. We treat anything within ±10% of the entry magnitude OR
// below an absolute floor ($20M) as 'mixed' regardless of sign.
//
// The same classifier runs on both sides (audit #4): both `entry` and
// `live` go through regimeFromNetGex with the same reference, so we
// can't have one side classified with one classifier and the other
// with a different one. The persisted `trade.regime_at_entry`
// (originally produced by deriveRegime in monitor-positions, which
// uses flip + sign) is therefore IGNORED for the comparison — we
// always recompute both sides here so the contract is "same function,
// same reference → comparable output."
const REGIME_DEADBAND_RATIO = 0.10
const REGIME_DEADBAND_FLOOR = 20_000_000

// Pin-thesis thresholds (audit #7 / #10). Previously absolute dollar
// amounts (≥5 → drifting, >8 → invalidated). Those work for $100 ETFs
// and break everywhere else — SPX at 5000 never crosses an absolute-5
// threshold; a $30 stock at 38 always does. Scaled by spot instead:
//
//   |live - target| / spot < 5%             → no signal
//   |live - target| / spot ≥ 5% AND ≤ 8%    → drifting
//   |live - target| / spot > 8%             → invalidated
//
// Calibration: at $100 spot the percentages collapse to the original
// $5 / $8 absolute thresholds, so existing $100-ish ETF behavior is
// preserved exactly. At $5000 SPX they become $250 / $400 — first
// real "pin thesis weakening" reads at a 5% index move. At $30 they
// become $1.50 / $2.40 — proportional and meaningful.
const PIN_DRIFT_PCT = 0.05
const PIN_INVALIDATE_PCT = 0.08

// Entry-spot-equals-target tolerance (audit #8). When entrySpot is
// within ±$0.25 of targetStrike, the break_through direction is
// ambiguous (we can't tell from one observation whether the trade
// wants spot to rise or fall) — fall through to a not_evaluable
// reason instead of silently treating it as intact.
const ENTRY_SPOT_AMBIGUOUS_TOLERANCE = 0.25

export const VERDICT_STATES = ['intact', 'drifting', 'invalidated', 'not_evaluable']

/**
 * @typedef {Object} EntrySnapshot
 * @property {number|null} spot
 * @property {number|null} net_gex
 * @property {number|null} [net_dex]  - signed dealer-book net delta exposure.
 *   Calls contribute positively, puts negatively; same convention as
 *   compute-gex's MatrixOutput. Optional for legacy snapshots that
 *   pre-date the field.
 * @property {number|null} [wall_gex_at_short_strike] - signed GEX at the
 *   trade's short strike, summed across the matrix's expirations.
 *   This is the trade-specific anchor health metric (vs `largest_wall`
 *   which tracks the marketwide dominant wall). Optional for legacy
 *   snapshots.
 * @property {{strike:number,expiration:string,gex_net:number}|null} largest_wall
 *
 * @typedef {Object} LiveSnapshot
 * @property {number|null} spot
 * @property {number|null} net_gex
 * @property {number|null} [net_dex]
 * @property {number|null} [wall_gex_at_short_strike]
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
  // Hard gates — only spot is required on both sides. net_gex is
  // OPTIONAL because compute-gex's Yahoo fallback path doesn't always
  // populate it (the cached snapshot can store spot alone). When
  // net_gex is missing on the live side, the structured verdict
  // still runs — only the regime-flip check skips. Better than
  // pinning every position at "not_evaluable" whenever the worker is
  // offline + Yahoo's response is thin.
  if (!entry || !Number.isFinite(entry.spot)) {
    return { state: 'not_evaluable', reasons: ['No entry snapshot — signal logged before dynamic-thesis tracking landed.'] }
  }
  if (!live || !Number.isFinite(live.spot)) {
    return { state: 'not_evaluable', reasons: ['No live spot price right now — try refreshing in a moment.'] }
  }

  const reasons = []
  let state = 'intact'

  // ── Phase 3a: structured thesis fast-path ──────────────────────
  if (trade.target_thesis_kind && Number.isFinite(Number(trade.target_strike))) {
    return computeStructuredVerdict(entry, live, trade)
  }

  // ── Heuristic path (legacy v1/v2 signals) ──────────────────────
  // The heuristic path needs net_gex on both sides for the regime
  // check. When missing we treat regime as "unknown" and skip the
  // flip detection — better to under-fire than crash the verdict.
  const haveNetGex = Number.isFinite(entry.net_gex) && Number.isFinite(live.net_gex)
  // Same logic that's been on main since PR #112/#113. Used for
  // signals locked before Phase 3a landed (no target_thesis_kind on
  // the row) so historical verdicts stay stable.

  // ── 1. Regime flip — most severe ────────────────────────────────
  // Entry regime: A if net_gex > 0, B if < 0. Bracketing zero (within
  // ±5% of |entry.net_gex|) we treat as 'mixed' — too noisy to call.
  // Skipped when haveNetGex is false (Yahoo fallback case).
  if (haveNetGex) {
    // Both sides classified by the same function with entry's magnitude
    // as the deadband reference. trade.regime_at_entry is intentionally
    // ignored — see REGIME_DEADBAND_RATIO comment near the top.
    const entryRegime = regimeFromNetGex(entry.net_gex, entry.net_gex)
    const liveRegime = regimeFromNetGex(live.net_gex, entry.net_gex)
    if (entryRegime !== liveRegime && entryRegime !== 'mixed' && liveRegime !== 'mixed') {
      reasons.push(`Regime flipped ${entryRegime} → ${liveRegime} since entry. Dealer hedging dynamics have inverted.`)
      state = 'invalidated'
    }
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
  // Tracks whether spot pierced the trade's directional wall IN THE
  // TRADE'S FAVOR. When true, the post-pierce drift checks (sections
  // 3+) are suppressed: any wall migration after the structural target
  // has been hit is informational, not a drift event. Mirrors the
  // structured-path's `breakThroughFired` gating.
  let breakThroughFired = false
  const entryWallStrike = entry.largest_wall?.strike
  if (Number.isFinite(entryWallStrike) && wallType) {
    const crossedUp = entry.spot < entryWallStrike && live.spot >= entryWallStrike + PIERCE
    const crossedDown = entry.spot > entryWallStrike && live.spot <= entryWallStrike - PIERCE
    if (wallType === 'call' && crossedUp) {
      if (isBullish) {
        reasons.push(`Spot broke through the entry call wall at ${formatStrike(entryWallStrike)} — resistance failed, structural target zone. Check the P&L card.`)
        // bullish + wall broken upward = thesis SUCCESS, not invalidation
        breakThroughFired = true
      } else if (isBearish) {
        reasons.push(`Spot pierced the entry call wall at ${formatStrike(entryWallStrike)}. Bullish breakout — bearish thesis broken.`)
        state = 'invalidated'
      }
    }
    if (wallType === 'put' && crossedDown) {
      if (isBearish) {
        reasons.push(`Spot broke through the entry put wall at ${formatStrike(entryWallStrike)} — support failed, structural target zone. Check the P&L card.`)
        // bearish + wall broken downward = thesis SUCCESS, not invalidation
        breakThroughFired = true
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
  if (entry.largest_wall && live.largest_wall && !breakThroughFired) {
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

    // Audit #10 / #167 follow-on: wall has RUN PAST the trade's
    // target in the trade's direction. Same suppression semantics
    // as breakThroughFired — once the structural backdrop has
    // reconcentrated past your target, that's the thesis playing
    // out, not anchor drift.
    const liveWallPastTargetInFavor =
      Number.isFinite(targetStrike) &&
      ((isBullish && liveStrike > targetStrike + STRIKE_TARGET_TOLERANCE) ||
        (isBearish && liveStrike < targetStrike - STRIKE_TARGET_TOLERANCE))

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
        } else if (liveWallPastTargetInFavor) {
          // Wall ran past target in trade direction. Informational
          // positive reason, state unchanged.
          const direction = isBullish ? 'above' : 'below'
          reasons.push(`Dominant wall has run to ${formatStrike(liveStrike)} — past your ${formatStrike(targetStrike)} target ${direction} entry's level. Dealer book reconcentrated in your direction.`)
          // do NOT set state = 'drifting'
        } else {
          reasons.push(`Dominant wall shifted from ${formatStrike(entryStrike)} → ${formatStrike(liveStrike)}. Thesis anchor moved.`)
          state = 'drifting'
        }
      }
    }
    // Expiration safe-harbor was previously `(liveAtTradeTarget &&
    // liveExpAtTradeExp)`, which only suppressed the alert when BOTH
    // strike and expiration matched. The strike check is already
    // handled above (and is direction-aware via the migrated-to-target
    // branch); the expiration-changed signal needs its own safe-harbor:
    // if the live dominant wall now sits at the trade's expiration,
    // that's the cluster migrating TOWARD the trade, not away — keep
    // the verdict intact regardless of strike.
    if (
      entry.largest_wall.expiration !== live.largest_wall.expiration &&
      !liveExpAtTradeExp
    ) {
      reasons.push(`Dominant wall expiration moved from ${entry.largest_wall.expiration} → ${live.largest_wall.expiration}. Different cluster anchoring the regime now.`)
      state = 'drifting'
    }
  }

  // ── 3b. Wall at YOUR strike (anchor health) ─────────────────────
  // The dominant wall in section 3 tracks the marketwide structure;
  // section 3b tracks the trade-specific anchor. A spread cares about
  // the wall AT its short strike — when that strike's GEX is melting
  // or has flipped sign, the trade's structural premise is eroding
  // regardless of where THE dominant wall ended up.
  //
  // Direction-symmetric: works for both bullish trades anchored to
  // call walls (positive GEX) and bearish trades anchored to put
  // walls (negative GEX) because we compare absolute magnitudes plus
  // an explicit sign-flip check.
  //
  // Suppressed when breakThroughFired — once the structural target's
  // been hit, the anchor-health metric is moot.
  if (
    !breakThroughFired &&
    Number.isFinite(entry.wall_gex_at_short_strike) &&
    Number.isFinite(live.wall_gex_at_short_strike) &&
    Math.abs(entry.wall_gex_at_short_strike) > 0
  ) {
    const entryGAtK = entry.wall_gex_at_short_strike
    const liveGAtK = live.wall_gex_at_short_strike
    const signFlipped =
      Math.sign(entryGAtK) !== 0 &&
      Math.sign(liveGAtK) !== 0 &&
      Math.sign(entryGAtK) !== Math.sign(liveGAtK)
    const magnitudeRatio = Math.abs(liveGAtK) / Math.abs(entryGAtK)
    if (signFlipped) {
      reasons.push(`Wall at your ${formatStrike(trade.short_strike)} strike flipped sign (${fmtMillions(entryGAtK)} → ${fmtMillions(liveGAtK)}). Structure inverted since entry.`)
      state = 'drifting'
    } else if (magnitudeRatio < STRIKE_GEX_MELT_RATIO) {
      reasons.push(`Wall at your ${formatStrike(trade.short_strike)} strike melted to ${Math.round(magnitudeRatio * 100)}% of entry. Anchor eroding.`)
      state = 'drifting'
    } else if (magnitudeRatio > STRIKE_GEX_REINFORCE_RATIO) {
      // Positive signal — surfaces as an intact-state reason. Does NOT
      // change state. Helps the UI banner explain WHY the verdict's
      // intact when other signals were marginal.
      reasons.push(`Wall at your ${formatStrike(trade.short_strike)} strike reinforcing (+${Math.round((magnitudeRatio - 1) * 100)}% since entry).`)
    }
  }

  // ── 3c. Net DEX flip (dealer hedging regime) ────────────────────
  // Net DEX is an independent axis from GEX. Sign + magnitude tells us
  // how dealers hedge underlying moves:
  //   net_dex > 0 → option book long-call-delta heavy → dealers short
  //     delta → BUY on rallies (trend-supportive, tailwind for trends)
  //   net_dex < 0 → put-delta heavy → dealers long delta → SELL on
  //     rallies (pin-supportive, headwind for trends)
  // For a bullish trade we want net_dex > 0; bearish wants < 0. A
  // flip against the trade's direction with meaningful magnitude is
  // real drift even when GEX walls look intact.
  //
  // Suppressed when breakThroughFired — same reasoning as 3b.
  if (
    !breakThroughFired &&
    Number.isFinite(entry.net_dex) &&
    Number.isFinite(live.net_dex) &&
    Math.abs(entry.net_dex) > 0
  ) {
    const entryDex = entry.net_dex
    const liveDex = live.net_dex
    const dexSignFlipped =
      Math.sign(entryDex) !== 0 &&
      Math.sign(liveDex) !== 0 &&
      Math.sign(entryDex) !== Math.sign(liveDex)
    const liveDexMeaningful =
      Math.abs(liveDex) > DEX_FLIP_MAGNITUDE_RATIO * Math.abs(entryDex)
    if (dexSignFlipped && liveDexMeaningful) {
      const dealerBehavior = liveDex > 0 ? 'now buy rallies' : 'now sell rallies'
      const againstTrade =
        (isBullish && liveDex < 0) || (isBearish && liveDex > 0)
      if (againstTrade) {
        reasons.push(`Net DEX flipped ${fmtMillions(entryDex)} → ${fmtMillions(liveDex)}. Dealers ${dealerBehavior} — headwind for your direction.`)
        state = 'drifting'
      } else if (isBullish || isBearish) {
        // Flip in the trade's favor — informational, state unchanged.
        reasons.push(`Net DEX flipped ${fmtMillions(entryDex)} → ${fmtMillions(liveDex)}. Dealers ${dealerBehavior} — tailwind for your direction.`)
      }
    }
  }

  // ── 4. Net GEX in transition zone ───────────────────────────────
  // Live net_gex is "near zero" if its magnitude is small relative to
  // the entry value. Signals impending regime flip — half-size or
  // wait for direction. Suppressed when breakThroughFired (sub-20%
  // net GEX is expected when spot has rocketed past the call wall —
  // the marketwide gamma profile reshuffled, but the trade already won).
  const entryAbs = Math.abs(entry.net_gex)
  const liveAbs = Math.abs(live.net_gex)
  if (!breakThroughFired && entryAbs > 0 && liveAbs / entryAbs < 0.2 && state === 'intact') {
    reasons.push(`Net GEX collapsed from ${fmtMillions(entry.net_gex)} to ${fmtMillions(live.net_gex)} — transition zone.`)
    state = 'drifting'
  }

  if (state === 'intact' && reasons.length === 0) {
    reasons.push('Entry-time positioning still holds. Wall, flip, and regime are all intact.')
  }

  return { state, reasons }
}

// Structured-thesis verdict (Phase 3a). Reads trade.target_thesis_kind,
// target_strike, target_expiration directly to decide "is this trade
// thesis playing out, drifting, or broken" — no inference from
// strategy_type required.
//
// trade.target_thesis_kind values:
//   'pin_to'        wall holds, spot stays at/near target_strike (Iron
//                   Condor, credit spreads at the wall)
//   'break_through' wall fails, spot crosses target_strike in trade's
//                   intended direction (debit spreads pushing through)
//   'fade'          spot returns from extreme back to target_strike
//                   (mean-reversion plays away from a stretched move)
function computeStructuredVerdict(entry, live, trade) {
  const reasons = []
  let state = 'intact'

  const targetStrike = Number(trade.target_strike)
  const targetKind = trade.target_thesis_kind
  const liveSpot = Number(live.spot)
  const entrySpot = Number(entry.spot)

  // Regime flip — same deadband-aware classifier as the heuristic
  // path. trade.regime_at_entry intentionally ignored; see comment
  // near REGIME_DEADBAND_RATIO at the top.
  if (Number.isFinite(entry.net_gex) && Number.isFinite(live.net_gex)) {
    const entryRegime = regimeFromNetGex(entry.net_gex, entry.net_gex)
    const liveRegime = regimeFromNetGex(live.net_gex, entry.net_gex)
    if (entryRegime !== liveRegime && entryRegime !== 'mixed' && liveRegime !== 'mixed') {
      reasons.push(`Regime flipped ${entryRegime} → ${liveRegime} since entry. Dealer hedging dynamics have inverted.`)
      state = 'invalidated'
      return { state, reasons }
    }
  }

  // Per-thesis-kind logic
  let breakThroughFired = false
  if (targetKind === 'break_through') {
    // Trade wins when spot pierces target_strike in the intended
    // direction. Direction inferred from where entry spot sat
    // relative to target — entry below = needs to rise; entry above
    // = needs to fall.
    //
    // Audit #8: when entrySpot is essentially at the target (within
    // ENTRY_SPOT_AMBIGUOUS_TOLERANCE), direction is undefined — bail
    // out as not_evaluable instead of silently falling through to
    // intact forever.
    const PIERCE = 0.5
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
      // thesis playing out — state stays intact
    } else if (wantsDown && liveSpot <= targetStrike - PIERCE) {
      reasons.push(`Spot has broken through the target wall at ${formatStrike(targetStrike)} — structural target reached. Check the P&L card.`)
      breakThroughFired = true
    } else if (wantsUp && liveSpot < entrySpot - 1) {
      // Spot moved AWAY from the target — thesis weakening
      reasons.push(`Spot drifted from ${entrySpot.toFixed(2)} → ${liveSpot.toFixed(2)} — moving away from the target wall at ${formatStrike(targetStrike)}.`)
      state = 'drifting'
    } else if (wantsDown && liveSpot > entrySpot + 1) {
      reasons.push(`Spot drifted from ${entrySpot.toFixed(2)} → ${liveSpot.toFixed(2)} — moving away from the target wall at ${formatStrike(targetStrike)}.`)
      state = 'drifting'
    }
    // else: spot still between entry and target → thesis in progress, intact
  } else if (targetKind === 'pin_to') {
    // Trade wins when spot stays at or near target_strike at
    // expiration. Wall break in EITHER direction = thesis broken.
    //
    // Audit #7: thresholds scale by spot, not absolute dollars, so
    // they work on SPX (0.5% of 5000 = 25 points) AND $30 stocks
    // (0.5% of 30 = $0.15).
    const distance = Math.abs(liveSpot - targetStrike)
    const driftMin = liveSpot * PIN_DRIFT_PCT
    const invalidateMin = liveSpot * PIN_INVALIDATE_PCT
    if (distance >= driftMin) {
      const direction = liveSpot > targetStrike ? 'above' : 'below'
      const pctMove = ((distance / liveSpot) * 100).toFixed(2)
      reasons.push(`Spot at ${liveSpot.toFixed(2)} is ${direction} the pin target ${formatStrike(targetStrike)} by ${distance.toFixed(2)} (${pctMove}%). Pin thesis weakening.`)
      state = distance > invalidateMin ? 'invalidated' : 'drifting'
    }
  } else if (targetKind === 'fade') {
    // Trade wins when spot mean-reverts toward target_strike. Closer
    // to the target = thesis playing out; further = thesis weakening.
    const entryDistance = Math.abs(entrySpot - targetStrike)
    const liveDistance = Math.abs(liveSpot - targetStrike)
    if (liveDistance < entryDistance * 0.3) {
      reasons.push(`Spot has reverted to ${liveSpot.toFixed(2)} — close to the fade target ${formatStrike(targetStrike)}. Thesis playing out.`)
    } else if (liveDistance > entryDistance * 1.5) {
      reasons.push(`Spot at ${liveSpot.toFixed(2)} has stretched further from the fade target ${formatStrike(targetStrike)} — thesis weakening.`)
      state = 'drifting'
    }
  }

  // Live-wall migration — only relevant when the structural target
  // hasn't been reached yet. Once a break_through has fired, the
  // trade is in P&L management mode (you've hit your structural
  // target), so the next dominant cluster is informational, not a
  // drift event. Same for pin_to / fade where the verdict is already
  // expressing the relevant dynamics in the per-thesis branch above.
  //
  // Audit #10: extend the heuristic-path "wall past target in trade's
  // favor" safe-harbor to the structured path. For break_through
  // trades, direction is unambiguous (we computed wantsUp/wantsDown
  // above) — if the live wall has run past target in that direction,
  // it's the structural backdrop reinforcing the thesis, not drift.
  //
  // Threshold scales by spot (audit #7). 5% of spot — calibrated to
  // match the original absolute-$5 behavior at $100 spot while
  // scaling correctly for SPX / small-cap underlyings.
  if (live.largest_wall && !breakThroughFired && state === 'intact') {
    const liveWallStrike = Number(live.largest_wall.strike)
    const wallDistance = Math.abs(liveWallStrike - targetStrike)
    const wallDriftMin = liveSpot * 0.05
    if (Number.isFinite(liveWallStrike) && wallDistance >= wallDriftMin) {
      // For break_through, check whether the wall has run PAST target
      // in the trade's direction (favorable migration, not drift).
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
        // state unchanged
      } else {
        reasons.push(`Live dominant wall is at ${formatStrike(liveWallStrike)} — your target was ${formatStrike(targetStrike)}. Different cluster anchoring the regime now.`)
        state = 'drifting'
      }
    }
  }

  if (state === 'intact' && reasons.length === 0) {
    reasons.push('Entry-time thesis still holds. Wall, regime, and price action all consistent with the structural target.')
  }

  return { state, reasons }
}

// Regime classifier with a noise deadband. `referenceGex` is the
// magnitude we treat as "meaningful" — typically |entry.net_gex|.
// Live values within ±REGIME_DEADBAND_RATIO of that reference (or
// below the absolute floor) read as 'mixed' regardless of sign.
// Audit #3 + #4: same classifier runs on both sides with the same
// reference, so a +$1M → -$1M flip stays 'mixed → mixed' instead of
// firing 'A → B → invalidated' on noise.
function regimeFromNetGex(netGex, referenceGex) {
  if (!Number.isFinite(netGex)) return 'mixed'
  const ref = Number.isFinite(referenceGex) ? Math.abs(referenceGex) : 0
  const threshold = Math.max(ref * REGIME_DEADBAND_RATIO, REGIME_DEADBAND_FLOOR)
  if (Math.abs(netGex) < threshold) return 'mixed'
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
