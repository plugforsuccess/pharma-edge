// Confluence on the LEAPS entry chart and in the nightly ranking (owner,
// 2026-10-03: "the app must be able to identify lows (buy entries) and
// extended highs (exits); the historical data and indicators must work
// together"). Pure functions; `npm run confluence:check` runs
// scripts/check-confluence.mjs. The ranking job (scripts/rank-confluence.mjs)
// runs the same functions in Node.
//
// Two sides, each a score of five signals that fired within the last
// `window` bars (live, look-back only, today included):
//   buy  — lows:  zone  the buy zone (all 5 conditions)
//                 bravo a Bravo bull diamond   echo  an Echo bull cross
//                 tango a Tango bull cross     macd  a MACD cross up
//   sell — highs: ext   extended: RSI ≥ 70, or the % above the 200-day in
//                       the top 10% of its last year
//                 bravo a Bravo bear diamond   echo  an Echo bear cross
//                 tango a Tango bear cross     macd  a MACD cross down
// The buy score sits beside the buy-zone YES / NO (which stays the rule).
//
// Swing lows / highs (lowest low / highest high `swing` bars either side)
// are hindsight: they never feed a score — they grade history. A past buy
// setup is "at a low" when a swing low sits within ±window bars; a sell
// setup "at a high" likewise with a swing high.
//
// Setups: each run of bars with score ≥ MIN_SCORE (gaps up to `window`
// bars) is one cluster; every distinct combination of signals in a cluster
// counts once, at its first bar — the bar you'd have seen it live — so
// today's combination compares like with like. Forward returns from that
// bar's close; a sell "wins" when the stock fell after.

export const SIDES = ['buy', 'sell']
export const COMPONENTS = {
  buy: [['zone', 'Buy zone'], ['bravo', 'Bravo'], ['echo', 'Echo'], ['tango', 'Tango'], ['macd', 'MACD']],
  sell: [['ext', 'Extended'], ['bravo', 'Bravo'], ['echo', 'Echo'], ['tango', 'Tango'], ['macd', 'MACD']],
}
export const DEFAULT_WINDOW = 5
export const COMPARE_WINDOWS = [3, 5, 10]
export const SWING_BARS = 10
export const MIN_SCORE = 2
// Fewer matches than this for today's exact combination → fall back.
export const MIN_MATCHES = 5
export const EXT_RSI = 70
export const EXT_PCTL = 0.9

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

// Extended: RSI at or above EXT_RSI, or today's % above the 200-day in the
// top (1 − EXT_PCTL) of its trailing year (once 120 values exist).
export function extendedFlags(rsi, dist, lookback = 252) {
  return dist.map((d, i) => {
    if (rsi[i] != null && rsi[i] >= EXT_RSI) return true
    if (d == null) return false
    const w = dist.slice(Math.max(0, i - lookback + 1), i + 1).filter((x) => x != null)
    if (w.length < 120) return false
    w.sort((a, b) => a - b)
    return d >= w[Math.floor(EXT_PCTL * (w.length - 1))] && d > 0
  })
}

// Per bar: which signals are lit (fired within the last `window` bars) and
// the score. flags = { key: boolean[] }, keys = the side's component keys.
export function confluenceSeries(flags, n, window = DEFAULT_WINDOW, keys = COMPONENTS.buy.map(([k]) => k)) {
  const lastSeen = Object.fromEntries(keys.map((k) => [k, -Infinity]))
  const out = new Array(n)
  for (let i = 0; i < n; i++) {
    const lit = []
    for (const k of keys) {
      if (flags[k]?.[i]) lastSeen[k] = i
      if (i - lastSeen[k] < window) lit.push(k)
    }
    out[i] = { lit, score: lit.length, key: lit.join('+') }
  }
  return out
}

// Historical setups (see the header), graded against swing lows (buy) or
// highs (sell) and forward returns. horizons = [[label, bars], …].
// gradeWindow: how close the turn must be to count (defaults to window;
// the window comparison holds it fixed so a wider window can't win just by
// being wider).
export function confluenceSetups({ series, closes, swings, window = DEFAULT_WINDOW, gradeWindow = window, horizons, minScore = MIN_SCORE, side = 'buy' }) {
  const turns = side === 'sell' ? swings.highs : swings.lows
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
      atTurn: graded ? turns.some((L) => Math.abs(L - i) <= gradeWindow) : null,
      returns: horizons.map(([, h]) => (i + h < closes.length ? closes[i + h] / closes[i] - 1 : null)),
    })
  }
  return setups
}

// Count, share at a turn (low / high), and average / win rate per horizon
// (a sell wins when the stock fell).
export function setupStats(list, horizons, side = 'buy') {
  const graded = list.filter((x) => x.atTurn != null)
  const win = side === 'sell' ? (r) => r < 0 : (r) => r > 0
  return {
    n: list.length,
    atTurn: graded.length ? graded.filter((x) => x.atTurn).length / graded.length : null,
    graded: graded.length,
    horizons: horizons.map(([label], h) => {
      const done = list.map((x) => x.returns[h]).filter((r) => r != null)
      return {
        label, n: done.length,
        avg: done.length ? done.reduce((a, r) => a + r, 0) / done.length : null,
        winRate: done.length ? done.filter(win).length / done.length : null,
      }
    }),
  }
}

// Combinations seen in history, most frequent first (ties: higher score).
export function comboTable(setups, horizons, side = 'buy') {
  const by = new Map()
  for (const s of setups) {
    if (!by.has(s.key)) by.set(s.key, [])
    by.get(s.key).push(s)
  }
  return [...by.entries()]
    .map(([key, list]) => ({ key, lit: list[0].lit, score: list[0].score, ...setupStats(list, horizons, side) }))
    .sort((a, b) => b.n - a.n || b.score - a.score)
}

// Today's setup and its record: the exact combination when history has
// MIN_MATCHES of it, else every setup with at least today's score.
export function todaySetup({ series, setups, horizons, side = 'buy' }) {
  const now = series[series.length - 1]
  // One signal on its own isn't a setup.
  if (!now || now.score < MIN_SCORE) return { now: now ?? null, basis: null, stats: null }
  const exact = setups.filter((s) => s.key === now.key)
  if (exact.length >= MIN_MATCHES) return { now, basis: 'exact', stats: setupStats(exact, horizons, side), exactN: exact.length }
  const atLeast = setups.filter((s) => s.score >= now.score)
  return { now, basis: atLeast.length ? 'score' : null, stats: atLeast.length ? setupStats(atLeast, horizons, side) : null, exactN: exact.length }
}

// Which agreement window lines up best with real turns: per window, setups
// scoring ≥ minScore, the share within ±gradeWindow bars of a swing low /
// high (the same yardstick for every window), and the averages.
export function compareWindows({ flags, closes, swings, horizons, windows = COMPARE_WINDOWS, minScore = 3, gradeWindow = DEFAULT_WINDOW, side = 'buy' }) {
  const keys = COMPONENTS[side].map(([k]) => k)
  return windows.map((w) => {
    const series = confluenceSeries(flags, closes.length, w, keys)
    const setups = confluenceSetups({ series, closes, swings, window: w, gradeWindow, horizons, minScore, side })
    return { window: w, ...setupStats(setups, horizons, side) }
  })
}

// Signal flags for both sides from the entry model and the daily suite.
export function confluenceFlags(model, suite) {
  const n = model.closes.length
  const up = new Array(n).fill(false)
  for (const i of model.macdUp) up[i] = true
  const m = model.macd
  const down = m.line.map((v, i) => i > 0 && v != null && m.signal[i] != null && m.line[i - 1] != null && m.signal[i - 1] != null
    && m.line[i - 1] >= m.signal[i - 1] && v < m.signal[i])
  return {
    buy: { zone: model.cond.map((c) => !!c?.all), bravo: suite.bravo.bullOn, echo: suite.echo.bull, tango: suite.tango.bull, macd: up },
    sell: { ext: extendedFlags(model.rsi, model.dist), bravo: suite.bravo.bearOn, echo: suite.echo.bear, tango: suite.tango.bear, macd: down },
  }
}

// One side's model.
function sideModel({ side, flags, closes, swings, horizons, window }) {
  const keys = COMPONENTS[side].map(([k]) => k)
  const series = confluenceSeries(flags, closes.length, window, keys)
  const setups = confluenceSetups({ series, closes, swings, window, horizons, side })
  return {
    side, flags, series, setups,
    today: todaySetup({ series, setups, horizons, side }),
    combos: comboTable(setups, horizons, side),
    windows: compareWindows({ flags, closes, swings, horizons, side }),
  }
}

// The whole daily model: { window, swings, buy, sell }.
export function confluenceModel({ bars, model, suite, horizons, window = DEFAULT_WINDOW }) {
  const closes = bars.map((b) => b.c)
  const swings = swingPoints(bars)
  const flags = confluenceFlags(model, suite)
  return {
    window, swings,
    buy: sideModel({ side: 'buy', flags: flags.buy, closes, swings, horizons, window }),
    sell: sideModel({ side: 'sell', flags: flags.sell, closes, swings, horizons, window }),
  }
}

// ── Pooled history + blended estimates (the ranking) ───────────────
//
// One ticker's history often holds < 10 cases of a combination, so the
// estimate for today's setup blends the ticker's own record with the same
// combination across the whole universe, leaning on its own only as its
// count grows: blended = (n_own · own + K · pooled) / (n_own + K).

export const SHRINK_K = 10

// Pool setups from many tickers: { [key]: { n, atTurn, horizons } } per side.
export function poolStats(setupLists, horizons, side = 'buy') {
  const by = new Map()
  for (const list of setupLists) for (const s of list) {
    if (!by.has(s.key)) by.set(s.key, [])
    by.get(s.key).push(s)
  }
  const out = {}
  for (const [key, list] of by) out[key] = { key, lit: list[0].lit, score: list[0].score, ...setupStats(list, horizons, side) }
  return out
}

export function blend(own, ownN, pooled, k = SHRINK_K) {
  if (pooled == null && own == null) return null
  if (own == null || !ownN) return pooled
  if (pooled == null) return own
  return (ownN * own + k * pooled) / (ownN + k)
}

// Today's estimate for one ticker and side: blended at-turn rate and
// average returns per horizon, from its exact combination (own) and the
// pool's record of that combination.
export function blendedEstimate({ today, setups, pool, horizons, side = 'buy' }) {
  const now = today?.now
  if (!now || now.score < MIN_SCORE) return null
  const own = setupStats(setups.filter((s) => s.key === now.key), horizons, side)
  const p = pool?.[now.key] ?? null
  return {
    key: now.key, lit: now.lit, score: now.score,
    ownN: own.n, poolN: p?.n ?? 0,
    atTurn: blend(own.atTurn, own.graded, p?.atTurn ?? null),
    horizons: horizons.map(([label], h) => ({
      label,
      avg: blend(own.horizons[h].avg, own.horizons[h].n, p?.horizons[h]?.avg ?? null),
      winRate: blend(own.horizons[h].winRate, own.horizons[h].n, p?.horizons[h]?.winRate ?? null),
    })),
  }
}
