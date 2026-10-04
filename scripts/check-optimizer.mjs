// Checks for src/utils/optimizer.js (npm run optimizer:check).
import {
  ENTRY_GRID, EXIT_GRID, entryCandidates, exitCandidates, entryKey, exitKey, prepareTicker, entryDays, candidateTrades,
  catchRate, compact, scoreTrades, pickBest, paretoFront, inTrain, inTest, FOLDS, DEFAULT_ENTRY, DEFAULT_EXIT, SHRINK_N, describeEntry, describeExit,
} from '../src/utils/optimizer.js'
import { entryModel } from '../src/utils/indicators.js'
import { suiteModel } from '../src/utils/signalSuite.js'
import { replaySignals, replayTrades, trailingVol } from '../src/utils/replay.js'

let passed = 0
const failures = []
function eq(name, got, want, tol = 0) {
  const ok = typeof want === 'number' && typeof got === 'number' ? Math.abs(got - want) <= tol : JSON.stringify(got) === JSON.stringify(want)
  if (ok) passed++
  else failures.push(`${name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
}

eq('entry grid size', entryCandidates().length, 2 * 3 * 4 * 6)
eq('exit grid size', exitCandidates().length, 4 * 3 * 3 * 2 * 3 * 2)
eq('entry keys unique', new Set(entryCandidates().map(entryKey)).size, entryCandidates().length)
eq('exit keys unique', new Set(exitCandidates().map(exitKey)).size, exitCandidates().length)
eq('default entry is in the grid', entryCandidates().some((e) => entryKey(e) === entryKey(DEFAULT_ENTRY)), true)
eq('default exit is in the grid', exitCandidates().some((x) => exitKey(x) === exitKey(DEFAULT_EXIT)), true)
eq('grids cover the keys', Object.keys(ENTRY_GRID).length + Object.keys(EXIT_GRID).length, 10)

// Scoring: shrinkage and the big-loss penalty.
{
  const mk = (rs) => rs.map((r, i) => ({ ticker: 'X', signal: `2023-01-${String(i + 1).padStart(2, '0')}`, r, open: false, days: 100 }))
  const s = scoreTrades(mk([0.5, 0.5, -0.6, 0.2]))
  eq('avg', s.avg, 0.15, 1e-9)
  eq('big loss share', s.bigLoss, 0.25, 1e-9)
  eq('score = (avg − 0.5·bigLoss) · n/(n+30)', s.score, (0.15 - 0.125) * (4 / 34), 1e-9)
  eq('empty score is 0', scoreTrades([]).score, 0)
  const many = scoreTrades(mk(Array.from({ length: 300 }, () => 0.3)))
  eq('large n keeps most of the score', many.score, 0.3 * (300 / 330), 1e-9)
  eq('median', scoreTrades(mk([0.1, 0.9, 0.5])).median, 0.5)
}

// Folds split by signal date.
{
  const t = { signal: '2024-06-01' }
  eq('fold A: 2024 is test', inTest(t, FOLDS[0]) && !inTrain(t, FOLDS[0]), true)
  eq('fold B: 2024 is train', inTrain(t, FOLDS[1]) && !inTest(t, FOLDS[1]), true)
  eq('fold B: 2025 is test', inTest({ signal: '2025-03-01' }, FOLDS[1]), true)
}

// pickBest needs MIN_TRAIN trades and takes the top train score.
{
  const mk = (n, r) => Array.from({ length: n }, (_, i) => ({ signal: '2023-01-01', r, open: false, days: 1 }))
  const res = [{ key: 'small', trades: mk(10, 5) }, { key: 'good', trades: mk(40, 0.4) }, { key: 'bad', trades: mk(40, -0.2) }]
  eq('best by train score, small samples skipped', pickBest(res, FOLDS[0]).key, 'good')
  eq('no eligible → null', pickBest([res[0]], FOLDS[0]), null)
}

// Pareto frontier.
{
  const pts = [{ k: 'a', catch: 0.1, avg: 0.5 }, { k: 'b', catch: 0.3, avg: 0.3 }, { k: 'c', catch: 0.2, avg: 0.2 }, { k: 'd', catch: 0.3, avg: 0.1 }]
  eq('frontier', paretoFront(pts).map((p) => p.k), ['a', 'b'])
}

// The default candidate reproduces the replay's confluence:targets run.
{
  let s = 5
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 }
  const bars = []
  let p = 100
  const d0 = Date.UTC(2020, 0, 2)
  let day = 0
  for (let i = 0; i < 1000; i++) {
    const o = p
    p = Math.max(5, p * (1 + Math.sin(i / 90) * 0.003 + (rnd() - 0.5) * 0.04))
    let t
    do { t = new Date(d0 + day * 86400000); day++ } while (t.getUTCDay() === 0 || t.getUTCDay() === 6)
    bars.push({ t: t.toISOString().slice(0, 10), o, h: Math.max(o, p) * (1 + rnd() * 0.01), l: Math.min(o, p) * (1 - rnd() * 0.01), c: p, v: 1e6 })
  }
  const model = entryModel(bars)
  const suite = suiteModel(bars)
  const prep = prepareTicker(bars, model, suite)
  const sig = replaySignals(bars, model, suite)
  eq('default entry days = confluence entry days', entryDays(prep, DEFAULT_ENTRY), sig.entry.confluence)
  const ref = replayTrades(bars, sig, { entryRule: 'confluence', exitRule: 'targets', vol: trailingVol(bars.map((b) => b.c)) })
  const got = candidateTrades(prep, DEFAULT_ENTRY, DEFAULT_EXIT)
  eq('default candidate = confluence:targets trades', got.map((t) => [t.signalT, +t.optionReturn.toFixed(6)]), ref.map((t) => [t.signalT, +t.optionReturn.toFixed(6)]))
  // Stricter entries are a subset of looser ones.
  const loose = entryDays(prep, { minScore: 2, window: 10, trend: 'any', require: null })
  const strict = entryDays(prep, { minScore: 2, window: 10, trend: 'rising50', require: 'bravo' })
  eq('strict ⊆ loose (same score + window)', strict.every((x, i) => !x || loose[i]), true)
  // A 3-signal rule fires on different days (the score reaching 3), so it
  // is not a subset — but it never fires more often.
  const three = entryDays(prep, { minScore: 3, window: 10, trend: 'any', require: null })
  eq('3 signals fire no more often than 2', three.filter(Boolean).length <= loose.filter(Boolean).length, true)
  eq('required signal is among the lit ones', entryDays(prep, { minScore: 2, window: 5, trend: 'any', require: 'macd' }).every((x, i) => !x || prep.series[5][i].lit.includes('macd')), true)
  const cr = catchRate(prep.moves, got)
  eq('catch rate counts ≤ moves', cr.caught <= cr.moves && cr.moves <= prep.moves.length, true)
  eq('compact keeps the signal date', compact(got[0] ?? { signalT: 'x', optionReturn: 0, open: false, days: 0 }, 'T').ticker, 'T')
}

eq('entry in words', describeEntry({ minScore: 2, window: 5, trend: 'rising', require: 'bravo' }), '2+ buy signals within 5 days, Bravo among them, 200-day rising')
eq('exit in words', describeExit({ t1: 1, t2: 2, trail: 0.3, mode: 'both', delta: 0.75, dte: 730 }), '75-delta call, ~24 months out · sell 70% at 2x, 15% at 3x, trail the rest 30%, 2+ sell signals close it after the first target')
eq('shrink constant', SHRINK_N, 30)

console.log(`optimizer checks: ${passed} passed, ${failures.length} failed`)
if (failures.length) { for (const f of failures) console.log('  ✗', f); process.exit(1) }
