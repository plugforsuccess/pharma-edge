// The leader record (owner, 2026-10-19: "a live record of the price gain
// since becoming a leader" → "leaders should be buy and holds"). From the
// daily Leaders rule (leaders.js, past data only on each day) → each time a
// stock became a leader: the close that day, the latest close, the change
// held to today (dropping off the list is not a sale), the S&P 500 over the
// same days, and whether it's still on the list (left_on = the first day off).
// Dips off the list of up to STINT.mergeGap trading days (about a month) that end with the
// stock back on count as one stint (the rule's thresholds make stocks
// flicker). Price only, no dividends. npm run leaderrecord:check.

export const STINT = Object.freeze({ mergeGap: 21, lookback: 252 }) // 21 trading days ≈ a month (owner, 2026-10-19)

const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10000) / 10000)

// bars: [{ t, c }] oldest first; leaderDays: bool per bar; spy: Map t → close.
// → [{ joined_on, join_close, left_on, left_close, last_close, gain,
//      spy_gain, days, open }] for stints still open or joined in the lookback.
export function leaderStints(bars, leaderDays, { spy = null, lookback = STINT.lookback, mergeGap = STINT.mergeGap } = {}) {
  const n = bars.length, last = n - 1
  if (!n) return []
  const runs = []
  let s = -1
  for (let i = 0; i < n; i++) {
    if (leaderDays[i]) { if (s < 0) s = i } else if (s >= 0) { runs.push([s, i - 1]); s = -1 }
  }
  if (s >= 0) runs.push([s, last])
  const merged = []
  for (const r of runs) {
    const p = merged[merged.length - 1]
    if (p && r[0] - p[1] - 1 <= mergeGap) p[1] = r[1]
    else merged.push([...r])
  }
  const from = n - lookback
  return merged.filter(([a, b]) => a >= from || b === last).map(([a, b]) => {
    const open = b === last
    const off = open ? null : bars[b + 1] // the first day off the list (info only)
    const j = bars[a], e = bars[last]
    const sj = spy?.get(j.t), se = spy?.get(e.t)
    return {
      joined_on: j.t, join_close: r4(j.c),
      left_on: off?.t ?? null, left_close: off ? r4(off.c) : null,
      last_close: r4(e.c),
      gain: r4(e.c / j.c - 1), // held to today
      spy_gain: sj && se ? r4(se / sj - 1) : null,
      days: last - a, open,
    }
  })
}

// Summary for the record page: count, median change, share higher, median
// S&P change over the same stints, and the group view (owner, 2026-10-19):
// the mean change of every leader together beside the S&P's and any stock's
// mean over the same days (univ_med / univ_avg per stint, from the ranking).
export function stintSummary(stints) {
  const med = (xs) => { const v = xs.filter((x) => x != null).sort((p, q) => p - q); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null }
  const mean = (xs) => { const v = xs.filter((x) => x != null); return v.length ? v.reduce((a, x) => a + x, 0) / v.length : null }
  const g = stints.map((x) => x.gain).filter((x) => x != null)
  return {
    n: stints.length,
    median: med(g),
    higher: g.length ? g.filter((x) => x > 0).length / g.length : null,
    spyMedian: med(stints.map((x) => x.spy_gain)),
    beat: (() => { const k = stints.filter((x) => x.gain != null && x.spy_gain != null); return k.length ? k.filter((x) => x.gain > x.spy_gain).length / k.length : null })(),
    avg: mean(g),
    spyAvg: mean(stints.map((x) => x.spy_gain)),
    univMedian: med(stints.map((x) => x.univ_med)),
    univAvg: mean(stints.map((x) => x.univ_avg)),
  }
}
