// Call history + profit simulator for the Pullbacks rows (owner, 2026-10-15:
// "see profit simulators and historical gains on the different calls for
// 1M, 3M, 6M, 12M").
//
// History: for each past signal on a ticker, the call the app suggests
// (~730 DTE, 0.75 delta, Black-Scholes on trailing 60-day vol, 2% slippage
// each way — the replay's OPTION_MODEL) bought at the next open and marked
// 1 / 3 / 6 / 12 months later, re-marked on the vol known then. Fixed
// horizons, no exit plan: "what was the call worth N months later". The
// same is computed on every ~5th trading day of every ticker ("any day"),
// the yardstick the setup has to beat. Estimates, not quotes.
//
// Simulator: today's suggested call valued for a stock move at each
// horizon, holding today's vol — what-ifs, not predictions.
//
// Plays (owner, 2026-10-15: "pullbacks at the money — short-term contracts
// catching the swing, holding 1-2 weeks, and then LEAPS that are
// compounding"): at-the-money calls at 1M / 3M / 6M / 12M to expiry, marked
// after a 1- and 2-week hold, and the ~2-year LEAPS marked after 6 and 12
// months. Every function below takes `horizons` (default CALL_HORIZONS).

import { OPTION_MODEL, bsCall, strikeForDelta, trailingVol, normCdf } from './replay.js'

// At the money = strike at the stock price (a ~2-year ATM call is ~0.6 delta).
export const ATM_MODEL = Object.freeze({ ...OPTION_MODEL, atm: true })

// [label, trading days, calendar days]
export const CALL_HORIZONS = Object.freeze([['1M', 21, 30], ['3M', 63, 91], ['6M', 126, 182], ['12M', 252, 365]])
export const SIM_MOVES = Object.freeze([-0.2, -0.1, 0, 0.1, 0.2, 0.3])
export const SWING_HOLDS = Object.freeze([['1W', 5, 7], ['2W', 10, 14]])
export const LEAPS_HOLDS = Object.freeze([['6M', 126, 182], ['12M', 252, 365]])
export const SWING_MOVES = Object.freeze([-0.1, -0.05, 0, 0.05, 0.1, 0.15])
export const PLAYS = Object.freeze([
  { key: '1M', span: '1M', dte: 30, bars: 21, kind: 'swing', holds: SWING_HOLDS, moves: SWING_MOVES },
  { key: '3M', span: '3M', dte: 91, bars: 63, kind: 'swing', holds: SWING_HOLDS, moves: SWING_MOVES },
  { key: '6M', span: '6M', dte: 182, bars: 126, kind: 'swing', holds: SWING_HOLDS, moves: SWING_MOVES },
  { key: '12M', span: '12M', dte: 365, bars: 252, kind: 'swing', holds: SWING_HOLDS, moves: SWING_MOVES },
  { key: 'LEAPS', span: '2Y', dte: 730, bars: 504, kind: 'leaps', holds: LEAPS_HOLDS, moves: SIM_MOVES },
])
// History per play (owner, 2026-10-15: "compared to itself on the same
// signal for the same durations as the calls … spot gain over the 1M, 3M,
// 6M, 12M, 2 year intervals"): the stock's gain over the call's life beside
// the call held to expiry, both from the same signal.
export const playSpan = (play) => Object.freeze([[play.span, play.bars, play.dte]])
export const playModel = (play) => ({ ...ATM_MODEL, dte: play.dte })
const DAY = 86_400_000
const days = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY)

// One call bought at bar e's open (signal at e − 1's close), marked at each
// horizon. Returns null when there's no vol yet.
export function callPath(bars, vols, e, opt = OPTION_MODEL, horizons = CALL_HORIZONS) {
  if (e < 1 || e >= bars.length) return null
  const v0 = Math.max(vols[e - 1] ?? 0, opt.volFloor)
  if (!(vols[e - 1] > 0)) return null
  const S0 = bars[e].o > 0 ? bars[e].o : bars[e].c
  const T0 = opt.dte / 365
  const K = opt.atm ? S0 : strikeForDelta(S0, T0, v0, opt.delta)
  const cost = bsCall(S0, K, T0, v0) * (1 + opt.slippage)
  if (!(cost > 0)) return null
  const call = [], stock = []
  for (const [, h] of horizons) {
    const j = e + h
    if (j >= bars.length) { call.push(null); stock.push(null); continue }
    const left = Math.max(0, opt.dte - days(bars[e].t, bars[j].t)) / 365
    const vj = Math.max(vols[j] ?? v0, opt.volFloor)
    const value = bsCall(bars[j].c, K, left, vj) * (1 - opt.slippage)
    call.push(value / cost - 1)
    stock.push(bars[j].c / S0 - 1)
  }
  return { t: bars[e - 1].t, strike: K, cost, call, stock }
}

// Signals in `entries` (boolean per bar, true at the signal's close), one
// per cluster: a signal within `gap` trading days of the last one counted is
// the same dip re-triggering, not a new case (else one dip reads as "10
// times, 100% up").
export const CLUSTER_GAP = 21
export function callHistory(bars, entries, { vols = null, opt = OPTION_MODEL, gap = CLUSTER_GAP, horizons = CALL_HORIZONS } = {}) {
  const v = vols ?? trailingVol(bars.map((b) => b.c), opt.volBars)
  const out = []
  let last = -Infinity
  for (let i = 0; i < entries.length - 1; i++) {
    if (!entries[i] || i - last < gap) continue
    last = i
    const p = callPath(bars, v, i + 1, opt, horizons)
    if (p) out.push(p)
  }
  return out
}

// The yardstick: a call bought every `every` trading days.
export function anyDayHistory(bars, { vols = null, every = 5, opt = OPTION_MODEL, horizons = CALL_HORIZONS } = {}) {
  const v = vols ?? trailingVol(bars.map((b) => b.c), opt.volBars)
  const out = []
  for (let i = opt.volBars; i < bars.length - 1; i += every) { const p = callPath(bars, v, i + 1, opt, horizons); if (p) out.push(p) }
  return out
}

const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000)
function quant(sorted, q) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] : null }

// Per horizon: n, average, median, share up, the worst / best case, the
// bad quarter (25th percentile) and the stock's average over the same span.
export function callStats(paths, horizons = CALL_HORIZONS) {
  return horizons.map(([label], h) => {
    const rs = paths.map((p) => p.call[h]).filter((x) => x != null).sort((a, b) => a - b)
    const ss = paths.map((p) => p.stock[h]).filter((x) => x != null).sort((a, b) => a - b)
    if (!rs.length) return { label, n: 0 }
    return {
      label, n: rs.length,
      avg: r3(rs.reduce((a, x) => a + x, 0) / rs.length),
      median: r3(quant(rs, 0.5)),
      win: r3(rs.filter((x) => x > 0).length / rs.length),
      badq: r3(quant(rs, 0.25)),
      worst: r3(rs[0]), best: r3(rs[rs.length - 1]),
      stock: r3(ss.reduce((a, x) => a + x, 0) / ss.length),
      stockMedian: r3(quant(ss, 0.5)),
      stockWin: r3(ss.filter((x) => x > 0).length / ss.length),
    }
  })
}

// Today's call valued after each horizon for each stock move, holding vol.
// trade: { strike, cost (per share, incl. entry slippage), vol, expiry }.
export function simulateCall({ S, trade, asOf, moves = SIM_MOVES, opt = OPTION_MODEL, horizons = CALL_HORIZONS }) {
  if (!(S > 0) || !trade?.strike || !trade?.cost || !trade?.expiry) return null
  const T0 = days(asOf, trade.expiry)
  const vol = Math.max(trade.vol ?? 0, opt.volFloor)
  return horizons.map(([label, , cal]) => {
    const left = Math.max(0, T0 - cal) / 365
    return {
      label,
      cells: moves.map((m) => {
        const value = bsCall(S * (1 + m), trade.strike, left, vol) * (1 - opt.slippage)
        return { move: m, value, ret: value / trade.cost - 1, pnl: (value - trade.cost) * 100 }
      }),
    }
  })
}

// Stock price that breaks even on the call at each horizon (bisection).
export function breakevenMoves({ S, trade, asOf, opt = OPTION_MODEL, horizons = CALL_HORIZONS }) {
  if (!(S > 0) || !trade?.cost) return null
  const T0 = days(asOf, trade.expiry)
  const vol = Math.max(trade.vol ?? 0, opt.volFloor)
  return horizons.map(([label, , cal]) => {
    const left = Math.max(0, T0 - cal) / 365
    const f = (m) => bsCall(S * (1 + m), trade.strike, left, vol) * (1 - opt.slippage) - trade.cost
    let lo = -0.9, hi = 3
    if (f(hi) < 0) return { label, move: null }
    for (let k = 0; k < 60; k++) { const mid = (lo + hi) / 2; if (f(mid) < 0) lo = mid; else hi = mid }
    return { label, move: r3(hi) }
  })
}

// Today's at-the-money version of a row's trade: same expiry and vol, the
// strike at the price (nearest $1, $0.50 under $25), priced the same way.
export function atmTrade({ S, trade, asOf, opt = OPTION_MODEL }) {
  if (!(S > 0) || !trade?.expiry) return null
  const T = days(asOf, trade.expiry) / 365
  const vol = Math.max(trade.vol ?? 0, opt.volFloor)
  const step = S < 25 ? 0.5 : 1
  const K = Math.round(S / step) * step
  const cost = bsCall(S, K, T, vol) * (1 + opt.slippage)
  const d1 = (Math.log(S / K) + (opt.rate + vol * vol / 2) * T) / (vol * Math.sqrt(T))
  return { strike: K, cost: Math.round(cost * 100) / 100, vol: trade.vol, expiry: trade.expiry, delta: Math.round(normCdf(d1) * 100) / 100, breakeven: Math.round((K + cost) * 100) / 100 }
}

// A listed-looking expiry for a play: the third Friday of the month nearest
// asOf + dte (January only for LEAPS, the usual LEAPS month), never sooner
// than ¾ of the play's days.
export function playExpiry(asOf, play) {
  const t0 = Date.parse(`${asOf}T00:00:00Z`)
  const target = t0 + play.dte * DAY
  const d0 = new Date(t0)
  let best = null
  for (let m = 0; m <= Math.ceil(play.dte / 30) * 2 + 2; m++) {
    const y = d0.getUTCFullYear(), mo = d0.getUTCMonth() + m
    const first = new Date(Date.UTC(y, mo, 1))
    if (play.kind === 'leaps' && first.getUTCMonth() !== 0) continue
    const fri = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1 + ((5 - first.getUTCDay() + 7) % 7) + 14))
    const t = fri.getTime()
    if (t - t0 < play.dte * 0.75 * DAY) continue
    if (!best || Math.abs(t - target) < Math.abs(best - target)) best = t
  }
  return new Date(best).toISOString().slice(0, 10)
}

// Today's at-the-money contract for a play: strike at the price (nearest $1,
// $0.50 under $25), priced on the row's trailing vol, 2% slippage in.
export function playContract({ S, vol, asOf, play, opt = OPTION_MODEL }) {
  if (!(S > 0) || !asOf) return null
  const expiry = playExpiry(asOf, play)
  const T = days(asOf, expiry) / 365
  const v = Math.max(vol ?? 0, opt.volFloor)
  const step = S < 25 ? 0.5 : 1
  const K = Math.round(S / step) * step
  const cost = bsCall(S, K, T, v) * (1 + opt.slippage)
  const d1 = (Math.log(S / K) + (opt.rate + v * v / 2) * T) / (v * Math.sqrt(T))
  return { strike: K, expiry, cost: Math.round(cost * 100) / 100, vol: v, delta: Math.round(normCdf(d1) * 100) / 100, breakeven: Math.round((K + cost) * 100) / 100, dte: days(asOf, expiry) }
}
