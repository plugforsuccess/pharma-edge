// npm run weakness:check — src/utils/weakness.js (+ annualFinancials in quality.js)
import { priceWeakness, businessWeakness, weaknessScore, forwardDrop, flagStats, weakVerdict, WEAK } from '../src/utils/weakness.js'
import { annualFinancials } from '../src/utils/quality.js'
let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL', name) } }

// 400 flat bars at 100, then a slide to 40 over the last 60 bars.
const bars = []
for (let i = 0; i < 400; i++) bars.push({ t: `d${i}`, o: 100, h: 101, l: 99, c: 100 })
for (let i = 0; i < 60; i++) { const c = 100 - (60 * (i + 1)) / 60; bars.push({ t: `s${i}`, o: c, h: c + 1, l: c - 1, c }) }
const last = bars.length - 1
const pw = priceWeakness(bars, last, { vs200: -0.3, slope200: -0.05 })
ok('a sliding stock: below the 200, falling 200, near its low, crashed, not stretched', pw.below200 && pw.falling200 && pw.nearLow && pw.crash && !pw.stretched)
const flat = priceWeakness(bars, 399, { vs200: 0, slope200: 0 })
ok('a flat stock lights nothing', !flat.below200 && !flat.falling200 && !flat.crash && !flat.stretched)
ok('near the low: within 5% counts', priceWeakness(bars, 399, { vs200: 0, slope200: 0 }).nearLow === true)
ok('stretched at +35%', priceWeakness(bars, 399, { vs200: 0.4, slope200: 0.02 }).stretched)
ok('no traits → null', priceWeakness(bars, last, null) === null)

const rows = [
  { end: '2022-12-31', fcf: 300, netDebt: 100, shares: 100 },
  { end: '2023-12-31', fcf: 200, netDebt: 150, shares: 101 },
  { end: '2024-12-31', fcf: -50, netDebt: 400, shares: 120 },
]
const bw = businessWeakness(rows)
ok('cash burner, falling two years, diluting, debt up: all four', bw.negFcf && bw.fcfFalling && bw.dilution && bw.debtUp)
ok('a healthy company lights nothing', Object.values(businessWeakness([{ fcf: 100, netDebt: 0, shares: 100 }, { fcf: 120, netDebt: -10, shares: 99 }])).every((v) => !v))
ok('one annual report: trends unknown, not lit', (() => { const b = businessWeakness([{ fcf: 10, netDebt: 5, shares: 1 }]); return !b.fcfFalling && !b.dilution && !b.debtUp })())
ok('no reports → null', businessWeakness([]) === null)
ok('score counts', weaknessScore(pw, bw).score === 8 && weaknessScore(pw, bw).price === 4 && weaknessScore(pw, bw).business === 4)
ok('score with no business data counts price only', weaknessScore(pw, null).score === 4)

// Forward drop: from bar 399 (100) the next 126 bars include the slide to 60.
const fd = forwardDrop(bars, 333)
ok('a 60% slide within the horizon is a drop', fd.dropped && Math.abs(fd.maxFall - (-0.61)) < 0.02)
ok('an incomplete horizon grades nothing', forwardDrop(bars, last - 10) === null)
ok('a flat stretch is not a drop', forwardDrop(bars, 0).dropped === false && Math.abs(forwardDrop(bars, 0).ret) < 1e-9)

// Stats: 100 rows, 10 drops; the flag marks 8 drops + 2 non-drops.
const st = flagStats([...Array(100)].map((_, i) => ({ dropped: i < 10, flagged: i < 8 || (i >= 50 && i < 52), ret: i < 10 ? -0.4 : 0.1 })))
ok('precision 0.8, recall 0.8, lift 8', Math.abs(st.precision - 0.8) < 1e-9 && Math.abs(st.recall - 0.8) < 1e-9 && Math.abs(st.lift - 8) < 1e-9)
ok('that flag passes the mark', weakVerdict(st) === 'pass')
ok('a flag at the base rate fails', weakVerdict({ lift: 1, recall: 0.5, medianRet: 0, medianAll: 0 }) === 'fail')
ok('nothing to grade → inconclusive', weakVerdict({ lift: null }) === 'inconclusive')

// annualFinancials: point-in-time rows from SEC facts.
const fy = (y, val, filed) => ({ start: `${y - 1}-01-01`, end: `${y - 1}-12-31`, val, form: '10-K', fp: 'FY', filed })
const inst = (y, val, filed) => ({ end: `${y - 1}-12-31`, val, form: '10-K', filed })
const co = (o) => ({ facts: { 'us-gaap': Object.fromEntries(Object.entries(o).map(([k, [unit, r]]) => [k, { units: { [unit]: r } }])) } })
const facts = co({
  NetCashProvidedByUsedInOperatingActivities: ['USD', [fy(2024, 120, '2024-02-20'), fy(2025, 150, '2025-02-20')]],
  PaymentsToAcquirePropertyPlantAndEquipment: ['USD', [fy(2024, 20, '2024-02-20'), fy(2025, 30, '2025-02-20')]],
  Revenues: ['USD', [fy(2024, 900, '2024-02-20'), fy(2025, 1000, '2025-02-20')]],
  LongTermDebt: ['USD', [inst(2024, 250, '2024-02-20'), inst(2025, 300, '2025-02-20')]],
  CashAndCashEquivalentsAtCarryingValue: ['USD', [inst(2024, 50, '2024-02-20'), inst(2025, 100, '2025-02-20')]],
  WeightedAverageNumberOfDilutedSharesOutstanding: ['shares', [fy(2024, 100, '2024-02-20'), fy(2025, 101, '2025-02-20')]],
})
const fin = annualFinancials(facts, '2025-06-01')
ok('two annual rows, oldest first, fcf = ocf − capex, net debt = debt − cash', fin.length === 2 && fin[0].fcf === 100 && fin[1].fcf === 120 && fin[1].netDebt === 200 && fin[1].shares === 101)
ok('before the 2025 10-K only one row is known', annualFinancials(facts, '2024-06-01').length === 1)
ok('WEAK thresholds are the pre-registered ones', WEAK.drop === 0.3 && WEAK.dropHorizon === 126 && WEAK.dilution === 0.1)
console.log(`${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
