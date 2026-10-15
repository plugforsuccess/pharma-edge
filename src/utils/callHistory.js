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

import { OPTION_MODEL, bsCall, strikeForDelta, trailingVol } from './replay.js'

// [label, trading days, calendar days]
export const CALL_HORIZONS = Object.freeze([['1M', 21, 30], ['3M', 63, 91], ['6M', 126, 182], ['12M', 252, 365]])
export const SIM_MOVES = Object.freeze([-0.2, -0.1, 0, 0.1, 0.2, 0.3])
const DAY = 86_400_000
const days = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY)

// One call bought at bar e's open (signal at e − 1's close), marked at each
// horizon. Returns null when there's no vol yet.
export function callPath(bars, vols, e, opt = OPTION_MODEL) {
  if (e < 1 || e >= bars.length) return null
  const v0 = Math.max(vols[e - 1] ?? 0, opt.volFloor)
  if (!(vols[e - 1] > 0)) return null
  const S0 = bars[e].o > 0 ? bars[e].o : bars[e].c
  const T0 = opt.dte / 365
  const K = strikeForDelta(S0, T0, v0, opt.delta)
  const cost = bsCall(S0, K, T0, v0) * (1 + opt.slippage)
  if (!(cost > 0)) return null
  const call = [], stock = []
  for (const [, h] of CALL_HORIZONS) {
    const j = e + h
    if (j >= bars.length) { call.push(null); stock.push(null); continue }
    const left = (opt.dte - days(bars[e].t, bars[j].t)) / 365
    const vj = Math.max(vols[j] ?? v0, opt.volFloor)
    const value = bsCall(bars[j].c, K, left, vj) * (1 - opt.slippage)
    call.push(value / cost - 1)
    stock.push(bars[j].c / S0 - 1)
  }
  return { t: bars[e - 1].t, strike: K, cost, call, stock }
}

// Every signal in `entries` (boolean per bar, true at the signal's close).
export function callHistory(bars, entries, { vols = null, opt = OPTION_MODEL } = {}) {
  const v = vols ?? trailingVol(bars.map((b) => b.c), opt.volBars)
  const out = []
  for (let i = 0; i < entries.length - 1; i++) if (entries[i]) { const p = callPath(bars, v, i + 1, opt); if (p) out.push(p) }
  return out
}

// The yardstick: a call bought every `every` trading days.
export function anyDayHistory(bars, { vols = null, every = 5, opt = OPTION_MODEL } = {}) {
  const v = vols ?? trailingVol(bars.map((b) => b.c), opt.volBars)
  const out = []
  for (let i = opt.volBars; i < bars.length - 1; i += every) { const p = callPath(bars, v, i + 1, opt); if (p) out.push(p) }
  return out
}

const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000)
function quant(sorted, q) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] : null }

// Per horizon: n, average, median, share up, the worst / best case, the
// bad quarter (25th percentile) and the stock's average over the same span.
export function callStats(paths) {
  return CALL_HORIZONS.map(([label], h) => {
    const rs = paths.map((p) => p.call[h]).filter((x) => x != null).sort((a, b) => a - b)
    const ss = paths.map((p) => p.stock[h]).filter((x) => x != null)
    if (!rs.length) return { label, n: 0 }
    return {
      label, n: rs.length,
      avg: r3(rs.reduce((a, x) => a + x, 0) / rs.length),
      median: r3(quant(rs, 0.5)),
      win: r3(rs.filter((x) => x > 0).length / rs.length),
      badq: r3(quant(rs, 0.25)),
      worst: r3(rs[0]), best: r3(rs[rs.length - 1]),
      stock: r3(ss.reduce((a, x) => a + x, 0) / ss.length),
    }
  })
}

// Today's call valued after each horizon for each stock move, holding vol.
// trade: { strike, cost (per share, incl. entry slippage), vol, expiry }.
export function simulateCall({ S, trade, asOf, moves = SIM_MOVES, opt = OPTION_MODEL }) {
  if (!(S > 0) || !trade?.strike || !trade?.cost || !trade?.expiry) return null
  const T0 = days(asOf, trade.expiry)
  const vol = Math.max(trade.vol ?? 0, opt.volFloor)
  return CALL_HORIZONS.map(([label, , cal]) => {
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
export function breakevenMoves({ S, trade, asOf, opt = OPTION_MODEL }) {
  if (!(S > 0) || !trade?.cost) return null
  const T0 = days(asOf, trade.expiry)
  const vol = Math.max(trade.vol ?? 0, opt.volFloor)
  return CALL_HORIZONS.map(([label, , cal]) => {
    const left = Math.max(0, T0 - cal) / 365
    const f = (m) => bsCall(S * (1 + m), trade.strike, left, vol) * (1 - opt.slippage) - trade.cost
    let lo = -0.9, hi = 3
    if (f(hi) < 0) return { label, move: null }
    for (let k = 0; k < 60; k++) { const mid = (lo + hi) / 2; if (f(mid) < 0) lo = mid; else hi = mid }
    return { label, move: r3(hi) }
  })
}
