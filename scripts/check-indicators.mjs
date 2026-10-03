// Checks for src/utils/indicators.js (LEAPS entry chart).
// Run: npm run indicators:check
import {
  sma, ema, rsi, macd, historicalVol, rank, weeklyEmaOnDays, ivSeries, entryModel, DEFAULT_PARAMS,
} from '../src/utils/indicators.js'

let passed = 0
const failures = []
function eq(name, got, want, tol) {
  const ok = tol != null ? got != null && Math.abs(got - want) <= tol : JSON.stringify(got) === JSON.stringify(want)
  if (ok) passed++
  else failures.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

// SMA / EMA basics.
eq('sma 3', sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4])
const e = ema([1, 2, 3, 4, 5], 3)
eq('ema seed = sma', e[2], 2)
eq('ema next', e[3], 4 * 0.5 + 2 * 0.5)
eq('ema skips leading nulls', ema([null, 1, 2, 3], 3)[3], 2)

// RSI: all gains → 100; textbook Wilder example (14 periods).
eq('rsi all up', rsi(Array.from({ length: 20 }, (_, i) => i + 1), 14)[19], 100)
const wilder = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28]
eq('rsi wilder first value', rsi(wilder, 14)[14], 70.46, 0.05)

// MACD on a straight line: fast EMA leads, histogram → 0.
const line = Array.from({ length: 80 }, (_, i) => 100 + i)
const m = macd(line)
eq('macd positive on uptrend', m.line[79] > 0, true)
eq('macd hist ~0 on steady trend', m.hist[79], 0, 1e-6)

// Historical vol: constant growth → 0.
eq('hv of constant returns', historicalVol(Array.from({ length: 30 }, (_, i) => 100 * 1.01 ** i), 20)[29], 0, 1e-9)

// Rank.
eq('rank top', rank([1, 2, 3, 4, 5], 5, 3)[4], 100)
eq('rank bottom', rank([5, 4, 3, 2, 1], 5, 3)[4], 0)
eq('rank needs min', rank([1, 2], 5, 3)[1], null)

// Weekly EMA projection: constant price → the price; no look-ahead.
const days = []
let d = Date.UTC(2024, 0, 1)
while (days.length < 400) {
  const t = new Date(d).toISOString().slice(0, 10)
  const wd = new Date(d).getUTCDay()
  if (wd !== 0 && wd !== 6) days.push(t)
  d += 86400000
}
const flat = days.map((t) => ({ t, o: 50, h: 50, l: 50, c: 50, v: 1 }))
const w = weeklyEmaOnDays(flat, 50)
eq('weekly ema flat', w[399], 50, 1e-9)
eq('weekly ema null before 50 weeks', w[100], null)
const bumped = flat.map((b, i) => (i === 399 ? { ...b, c: 60 } : b))
eq('weekly ema moves with the day close', weeklyEmaOnDays(bumped, 50)[399] > 50, true)
eq('earlier days unchanged (no look-ahead)', weeklyEmaOnDays(bumped, 50)[398], 50, 1e-9)

// IV series: real points + today; HV stands in without a year of IV.
const s = ivSeries(flat.slice(0, 5), [{ t: flat[1].t, iv: 0.3 }], 0.25)
eq('iv point on its day', s.iv[1], 0.3)
eq('iv today on the last day', s.iv[4], 0.25)
eq('not enough real iv', s.useReal, false)

// Entry model on a synthetic uptrend with a pullback to the 200-day.
// 300 days rising 0.2%/day, then a dip of 9 days, then recovery.
const bars = []
let c = 100
for (let i = 0; i < 420; i++) {
  if (i >= 330 && i < 345) c *= 0.985          // pullback toward the 200
  else c *= 1.002
  bars.push({ t: days[i % days.length], o: c, h: c * 1.005, l: c * 0.995, c, v: 1e6 })
}
// Dates must be unique and increasing for the model; rebuild them.
let dd = Date.UTC(2023, 0, 2)
for (const b of bars) {
  while ([0, 6].includes(new Date(dd).getUTCDay())) dd += 86400000
  b.t = new Date(dd).toISOString().slice(0, 10)
  dd += 86400000
}
const model = entryModel(bars, { params: { ...DEFAULT_PARAMS, ivRankMax: 101 } })
eq('model has 200 sma', model.s200[419] != null, true)
eq('200 rising at the end', model.slope200[419] > 0, true)
eq('signals exist after the pullback', model.signals.length > 0, true)
eq('signals only where all conditions hold', model.signals.every((i) => model.cond[i].all), true)
eq('every signal is within the band', model.signals.every((i) => Math.abs(model.dist[i]) <= 5), true)
eq('first trade is the first signal day', model.trades[0]?.i, model.signals[0])
eq('returns align to 63 days', model.trades[0].returns[0], bars[model.trades[0].i + 63] ? bars[model.trades[0].i + 63].c / bars[model.trades[0].i].c - 1 : null)
eq('trades are cooldown apart', model.trades.every((tr, k) => k === 0 || tr.i - model.trades[k - 1].i > DEFAULT_PARAMS.cooldown), true)
eq('no signal in the cooldown before a trade', model.trades.every((tr) => !model.signals.some((x) => x < tr.i && tr.i - x <= DEFAULT_PARAMS.cooldown)), true)
eq('stats horizons', model.stats.map((x) => x.label), ['3M', '6M', '12M'])
// IV Rank gate: with a 0 cutoff nothing passes.
eq('iv gate blocks all', entryModel(bars, { params: { ivRankMax: 0 } }).signals.length, 0)
// Golden cross on a V: falling then rising.
const v = []
let cv = 100
for (let i = 0; i < 520; i++) { cv *= i < 250 ? 0.997 : 1.004; v.push({ t: bars[i % bars.length].t, o: cv, h: cv, l: cv, c: cv, v: 1 }) }
const vm = entryModel(v.map((b, i) => ({ ...b, t: `${2020 + Math.floor(i / 300)}-${String(1 + Math.floor((i % 300) / 25)).padStart(2, '0')}-${String(1 + (i % 25)).padStart(2, '0')}` })))
eq('golden cross found on a V', vm.golden.length >= 1, true)

console.log(`indicator checks: ${passed} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
