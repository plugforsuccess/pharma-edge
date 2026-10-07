// Today's momentum list and the forward record (owner, 2026-10-07: "1 and
// 3" — put the momentum list in the app; track setups forward in the open).
//
// momentumToday   the cross-sectional 12-1 rule (src/utils/momentum.js) at
//                 the latest bar: every ticker with a year of history scored
//                 by its 12-1 return, eligible above its 200-day, the top
//                 decile of the eligible (≥ minNames scored). Same rule the
//                 pre-registered test traded, run daily instead of at month
//                 ends so the list is current.
// moveGroups      picks whose daily returns over the last `window` bars
//                 correlate at ≥ `threshold` are grouped (union-find), so
//                 five memory names read as one bet, not five.
// SWING_PLAN      the exit the momentum list shows — the swing-grid variant
//                 that led the test: sell the whole call at +75%, else at an
//                 18-month cap, no stop (docs/signal-engine/preregistration.md,
//                 "the swing exit"). The forward record grades every logged
//                 setup by the same plan so they compare.
// forwardOutcome  one logged setup walked forward on daily closes: the call
//                 marked by Black-Scholes on trailing 60-day vol (as the
//                 replay does), the target hit on the first close at or above
//                 cost × (1 + target), the cap after holdDays bars.
//
// Pure — `npm run momentumlist:check`.

import { MOMENTUM, momentumScore } from './momentum.js'
import { OPTION_MODEL, bsCall, trailingVol } from './replay.js'

export const SWING_PLAN = Object.freeze({ target: 0.75, holdDays: 378, label: 'Sell at +75% on the call, or after 18 months' })

const sma = (xs, n, i) => {
  if (i + 1 < n) return null
  let s = 0
  for (let k = i - n + 1; k <= i; k++) s += xs[k]
  return s / n
}

// items: [{ ticker, bars }] → { picks: [...], scored, eligible }
export function momentumToday(items, p = MOMENTUM) {
  const rows = []
  let scored = 0
  for (const it of items) {
    const closes = it.bars.map((b) => b.c)
    const i = closes.length - 1
    const score = momentumScore(closes, i, p)
    const s200 = sma(closes, 200, i)
    if (score == null || s200 == null) continue
    scored++
    if (!(closes[i] > s200)) continue
    const hi = Math.max(...closes.slice(-252))
    const vol = trailingVol(closes, 60)[i]
    rows.push({
      ticker: it.ticker, asOf: it.bars[i].t, close: closes[i], score,
      vs200: closes[i] / s200 - 1,
      r1m: i >= 21 ? closes[i] / closes[i - 21] - 1 : null,
      offHigh: closes[i] / hi - 1,
      hv60: vol ?? null,
    })
  }
  rows.sort((a, b) => b.score - a.score || a.ticker.localeCompare(b.ticker))
  const k = rows.length >= p.minNames ? Math.max(1, Math.floor(rows.length * p.topFrac)) : 0
  return { picks: rows.slice(0, k).map((r, n) => ({ ...r, rank: n + 1 })), scored, eligible: rows.length }
}

function logReturns(closes, n) {
  const out = []
  for (let i = Math.max(1, closes.length - n); i < closes.length; i++) out.push(Math.log(closes[i] / closes[i - 1]))
  return out
}
function corr(a, b) {
  const n = Math.min(a.length, b.length)
  if (n < 20) return null
  const x = a.slice(-n), y = b.slice(-n)
  const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n
  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null
}

// picks: [{ ticker, closes }] → Map(ticker → { group, peers: [ticker] })
// group = the lowest-ranked member's ticker; singletons get group = own ticker, no peers.
export function moveGroups(picks, { window = 120, threshold = 0.7 } = {}) {
  const rets = picks.map((p) => logReturns(p.closes, window))
  const parent = picks.map((_, i) => i)
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const peers = picks.map(() => new Set())
  for (let i = 0; i < picks.length; i++) for (let j = i + 1; j < picks.length; j++) {
    const c = corr(rets[i], rets[j])
    if (c != null && c >= threshold) {
      peers[i].add(picks[j].ticker); peers[j].add(picks[i].ticker)
      const a = find(i), b = find(j)
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b)
    }
  }
  const out = new Map()
  picks.forEach((p, i) => out.set(p.ticker, { group: picks[find(i)].ticker, peers: [...peers[i]] }))
  return out
}

// One logged setup walked forward. bars: the ticker's daily bars (oldest
// first); log: { logged_on, strike, expiry, cost, target, hold_days }.
// → { status: 'open' | 'hit' | 'capped' | 'expired' | 'unknown', last_date,
//     stock_ret, call_ret, peak_call_ret, days, closed_on }
export function forwardOutcome(bars, log, opt = OPTION_MODEL) {
  const e = bars.findIndex((b) => b.t >= log.logged_on)
  if (e < 0 || !(log.cost > 0) || !(log.strike > 0)) return { status: 'unknown' }
  // The log is written after the close of logged_on: its close is the entry reference.
  const entryIdx = bars[e].t === log.logged_on ? e : e - 1
  if (entryIdx < 0) return { status: 'unknown' }
  const closes = bars.map((b) => b.c)
  const vols = trailingVol(closes, opt.volBars)
  const S0 = closes[entryIdx]
  const expiry = Date.parse(`${log.expiry}T00:00:00Z`)
  const target = log.target ?? SWING_PLAN.target
  const cap = log.hold_days ?? SWING_PLAN.holdDays
  let peak = 0, last = { idx: entryIdx, ret: 0 }
  for (let j = entryIdx + 1; j < bars.length; j++) {
    const T = (expiry - Date.parse(`${bars[j].t}T00:00:00Z`)) / (365 * 86400e3)
    const vol = Math.max(vols[j] ?? 0, opt.volFloor)
    const mark = T > 0 ? bsCall(closes[j], log.strike, T, vol) : Math.max(0, closes[j] - log.strike)
    const ret = mark / log.cost - 1
    peak = Math.max(peak, ret)
    last = { idx: j, ret }
    const base = { last_date: bars[j].t, stock_ret: closes[j] / S0 - 1, call_ret: ret, peak_call_ret: peak, days: j - entryIdx }
    if (ret >= target) return { status: 'hit', closed_on: bars[j].t, ...base }
    if (T <= 0) return { status: 'expired', closed_on: bars[j].t, ...base }
    if (j - entryIdx >= cap) return { status: 'capped', closed_on: bars[j].t, ...base }
  }
  return { status: 'open', closed_on: null, last_date: bars[last.idx].t, stock_ret: closes[last.idx] / S0 - 1, call_ret: last.ret, peak_call_ret: peak, days: last.idx - entryIdx }
}

// Canonical string for a log row's hash (the DB trigger hashes the same
// fields in the same order; this mirror lets anyone verify a row).
export function logCanonical(r) {
  return JSON.stringify([r.logged_on, r.kind, r.ticker, r.rank ?? null, Number(r.close), Number(r.strike), r.expiry, Number(r.cost), Number(r.target), Number(r.hold_days)])
}
