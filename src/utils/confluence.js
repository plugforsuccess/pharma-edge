// Confluence on the LEAPS entry chart (owner, 2026-10-03: "the low points
// need to align with the indicator suites; confluence across panels
// matters; historical patterns should inform suggested entries"). Pure
// functions; `npm run confluence:check` runs scripts/check-confluence.mjs.
//
// Score (live, look-back only): how many of five signals fired within the
// last `window` bars, today included —
//   zone   the buy zone (all 5 conditions)   bravo  a Bravo bull diamond
//   echo   an Echo bull cross                tango  a Tango bull cross
//   macd   a MACD cross up
// It sits beside the buy-zone YES / NO (which stays the rule).
//
// Swing lows / highs are only known in hindsight (the lowest low with
// `swing` bars either side), so they never feed today's score — they grade
// history: a past setup is "near a low" when a swing low sits within
// ±window bars of it.
//
// Setups: each run of bars with score ≥ MIN_SCORE (gaps up to `window`
// bars) is one cluster; every distinct combination of signals that shows
// up in a cluster counts once, at its first bar — the bar you'd have seen
// it live — so today's combination compares like with like. Forward returns
// from that bar's close.

export const COMPONENTS = [
  ['zone', 'Buy zone'],
  ['bravo', 'Bravo'],
  ['echo', 'Echo'],
  ['tango', 'Tango'],
  ['macd', 'MACD'],
]
export const DEFAULT_WINDOW = 5
export const COMPARE_WINDOWS = [3, 5, 10]
export const SWING_BARS = 10
export const MIN_SCORE = 2
// Fewer matches than this for today's exact combination → fall back to
// every setup with at least today's score.
export const MIN_MATCHES = 5

// Swing lows / highs: bar i's low (high) is the lowest (highest) of the
// `n` bars on each side. Bars without n bars after them can't be confirmed.
export function swingPoints(bars, n = SWING_BARS) {
  const lows = []
  const highs = []
  for (let i = n; i < bars.length - n; i++) {
    let low = true
    let high = true
    for (let k = i - n; k <= i + n && (low || high); k++) {
      if (k === i) continue
      // Ties go to the earlier bar.
      if (bars[k].l < bars[i].l || (k < i && bars[k].l === bars[i].l)) low = false
      if (bars[k].h > bars[i].h || (k < i && bars[k].h === bars[i].h)) high = false
    }
    if (low) lows.push(i)
    if (high) highs.push(i)
  }
  return { lows, highs, confirmedTo: bars.length - 1 - n }
}

// Per bar: which signals are lit (fired within the last `window` bars) and
// the score. flags = { zone, bravo, echo, tango, macd } boolean arrays.
export function confluenceSeries(flags, n, window = DEFAULT_WINDOW) {
  const lastSeen = Object.fromEntries(COMPONENTS.map(([k]) => [k, -Infinity]))
  const out = new Array(n)
  for (let i = 0; i < n; i++) {
    const lit = []
    for (const [k] of COMPONENTS) {
      if (flags[k]?.[i]) lastSeen[k] = i
      if (i - lastSeen[k] < window) lit.push(k)
    }
    out[i] = { lit, score: lit.length, key: lit.join('+') }
  }
  return out
}

// Historical setups (see the header), graded against swing lows and
// forward returns. horizons = [[label, bars], …].
// gradeWindow: how close a swing low must be to count (defaults to window;
// the window comparison holds it fixed so a wider window can't win just by
// being wider).
export function confluenceSetups({ series, closes, swings, window = DEFAULT_WINDOW, gradeWindow = window, horizons, minScore = MIN_SCORE }) {
  const lowSet = swings.lows
  const setups = []
  let clusterEnd = -Infinity
  let seen = new Set()
  for (let i = 0; i < series.length; i++) {
    const s = series[i]
    if (s.score < minScore) continue
    if (i - clusterEnd > window) seen = new Set()
    clusterEnd = i
    if (seen.has(s.key)) continue
    seen.add(s.key)
    const graded = i + gradeWindow <= swings.confirmedTo
    setups.push({
      i, key: s.key, lit: s.lit, score: s.score, price: closes[i],
      nearLow: graded ? lowSet.some((L) => Math.abs(L - i) <= gradeWindow) : null,
      returns: horizons.map(([, h]) => (i + h < closes.length ? closes[i + h] / closes[i] - 1 : null)),
    })
  }
  return setups
}

// Count, share near a swing low, and average / win rate per horizon.
export function setupStats(list, horizons) {
  const graded = list.filter((x) => x.nearLow != null)
  return {
    n: list.length,
    nearLow: graded.length ? graded.filter((x) => x.nearLow).length / graded.length : null,
    graded: graded.length,
    horizons: horizons.map(([label], h) => {
      const done = list.map((x) => x.returns[h]).filter((r) => r != null)
      return {
        label, n: done.length,
        avg: done.length ? done.reduce((a, r) => a + r, 0) / done.length : null,
        winRate: done.length ? done.filter((r) => r > 0).length / done.length : null,
      }
    }),
  }
}

// Combinations seen in history, most frequent first (ties: higher score).
export function comboTable(setups, horizons) {
  const by = new Map()
  for (const s of setups) {
    if (!by.has(s.key)) by.set(s.key, [])
    by.get(s.key).push(s)
  }
  return [...by.entries()]
    .map(([key, list]) => ({ key, lit: list[0].lit, score: list[0].score, ...setupStats(list, horizons) }))
    .sort((a, b) => b.n - a.n || b.score - a.score)
}

// Today's setup and its record: the exact combination when history has
// MIN_MATCHES of it, else every setup with at least today's score.
export function todaySetup({ series, setups, horizons }) {
  const now = series[series.length - 1]
  // One signal on its own isn't a setup.
  if (!now || now.score < MIN_SCORE) return { now: now ?? null, basis: null, stats: null }
  const exact = setups.filter((s) => s.key === now.key)
  if (exact.length >= MIN_MATCHES) return { now, basis: 'exact', stats: setupStats(exact, horizons) }
  const atLeast = setups.filter((s) => s.score >= now.score)
  return { now, basis: atLeast.length ? 'score' : null, stats: atLeast.length ? setupStats(atLeast, horizons) : null, exactN: exact.length }
}

// Which agreement window lines up best with real lows: per window, setups
// scoring ≥ minScore, the share within ±gradeWindow bars of a swing low
// (the same yardstick for every window), and the 12-month average.
export function compareWindows({ flags, closes, bars, horizons, windows = COMPARE_WINDOWS, minScore = 3, gradeWindow = DEFAULT_WINDOW }) {
  const swings = swingPoints(bars)
  return windows.map((w) => {
    const series = confluenceSeries(flags, closes.length, w)
    const setups = confluenceSetups({ series, closes, swings, window: w, gradeWindow, horizons, minScore })
    return { window: w, ...setupStats(setups, horizons) }
  })
}

// The whole daily model for the entry page.
export function confluenceModel({ bars, model, suite, horizons, window = DEFAULT_WINDOW }) {
  const n = bars.length
  const macd = new Array(n).fill(false)
  for (const i of model.macdUp) macd[i] = true
  const flags = {
    zone: model.cond.map((c) => !!c?.all),
    bravo: suite.bravo.bullOn,
    echo: suite.echo.bull,
    tango: suite.tango.bull,
    macd,
  }
  const closes = bars.map((b) => b.c)
  const swings = swingPoints(bars)
  const series = confluenceSeries(flags, n, window)
  const setups = confluenceSetups({ series, closes, swings, window, horizons })
  return {
    window, flags, swings, series, setups,
    today: todaySetup({ series, setups, horizons }),
    combos: comboTable(setups, horizons),
    windows: compareWindows({ flags, closes, bars, horizons }),
  }
}
