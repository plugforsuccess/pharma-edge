// Leaders (owner, 2026-10-16: "We only want leaders"). The winner-traits
// study (scripts/winner-traits.mjs, 2026-10-15: ~9,700 pullback entries,
// at-the-money 2-year calls with the exit plan, traits found on 2021–23
// and checked on 2024 →) found no entry-day trait that separates winners
// from losers, but five that tilt the odds in both periods: a stock that is
// already strong, well above a steeply rising 200-day, with options cheap
// against their past year (the S&P-above-its-200-day check is off since
// 2026-10-19 — see LEADER). A leader
// meets every rule in LEADER on the signal day (nothing after it).
//
// Thresholds are the study's train-period medians (the cut between the
// halves it tested), and the volatility-rank cut is the top fifth it found
// to do worst. npm run leaders:check.

import { trailingVol, OPTION_MODEL } from './replay.js'

export const LEADER = Object.freeze({
  mom12: 0.17,       // 12-month return, skipping the last month, above +17%
  vs200: 0.09,       // close at least 9% above the 200-day
  slope200: 0.014,   // 200-day up at least 1.4% over 20 trading days
  volRankMax: 0.45,  // 60-day volatility in the cheaper 45% of its past year
  // The S&P-above-its-200-day check is off (owner, 2026-10-19): the 5-year
  // stock test (scripts/leader-stock-test.mjs) found no measurable benefit,
  // and it emptied the list whenever the S&P dipped. The trait is still
  // computed (spyUp) for the market card and research; pass a rule with
  // spyUp: true to apply it.
  spyUp: false,
})

const sma = (xs, n) => { const out = Array(xs.length).fill(null); let s = 0; xs.forEach((x, i) => { s += x; if (i >= n) s -= xs[i - n]; if (i >= n - 1) out[i] = s / n }); return out }

// Percentile of xs[i] among the last `look` values (null until half filled).
export function pctRank(xs, i, look = 252) {
  const v = xs[i]
  if (v == null) return null
  let k = 0, m = 0
  for (let j = Math.max(0, i - look + 1); j <= i; j++) if (xs[j] != null) { m++; if (xs[j] <= v) k++ }
  return m >= look / 2 ? k / m : null
}

// Per-bar traits for a ticker. bars / spyBars: [{ t, c }], oldest first.
// Pass `vol` to reuse a trailing-vol series already computed (same 60 bars).
export function leaderSeries(bars, spyBars = [], { vol = null } = {}) {
  const c = bars.map((b) => b.c)
  const s200 = sma(c, 200)
  const v = vol ?? trailingVol(c, OPTION_MODEL.volBars)
  const spyC = spyBars.map((b) => b.c), spyS = sma(spyC, 200)
  const spy = new Map(spyBars.map((b, i) => [b.t, { c: b.c, s200: spyS[i] }]))
  return {
    at(i) {
      if (i < 260 || s200[i] == null || s200[i - 20] == null) return null
      const sp = spy.get(bars[i].t)
      return {
        mom12: c[i - 21] / c[i - 252] - 1,
        vs200: c[i] / s200[i] - 1,
        slope200: s200[i] / s200[i - 20] - 1,
        volRank: pctRank(v, i, 252),
        spyUp: sp?.s200 ? sp.c > sp.s200 : null,
      }
    },
  }
}

// Which rules a day's traits miss ([] = a leader). An unknown trait misses.
export function leaderMisses(tr, rule = LEADER) {
  if (!tr) return ['history']
  const miss = []
  if ('mom12' in rule && !(tr.mom12 > rule.mom12)) miss.push('mom12')
  if ('vs200' in rule && !(tr.vs200 >= rule.vs200)) miss.push('vs200')
  if ('slope200' in rule && !(tr.slope200 >= rule.slope200)) miss.push('slope200')
  if ('volRankMax' in rule && !(tr.volRank != null && tr.volRank <= rule.volRankMax)) miss.push('volRank')
  if (rule.spyUp && tr.spyUp !== true) miss.push('spyUp')
  return miss
}
export const isLeader = (tr, rule = LEADER) => leaderMisses(tr, rule).length === 0
