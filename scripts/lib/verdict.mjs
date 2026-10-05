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
import { OPTION_MODEL, strikeForDelta, bsCall, trailingVol, replaySignals, replayTrades, tradeStats, bigMoves, gradeMoves, moveStats } from '../../src/utils/replay.js'

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

// This ticker's own replay of the app's rule (owner, 2026-10-05: the card
// showed the pattern's record across all stocks while the rule on UNH
// itself had lost 3 of 4): the buy zone → exit targets as the app plays
// it, plus 2+ signals (confluence) as the broader version; the open trade,
// the last trades, and the ticker's big rallies caught vs missed.
export function ownRecord(bars, model, suite) {
  const sig = replaySignals(bars, model, suite)
  const vol = trailingVol(bars.map((b) => b.c), OPTION_MODEL.volBars)
  const r2 = (x) => (x == null ? null : Math.round(x * 1000) / 1000)
  const rule = (entryRule) => {
    const trades = replayTrades(bars, sig, { entryRule, exitRule: 'targets', vol })
    const st = tradeStats(trades)
    const open = trades.find((t) => t.open)
    return {
      n: st.n, closed: st.closed, wins: trades.filter((t) => !t.open && t.optionReturn > 0).length,
      avg: r2(st.avg), median: r2(st.median), big_loss: r2(st.bigLoss), avg_days: st.avgDays == null ? null : Math.round(st.avgDays),
      open: open ? { signal: open.signalT, price: r2(open.stock), option: r2(open.optionReturn), stock: r2(open.stockReturn) } : null,
      last: trades.slice(-3).map((t) => ({ signal: t.signalT, end: t.open ? null : t.endT, option: r2(t.optionReturn), stock: r2(t.stockReturn), open: !!t.open })),
      trades,
    }
  }
  const zone = rule('zone')
  const confluence = rule('confluence')
  const moves = bigMoves(bars)
  const graded = gradeMoves(moves, zone.trades, sig, bars)
  const ms = moveStats(graded)
  const why = {}
  for (const g of graded) if (!g.caught) why[g.why] = (why[g.why] ?? 0) + 1
  delete zone.trades; delete confluence.trades
  return { zone, confluence, moves: { n: ms.moves, caught: ms.caught, why } }
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
