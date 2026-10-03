// Checks for src/utils/chartTools.js (Measure, Fibonacci, Auto swing).
// Run: npm run charttools:check
import {
  barMs, nearestBarIndex, snapPin, placePins, measure, fibLevels, autoSwing, stepPin,
} from '../src/utils/chartTools.js'

let passed = 0
const failures = []
function eq(name, got, want, tol) {
  const ok = tol != null ? Math.abs(got - want) <= tol : JSON.stringify(got) === JSON.stringify(want)
  if (ok) passed++
  else failures.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

// Daily bars: a dip to 100 on day 3, a run to 160 on day 8, a pullback to 130.
const day = (d) => `2026-04-${String(d).padStart(2, '0')}`
const closes = [120, 115, 110, 100, 108, 125, 140, 150, 160, 150, 140, 130]
const bars = closes.map((c, i) => ({ t: day(i + 1), o: c, h: c + 2, l: c - 2, c }))

eq('date bar ms', barMs('2026-04-01'), Date.UTC(2026, 3, 1))
eq('intraday bar ms', barMs(1790000000), 1790000000000)
eq('nearest bar exact', nearestBarIndex(bars, '2026-04-05'), 4)
eq('nearest bar from intraday time', nearestBarIndex(bars, Date.UTC(2026, 3, 5, 14) / 1000), 4)
const intraday = [9.5, 12, 15.5].map((h) => ({ t: Date.UTC(2026, 3, 5, Math.floor(h), (h % 1) * 60) / 1000, o: 1, h: 1, l: 1, c: 1 }))
eq('daily pin on intraday bars → first candle of that day', nearestBarIndex(intraday, '2026-04-05'), 0)
eq('off-range pin', nearestBarIndex(bars, '2027-01-01'), -1)

eq('snap to high', snapPin(bars[8], 161), { t: day(9), p: 162 })
eq('snap to low', snapPin(bars[3], 99), { t: day(4), p: 98 })

// Pins given out of order come back in time order.
const placed = placePins(bars, [{ t: day(9), p: 162 }, { t: day(4), p: 98 }])
eq('placed in time order', placed.map((x) => x.i), [3, 8])
const m = measure(placed)
eq('measure $', m.change, 64)
eq('measure %', m.pct, 64 / 98, 1e-12)
eq('measure candles', m.candles, 5)
eq('measure days', m.days, 5)
eq('no pins, no measure', measure(placePins(bars, [{ t: day(1), p: 1 }])), null)

// Up swing 98 → 162 (diff 64).
const up = fibLevels(placed)
const at = (ratio, kind) => up.find((l) => l.ratio === ratio && l.kind === kind).price
eq('0% = swing high', at(0, 'retracement'), 162)
eq('100% = swing low', at(1, 'retracement'), 98)
eq('61.8% retracement', at(0.618, 'retracement'), 162 - 0.618 * 64, 1e-9)
eq('50% retracement', at(0.5, 'retracement'), 130)
eq('127.2% extension above the high', at(1.272, 'extension'), 98 + 1.272 * 64, 1e-9)
eq('161.8% extension', at(1.618, 'extension'), 98 + 1.618 * 64, 1e-9)
eq('label', up.find((l) => l.ratio === 0.618).label, '61.8%')

// Down swing 162 → 130: retracements bounce up from 130, extensions run below.
const down = fibLevels(placePins(bars, [{ t: day(9), p: 162 }, { t: day(12), p: 130 }]))
eq('down: 61.8% retracement above the low', down.find((l) => l.ratio === 0.618 && l.kind === 'retracement').price, 130 + 0.618 * 32, 1e-9)
eq('down: 161.8% extension below the low', down.find((l) => l.ratio === 1.618).price, 162 - 1.618 * 32, 1e-9)
eq('down: flagged', down[0].up, false)
// Extensions that would go below zero are dropped.
const crash = fibLevels([{ i: 0, t: day(1), p: 100 }, { i: 1, t: day(2), p: 10 }])
eq('no negative prices', crash.every((l) => l.price > 0), true)

// Auto: the biggest swing is the 98 low (day 4) → 162 high (day 9), +65%.
const auto = autoSwing(bars)
eq('auto from the low', auto[0], { t: day(4), p: 98 })
eq('auto to the high', auto[1], { t: day(9), p: 162 })
// A steady fall picks the high → the later low.
const falling = [50, 48, 45, 40, 35, 30].map((c, i) => ({ t: day(i + 1), o: c, h: c + 1, l: c - 1, c }))
eq('auto on a fall', autoSwing(falling), [{ t: day(1), p: 51 }, { t: day(6), p: 29 }])
eq('auto needs 3 bars', autoSwing(bars.slice(0, 2)), null)

// Step a pin one candle, keeping its side; no crossing, no running off the ends.
const pair = placePins(bars, [{ t: day(4), p: 98 }, { t: day(9), p: 162 }])
eq('step A later keeps the low', stepPin(bars, pair, 0, 1)[0], { t: day(5), p: bars[4].l })
eq('step B earlier keeps the high', stepPin(bars, pair, 1, -1)[1], { t: day(8), p: bars[7].h })
eq('step leaves the other pin', stepPin(bars, pair, 0, 1)[1], { t: day(9), p: 162 })
eq('A cannot reach B', stepPin(bars, [{ i: 3, t: day(4), p: 98 }, { i: 4, t: day(5), p: 1 }], 0, 1), null)
eq('B cannot pass A', stepPin(bars, [{ i: 3, t: day(4), p: 98 }, { i: 4, t: day(5), p: 1 }], 1, -1), null)
eq('no step before the first bar', stepPin(bars, [{ i: 0, t: day(1), p: 1 }, { i: 4, t: day(5), p: 1 }], 0, -1), null)
eq('no step past the last bar', stepPin(bars, [{ i: 0, t: day(1), p: 1 }, { i: bars.length - 1, t: bars[bars.length - 1].t, p: 1 }], 1, 1), null)

console.log(`chart-tools checks: ${passed} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
