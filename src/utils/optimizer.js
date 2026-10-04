// Rule optimizer (owner, 2026-10-04: "do everything mathematically possible
// to get the guarantee closest to 1.0"). Searches the entry and exit rules
// of the LEAPS replay across the whole universe and judges every candidate
// out of sample — walk-forward — so the winner is the rule most likely to
// hold up next, not the one that fits the past best. Pure functions;
// `npm run optimizer:check` runs scripts/check-optimizer.mjs. The universe
// job (scripts/optimize-entries.mjs) runs them in Node.
//
// What is searched
//   entry  minScore  2 | 3        buy signals that must agree
//          window    3 | 5 | 10   trading days they may be spread over
//          trend     rising | any | above50 | rising50
//                    (200-day rising / no trend rule / close above the
//                    50-day / both)
//          require   null | zone | bravo | echo | tango | macd
//                    (one named signal must be among them)
//   exit   t1 0.75 | 1 | 1.5 | 2   first target (× cost gain), sells 70%
//          t2 2 | 3 | 4             second target, sells 15%
//          trail 0.2 | 0.3 | 0.4    runner give-back
//          mode targets | both      sell signals guard the rest after t1
//          delta 0.6 | 0.75 | 0.9   the call bought
//          dte 540 | 730            days to expiry at entry
// The grid is 144 entries × 432 exits. Searched in stages (coordinate
// descent): every entry with the default exit → the best entries → every
// exit for each of those → the entries again with the best exit.
//
// Score = mean option return (open trades marked at the last bar)
//         − 0.5 × share of trades that lost half or more,
//         × n / (n + 30)   (small samples shrink toward zero)
// Walk-forward folds split trades by SIGNAL date: the rule is chosen on
// train trades only and reported on the test trades it never saw.
//   fold A  train < 2024-01-01   test 2024
//   fold B  train < 2025-01-01   test 2025 →
// The "validated" numbers are the test results of the train-chosen rules.
// The final rule is chosen on everything, but its expected performance is
// the validated one — never its own in-sample score.

import { COMPONENTS, confluenceFlags, confluenceSeries } from './confluence.js'
import { replayTrades, trailingVol, bigMoves, OPTION_MODEL } from './replay.js'
import { EXIT_PLAYBOOK } from './afterTax.js'

export const ENTRY_GRID = {
  minScore: [2, 3],
  window: [3, 5, 10],
  trend: ['rising', 'any', 'above50', 'rising50'],
  require: [null, 'zone', 'bravo', 'echo', 'tango', 'macd'],
}
export const EXIT_GRID = {
  t1: [0.75, 1, 1.5, 2],
  t2: [2, 3, 4],
  trail: [0.2, 0.3, 0.4],
  mode: ['targets', 'both'],
  delta: [0.6, 0.75, 0.9],
  dte: [540, 730],
}
export const DEFAULT_ENTRY = Object.freeze({ minScore: 2, window: 5, trend: 'rising', require: null })
export const DEFAULT_EXIT = Object.freeze({ t1: EXIT_PLAYBOOK.targets[0], t2: EXIT_PLAYBOOK.targets[1], trail: EXIT_PLAYBOOK.runnerTrailPct, mode: 'targets', delta: OPTION_MODEL.delta, dte: OPTION_MODEL.dte })
export const FOLDS = [
  { name: 'A', trainEnd: '2024-01-01', testEnd: '2025-01-01' },
  { name: 'B', trainEnd: '2025-01-01', testEnd: '9999-12-31' },
]
export const SHRINK_N = 30
export const BIG_LOSS_PENALTY = 0.5
export const MIN_TRAIN = 30
export const TOP_ENTRIES = 5

const product = (grid) => Object.entries(grid).reduce((acc, [k, vals]) => acc.flatMap((o) => vals.map((v) => ({ ...o, [k]: v }))), [{}])
export const entryCandidates = () => product(ENTRY_GRID)
export const exitCandidates = () => product(EXIT_GRID)
export const entryKey = (e) => `s${e.minScore}w${e.window}:${e.trend}:${e.require ?? 'any'}`
export const exitKey = (x) => `t${x.t1}/${x.t2}:tr${x.trail}:${x.mode}:d${x.delta}:${x.dte}`

// Everything a ticker needs for every candidate, computed once.
export function prepareTicker(bars, model, suite) {
  const n = bars.length
  const flags = confluenceFlags(model, suite)
  const keys = COMPONENTS.buy.map(([k]) => k)
  const sellKeys = COMPONENTS.sell.map(([k]) => k)
  const series = Object.fromEntries(ENTRY_GRID.window.map((w) => [w, confluenceSeries(flags.buy, n, w, keys)]))
  const sell = confluenceSeries(flags.sell, n, 5, sellKeys).map((s) => s.score >= 2)
  return {
    bars, n,
    rising: model.slope200.map((s) => s != null && s > 0),
    above50: model.closes.map((c, i) => model.s50[i] != null && c > model.s50[i]),
    series, sell,
    vol: trailingVol(model.closes, OPTION_MODEL.volBars),
    moves: bigMoves(bars),
  }
}

// Entry days for one entry candidate: the score reaching minScore (from
// below), the trend rule, and the required signal among the lit ones.
export function entryDays(prep, e) {
  const s = prep.series[e.window]
  const out = new Array(prep.n)
  for (let i = 0; i < prep.n; i++) {
    const on = s[i].score >= e.minScore && (i === 0 || s[i - 1].score < e.minScore)
    if (!on) { out[i] = false; continue }
    const trend = e.trend === 'any' ? true
      : e.trend === 'rising' ? prep.rising[i]
      : e.trend === 'above50' ? prep.above50[i]
      : prep.rising[i] && prep.above50[i]
    out[i] = trend && (e.require == null || s[i].lit.includes(e.require))
  }
  return out
}

// Trades for one (entry, exit) candidate on one ticker — the replay engine
// with the candidate's playbook and option.
export function candidateTrades(prep, e, x) {
  const sig = { entry: { c: entryDays(prep, e) }, sell: prep.sell, buyKey: prep.series[e.window].map((s) => s.key) }
  const plan = { ...EXIT_PLAYBOOK, targets: [x.t1, x.t2], fractions: [0.7, 0.15], runnerTrailPct: x.trail }
  const opt = { ...OPTION_MODEL, delta: x.delta, dte: x.dte }
  return replayTrades(prep.bars, sig, { entryRule: 'c', exitRule: x.mode, plan, opt, vol: prep.vol })
}

// Big moves caught by a set of trades (a signal from 10 bars before the
// low to half-way through the move); moves inside an open trade don't
// count either way.
export function catchRate(moves, trades, early = 10) {
  let caught = 0
  let open = 0
  for (const m of moves) {
    if (trades.some((t) => t.i <= m.lowI && t.endI >= m.halfI)) continue
    open++
    if (trades.some((t) => t.signalI >= m.lowI - early && t.signalI <= m.halfI)) caught++
  }
  return { caught, moves: open }
}

// Compact record of one trade, enough to score any fold.
export const compact = (t, ticker) => ({ ticker, signal: t.signalT, r: t.optionReturn, open: t.open, days: t.days })

// Stats over compact trades (open trades count, marked at the last bar).
export function scoreTrades(list) {
  const n = list.length
  if (!n) return { n: 0, open: 0, win: null, avg: null, median: null, p10: null, bigLoss: null, avgDays: null, score: 0 }
  const r = list.map((t) => t.r).sort((a, b) => a - b)
  const avg = r.reduce((s, x) => s + x, 0) / n
  const bigLoss = r.filter((x) => x <= -0.5).length / n
  return {
    n, open: list.filter((t) => t.open).length,
    win: r.filter((x) => x > 0).length / n,
    avg, median: r[Math.floor((n - 1) / 2)], p10: r[Math.floor((n - 1) * 0.1)],
    bigLoss, avgDays: list.reduce((s, t) => s + t.days, 0) / n,
    score: (avg - BIG_LOSS_PENALTY * bigLoss) * (n / (n + SHRINK_N)),
  }
}

export const inTrain = (t, fold) => t.signal < fold.trainEnd
export const inTest = (t, fold) => t.signal >= fold.trainEnd && t.signal < fold.testEnd

// Best candidate by train score (needs MIN_TRAIN train trades).
export function pickBest(results, fold) {
  let best = null
  for (const r of results) {
    const st = scoreTrades(fold ? r.trades.filter((t) => inTrain(t, fold)) : r.trades)
    if (st.n < MIN_TRAIN) continue
    if (!best || st.score > best.score) best = { ...r, score: st.score, stats: st }
  }
  return best
}

// Pareto frontier on (catch rate ↑, average return ↑): the candidates no
// other candidate beats on both. Sorted by catch rate.
export function paretoFront(points) {
  const pts = points.filter((p) => p.catch != null && p.avg != null)
  return pts.filter((p) => !pts.some((q) => q !== p && q.catch >= p.catch && q.avg >= p.avg && (q.catch > p.catch || q.avg > p.avg)))
    .sort((a, b) => a.catch - b.catch)
}

// The rule in plain words.
export function describeEntry(e) {
  const trend = { rising: '200-day rising', any: 'any trend', above50: 'close above the 50-day', rising50: '200-day rising and close above the 50-day' }[e.trend]
  const need = e.require ? `, ${Object.fromEntries(COMPONENTS.buy)[e.require]} among them` : ''
  return `${e.minScore}+ buy signals within ${e.window} days${need}, ${trend}`
}
export function describeExit(x) {
  const d = Math.round(x.dte / 30)
  return `${Math.round(x.delta * 100)}-delta call, ~${d} months out · sell 70% at ${1 + x.t1}x, 15% at ${1 + x.t2}x, trail the rest ${Math.round(x.trail * 100)}%${x.mode === 'both' ? ', 2+ sell signals close it after the first target' : ''}`
}
