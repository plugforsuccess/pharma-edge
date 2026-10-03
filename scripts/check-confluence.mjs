// Checks for src/utils/confluence.js (npm run confluence:check).
import {
  swingPoints, confluenceSeries, confluenceSetups, setupStats, comboTable, todaySetup, compareWindows, MIN_MATCHES,
} from '../src/utils/confluence.js'

let passed = 0
const failures = []
function eq(name, got, want, tol = 0) {
  const ok = typeof want === 'number' && typeof got === 'number' ? Math.abs(got - want) <= tol : JSON.stringify(got) === JSON.stringify(want)
  if (ok) passed++
  else failures.push(`${name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
}
const bar = (l, h = l + 2, c = l + 1) => ({ l, h, c, o: c, t: '2026-01-01' })

// Swings: a V — the low at index 12, highs at the ends can't confirm.
const v = Array.from({ length: 25 }, (_, i) => bar(100 + Math.abs(i - 12)))
const sw = swingPoints(v, 10)
eq('swing low at the bottom of the V', sw.lows, [12])
eq('no swing high inside a V', sw.highs, [])
eq('last confirmable bar', sw.confirmedTo, 14)
// Ties go to the earlier bar.
const flat = Array.from({ length: 23 }, (_, i) => bar(i === 11 || i === 12 ? 90 : 100))
eq('tie → earlier bar', swingPoints(flat, 10).lows, [11])

// Series: look-back only.
const n = 30
const f = (idx) => Array.from({ length: n }, (_, i) => idx.includes(i))
const flags = { zone: f([]), bravo: f([10]), echo: f([12]), tango: f([20]), macd: f([13]) }
const s = confluenceSeries(flags, n, 5)
eq('nothing before the first signal', s[9].score, 0)
eq('bravo lit on its bar', s[10].lit, ['bravo'])
eq('bravo + echo + macd agree on bar 13', s[13].lit, ['bravo', 'echo', 'macd'])
eq('bravo drops off after 5 bars', s[15].lit, ['echo', 'macd'])
eq('never looks ahead', s[19].lit, [])
eq('window 3 is tighter', confluenceSeries(flags, n, 3)[13].lit, ['echo', 'macd'])

// Setups: one per distinct combination per cluster, at its first bar.
const closes = Array.from({ length: n }, (_, i) => 100 + i)
const swings = { lows: [11], highs: [], confirmedTo: n - 1 - 10 }
const H = [['5', 5], ['10', 10]]
const setups = confluenceSetups({ series: s, closes, swings, window: 5, horizons: H })
eq('setups by first appearance', setups.map((x) => [x.i, x.key]), [[12, 'bravo+echo'], [13, 'bravo+echo+macd'], [15, 'echo+macd']])
eq('near the swing low (the last too close to the end to grade)', setups.map((x) => x.nearLow), [true, true, null])
eq('forward returns', setups[0].returns.map((r) => +r.toFixed(4)), [+(117 / 112 - 1).toFixed(4), +(122 / 112 - 1).toFixed(4)])
eq('returns past the end are null', confluenceSetups({ series: s, closes, swings, window: 5, horizons: [['30', 30]] })[0].returns, [null])
eq('ungraded when the low isn\'t confirmable yet', confluenceSetups({ series: s, closes, swings: { ...swings, confirmedTo: 14 }, window: 5, horizons: H })[0].nearLow, null)

const st = setupStats(setups, H)
eq('stats count', st.n, 3)
eq('stats near-low share (graded only)', [st.nearLow, st.graded], [1, 2])
eq('stats win rate', st.horizons[0].winRate, 1)
eq('combo table, most frequent first', comboTable([...setups, { ...setups[0] }], H)[0].key, 'bravo+echo')

// Today: exact when there are enough matches, else at-least-this-score.
const hist = Array.from({ length: MIN_MATCHES }, (_, k) => ({ i: k, key: 'bravo+echo', lit: ['bravo', 'echo'], score: 2, nearLow: true, returns: [0.1, 0.2] }))
const live = [{ lit: ['bravo', 'echo'], score: 2, key: 'bravo+echo' }]
eq('exact match', todaySetup({ series: live, setups: hist, horizons: H }).basis, 'exact')
const few = todaySetup({ series: live, setups: hist.slice(0, 2).concat([{ ...hist[0], key: 'echo+macd' }]), horizons: H })
eq('falls back to score', [few.basis, few.stats.n, few.exactN], ['score', 3, 2])
eq('one signal is not a setup', todaySetup({ series: [{ lit: ['bravo'], score: 1, key: 'bravo' }], setups: hist, horizons: H }).basis, null)
eq('nothing lit → no record', todaySetup({ series: [{ lit: [], score: 0, key: '' }], setups: hist, horizons: H }).basis, null)

// Window comparison runs for each window.
const wc = compareWindows({ flags, closes, bars: v.concat(v.slice(0, 5)), horizons: H, windows: [3, 5, 10], minScore: 2 })
eq('one row per window', wc.map((r) => r.window), [3, 5, 10])
eq('wider window, more agreement', wc[2].n >= wc[0].n, true)
// Every window is graded on the same ±5 bars.
const g10 = confluenceSetups({ series: confluenceSeries(flags, n, 10), closes, swings: { lows: [24], highs: [], confirmedTo: 29 }, window: 10, gradeWindow: 5, horizons: H, minScore: 2 })
eq('grading window held fixed', g10.every((x) => x.nearLow === (Math.abs(24 - x.i) <= 5)), true)

console.log(`confluence checks: ${passed} passed, ${failures.length} failed`)
if (failures.length) {
  for (const x of failures) console.error('  ✗ ' + x)
  process.exit(1)
}
