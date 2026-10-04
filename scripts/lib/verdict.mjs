// What a Confluence leaders row tells the user to do (owner, 2026-10-04:
// "it's not telling me how to enter"). Pure; fed by rank-confluence.mjs.
//
//   buy   enter  the buy zone is YES (all 5 conditions) with 2+ signals and
//                the 200-day rising — the only combination the app's rules
//                call an entry
//         wait   2+ signals, 200-day rising, but a buy-zone condition is
//                missing; `blockers` names each one
//         watch  2+ signals with the 200-day falling (never ranked)
//   sell  extended  2+ sell signals and the stock is extended (RSI ≥ 70 or
//                   top decile above the 200-day)
//         turning   2+ sell signals without the extension
//
// trade  the call the replay would price at this close: ~730 DTE, 0.75
//        delta, Black-Scholes on trailing 60-day vol — an estimate, not a
//        quote (src/utils/replay.js OPTION_MODEL).
// stop   "exit if it closes below": the last confirmed swing low under the
//        close, capped at the lowest low of the last 40 bars (owner,
//        2026-10-04: a stock that has run far shouldn't read a 30% stop as
//        the plan) — but never tighter than the buy zone's own floor, 5%
//        under the 200-day (owner, 2026-10-04: on a dip buy the 40-bar low
//        is the dip itself, a 1% noise stop on a two-year call; if price
//        closes under the band the setup that justified the entry is gone).

import { entryGaps } from '../../src/utils/indicators.js'
import { swingPoints, MIN_SCORE } from '../../src/utils/confluence.js'
import { OPTION_MODEL, strikeForDelta, bsCall, trailingVol } from '../../src/utils/replay.js'

const LABEL = {
  band: 'Not within 5% of the 200-day',
  rising: '200-day falling',
  trend: '50-day below the 200-day',
  rsi: 'RSI not reset',
  iv: 'IV Rank too high',
}

export function blockers(model) {
  const gaps = entryGaps(model)
  if (!gaps) return []
  const s = model.status
  const out = []
  for (const [k, g] of Object.entries(gaps)) {
    if (!g) continue
    const label = k === 'iv' && s.ivRank != null ? `IV Rank ${Math.round(s.ivRank)}, needs < ${model.params.ivRankMax}` : LABEL[k]
    out.push({ k, label, need: g.need })
  }
  return out
}

export function buyVerdict({ score, trendUp, cond }) {
  if (score < MIN_SCORE) return null
  if (!trendUp) return 'watch'
  return cond?.all ? 'enter' : 'wait'
}

// Bravo's regime at the close: 'up' = close and fast EMA above the basis.
// ENTER + down is an early entry (the dip is still in progress); ENTER + up
// is confirmed.
export function momentum(suite) {
  const r = suite?.bravo?.regime
  return Array.isArray(r) && r[r.length - 1] === 1 ? 'up' : 'down'
}

export function sellVerdict({ score, lit }) {
  if (score < MIN_SCORE) return null
  return lit.includes('ext') ? 'extended' : 'turning'
}

export function tradeSpec(bars, opt = OPTION_MODEL) {
  const n = bars.length
  const closes = bars.map((b) => b.c)
  const vol = Math.max(trailingVol(closes, opt.volBars)[n - 1] ?? 0, opt.volFloor)
  if (!(vol > 0)) return null
  const S = closes[n - 1]
  const T = opt.dte / 365
  const strike = strikeForDelta(S, T, vol, opt.delta)
  const cost = bsCall(S, strike, T, vol) * (1 + opt.slippage)
  const exp = new Date(`${bars[n - 1].t}T12:00:00Z`)
  exp.setUTCDate(exp.getUTCDate() + opt.dte)
  return {
    delta: opt.delta,
    strike: Math.round(strike * 2) / 2,
    expiry: exp.toISOString().slice(0, 10),
    cost: Math.round(cost * 100) / 100,
    vol: Math.round(vol * 1000) / 1000,
    breakeven: Math.round((strike + cost) * 100) / 100,
  }
}

export function structureStop(bars, { sma200 = null, bandPct = 5, swing = 10, fallback = 40 } = {}) {
  const n = bars.length
  const close = bars[n - 1].c
  let recent = null
  for (let i = Math.max(0, n - fallback); i < n; i++) if (!recent || bars[i].l < recent.price) recent = { price: bars[i].l, date: bars[i].t }
  let stop = recent
  const { lows } = swingPoints(bars, swing)
  for (let j = lows.length - 1; j >= 0; j--) {
    const i = lows[j]
    if (bars[i].l < close) { stop = bars[i].l >= recent.price ? { price: bars[i].l, date: bars[i].t } : recent; break }
  }
  const floor = sma200 > 0 ? sma200 * (1 - bandPct / 100) : null
  if (floor != null && floor < close && floor < stop.price) stop = { price: floor, date: null, basis: 'band' }
  return stop
}
