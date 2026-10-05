// Checks for src/utils/plan.js and the Triple event (npm run plan:check).
import { trendQuality, tripleStatus, reclaimPlan, TREND_GATE } from '../src/utils/plan.js'
import { tripleEvents } from '../src/utils/signalSuite.js'

let passed = 0
const failures = []
const eq = (name, got, want, tol = 0) => {
  const ok = typeof want === 'number' ? Math.abs(got - want) <= tol : JSON.stringify(got) === JSON.stringify(want)
  if (ok) passed++; else failures.push(`${name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
}

// Triple: all three within 2 bars → one event on the bar the third arrives.
const n = 20
const F = () => new Array(n).fill(false)
const bOn = F(), eB = F(), tB = F()
bOn[5] = true; eB[6] = true; tB[7] = true        // → event at 7
bOn[12] = true; eB[15] = true                     // too far apart → nothing
tB[16] = true; bOn[17] = true; eB[17] = true      // → event at 17
const suite = { bravo: { bullOn: bOn, bearOn: F() }, echo: { bull: eB, bear: F() }, tango: { bull: tB, bear: F() } }
const ev = tripleEvents(suite, 2)
eq('triple fires on the third signal within 2 bars', ev.bull.map((f, i) => (f ? i : null)).filter((x) => x != null), [7, 17])
eq('no bear events', ev.bear.some(Boolean), false)
// A repeat inside the window folds into the first.
const bOn2 = F(), eB2 = F(), tB2 = F()
bOn2[3] = true; eB2[3] = true; tB2[3] = true; bOn2[4] = true
eq('repeat inside the window is one event', tripleEvents({ bravo: { bullOn: bOn2, bearOn: F() }, echo: { bull: eB2, bear: F() }, tango: { bull: tB2, bear: F() } }, 2).bull.filter(Boolean).length, 1)
// With lines, Echo / Tango turns are zero crosses.
const ln = (ups) => { const out = new Array(n).fill(-1); for (const i of ups) out[i] = 1; return out }
const bOn3 = F(); bOn3[9] = true
const ev3 = tripleEvents({ bravo: { bullOn: bOn3, bearOn: F() }, echo: { line: ln([8, 9, 10, 11]), bull: F(), bear: F() }, tango: { line: ln([10, 11]), bull: F(), bear: F() } }, 2)
eq('zero crosses count as the turn when a line is given', ev3.bull.map((f, i) => (f ? i : null)).filter((x) => x != null), [10])
const bars = Array.from({ length: n }, (_, i) => ({ t: `2024-01-${String(i + 1).padStart(2, '0')}`, o: 10, h: 11, l: 9, c: 10 + i * 0.1, v: 1 }))
const st = tripleStatus(bars, suite)
eq('status: last bull event and bars ago', [st.lastBull.i, st.lastBull.barsAgo, st.lastBear], [17, 2, null])

// Trend quality gate.
const up = Array.from({ length: 300 }, (_, i) => ({ t: `d${i}`, o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i, v: 1 }))
const model = { slope200: up.map(() => 1) }
const tq = trendQuality(up, model)
eq('trend pullback: small drawdown, 200-day up long enough', [tq.pass, tq.label], [true, 'Trend pullback'])
const crashed = up.map((b, i) => (i > 250 ? { ...b, c: 60, h: 61, l: 59 } : b))
const tq2 = trendQuality(crashed, { slope200: up.map((_, i) => (i > 280 ? 1 : -1)) })
eq('recovery: big drawdown and a young uptrend', [tq2.pass, tq2.label, tq2.days200Up], [false, 'Recovery setup — higher risk', 19])
eq('gate thresholds', [TREND_GATE.maxDrawdown, TREND_GATE.minDays200Up], [0.25, 60])

// Reclaim plan.
const plan = reclaimPlan({ close: 100, weekly: { close: 103, zoneLow: 95, zoneHigh: 102, upperBand: 120 }, pivots: [110, 90, 150, 110.004, 112] })
eq('position vs the zone', plan.position, 'inside')
eq('trigger met on a weekly close above the zone high', [plan.trigger.met, plan.trigger.level], [true, 102])
eq('invalidation level', plan.invalidation.level, 95)
eq('invalidation %', plan.invalidation.pct, -0.05, 1e-12)
eq('targets ascending: pivot, upper band, next pivot', plan.targets.map((t) => [t.label, t.level]), [['Prior pivot', 110], ['Upper band', 120], ['Next pivot', 150]])
eq('reward : risk = (target − close) / (close − zone low)', plan.targets[0].rr, 2, 1e-12)
eq('% to target', plan.targets[1].pct, 0.2, 1e-12)
eq('a pivot within 3% of the first is the same level', reclaimPlan({ close: 100, weekly: { close: 100, zoneLow: 95, zoneHigh: 102 }, pivots: [110, 111, 125] }).targets.map((t) => t.level), [110, 125])
eq('no plan without weekly zone', reclaimPlan({ close: 100, weekly: null }), null)

console.log(`plan checks: ${passed} passed, ${failures.length} failed`)
if (failures.length) { for (const x of failures) console.error('  ✗ ' + x); process.exit(1) }
