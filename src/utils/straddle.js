// The straddle test (preregistration.md, 2026-10-26): an at-the-money call
// + put bought at a month start, expiring at the outcome horizon, priced by
// Black-Scholes at premium × 60-day realised vol, held to expiry or sold
// when the model value reaches 2× the premium. Pure; npm run straddle:check.
import { bsCall, bsPut, trailingVol } from './replay.js'

export const STRADDLE = Object.freeze({ horizon: 126, premium: 1.3, premiums: [1.0, 1.3, 1.6], volBars: 60, volFloor: 0.15, slip: 0.02, target: 2, rate: 0.04, year: 252 })

export const straddleValue = (S, K, T, vol, r = STRADDLE.rate) => (T <= 0 ? Math.abs(S - K) : bsCall(S, K, T, vol, r) + bsPut(S, K, T, vol, r))

// One trade from bar i. Returns null when the horizon runs past the data.
// { premium, exitValue, ret, days, hit } — ret is on the premium paid, after slippage both ways.
export function straddleTrade(bars, i, { premium = STRADDLE.premium, horizon = STRADDLE.horizon, target = null, p = STRADDLE } = {}) {
  if (i + horizon >= bars.length) return null
  const rv = trailingVol(bars.slice(Math.max(0, i - p.volBars), i + 1).map((b) => b.c), p.volBars).at(-1)
  if (!(rv > 0)) return null
  const vol = Math.max(p.volFloor, rv * premium)
  const S0 = bars[i].c, K = S0
  const T0 = horizon / p.year
  const paid = straddleValue(S0, K, T0, vol) * (1 + p.slip)
  for (let j = i + 1; j <= i + horizon; j++) {
    const T = (i + horizon - j) / p.year
    const v = straddleValue(bars[j].c, K, T, vol)
    if (target && v >= target * paid / (1 + p.slip)) {
      const got = v * (1 - p.slip)
      return { premium: paid, exitValue: got, ret: got / paid - 1, days: j - i, hit: true }
    }
  }
  const got = Math.abs(bars[i + horizon].c - K) * (1 - p.slip)
  return { premium: paid, exitValue: got, ret: got / paid - 1, days: horizon, hit: false }
}

export function straddleStats(trades) {
  const t = trades.filter(Boolean)
  const rets = t.map((x) => x.ret).sort((a, b) => a - b)
  const n = rets.length
  if (!n) return { n: 0 }
  const avg = rets.reduce((a, b) => a + b, 0) / n
  return { n, avg, median: rets[Math.floor(n / 2)], win: rets.filter((r) => r > 0).length / n, lostHalf: rets.filter((r) => r <= -0.5).length / n, hitRate: t.filter((x) => x.hit).length / n, medDays: t.map((x) => x.days).sort((a, b) => a - b)[Math.floor(n / 2)] }
}

export const STRADDLE_PASS = Object.freeze({ avgGap: 0.10, minTrades: 100 })
export function straddleVerdict(flag, universe, p = STRADDLE_PASS) {
  if (!flag || flag.n < p.minTrades) return 'inconclusive'
  return flag.avg > 0 && flag.avg - universe.avg >= p.avgGap && flag.median > universe.median ? 'pass' : 'fail'
}
