// npm run quality:check — src/utils/quality.js
import { qualityAt, isFund, qualityParams, qualitySteps, qualityOn, QUALITY, QUALITY_OIL } from '../src/utils/quality.js'
let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL', name) } }
const fy = (y, val, filed, form = '10-K') => ({ start: `${y - 1}-01-01`, end: `${y - 1}-12-31`, val, form, fp: 'FY', filed })
const inst = (y, val, filed) => ({ end: `${y - 1}-12-31`, val, form: '10-K', filed })
const co = (o) => ({ facts: { 'us-gaap': Object.fromEntries(Object.entries(o).map(([k, [unit, rows]]) => [k, { units: { [unit]: rows } }])) } })
const good = co({
  NetCashProvidedByUsedInOperatingActivities: ['USD', [fy(2024, 120, '2024-02-20'), fy(2025, 150, '2025-02-20')]],
  PaymentsToAcquirePropertyPlantAndEquipment: ['USD', [fy(2024, 20, '2024-02-20'), fy(2025, 30, '2025-02-20')]],
  Revenues: ['USD', [fy(2024, 900, '2024-02-20'), fy(2025, 1000, '2025-02-20')]],
  LongTermDebt: ['USD', [inst(2025, 300, '2025-02-20')]],
  CashAndCashEquivalentsAtCarryingValue: ['USD', [inst(2025, 100, '2025-02-20')]],
  WeightedAverageNumberOfDilutedSharesOutstanding: ['shares', [fy(2024, 100, '2024-02-20'), fy(2025, 101, '2025-02-20')]],
})
const q = qualityAt(good, '2025-06-01')
ok('cash-rich company passes', q.pass && q.fcf === 120 && Math.abs(q.fcfMargin - 0.12) < 1e-9 && q.netDebt === 200)
ok('point in time: before the 2025 10-K only FY2023 counts', qualityAt(good, '2024-06-01').fcf === 100)
ok('nothing filed yet → unknown, not a pass', !qualityAt(good, '2023-06-01').known && !qualityAt(good, '2023-06-01').pass)
const burner = co({
  NetCashProvidedByUsedInOperatingActivities: ['USD', [fy(2025, -50, '2025-02-20')]],
  Revenues: ['USD', [fy(2025, 400, '2025-02-20')]],
})
ok('cash burner fails on free cash flow', qualityAt(burner, '2025-06-01').misses.includes('fcf'))
const levered = co({
  NetCashProvidedByUsedInOperatingActivities: ['USD', [fy(2025, 100, '2025-02-20')]],
  Revenues: ['USD', [fy(2025, 1000, '2025-02-20')]],
  LongTermDebt: ['USD', [inst(2025, 500, '2025-02-20')]],
})
ok('debt over 3 years of free cash flow fails', qualityAt(levered, '2025-06-01').misses.join() === 'debt')
const diluter = co({
  NetCashProvidedByUsedInOperatingActivities: ['USD', [fy(2025, 100, '2025-02-20')]],
  Revenues: ['USD', [fy(2025, 1000, '2025-02-20')]],
  WeightedAverageNumberOfDilutedSharesOutstanding: ['shares', [fy(2024, 100, '2024-02-20'), fy(2025, 120, '2025-02-20')]],
})
ok('20% more shares fails on dilution', qualityAt(diluter, '2025-06-01').misses.join() === 'dilution')
ok('funds are exempt', isFund('USO') && isFund('XLE') && isFund('DRAM', 'Roundhill Memory ETF') && !isFund('XOM', 'Exxon Mobil'))
const switcher = co({
  NetCashProvidedByUsedInOperatingActivities: ['USD', [fy(2025, 100, '2025-02-20')]],
  Revenues: ['USD', [fy(2018, 50, '2018-02-20')]],
  RevenueFromContractWithCustomerExcludingAssessedTax: ['USD', [fy(2025, 1000, '2025-02-20')]],
})
const sq = qualityAt(switcher, '2025-06-01')
ok('a company that switched revenue tags reads this year, not a stale one', sq.known && Math.abs(sq.fcfMargin - 0.1) < 1e-9)
const stale = co({
  NetCashProvidedByUsedInOperatingActivities: ['USD', [fy(2025, 100, '2025-02-20')]],
  Revenues: ['USD', [fy(2020, 50, '2020-02-20')]],
})
ok('no revenue for the same year → unknown, never an old year', !qualityAt(stale, '2025-06-01').known)
const refiner = co({
  NetCashProvidedByUsedInOperatingActivities: ['USD', [fy(2025, 40, '2025-02-20')]],
  Revenues: ['USD', [fy(2025, 1000, '2025-02-20')]],
  LongTermDebt: ['USD', [inst(2025, 160, '2025-02-20')]],
})
ok('a thin-margin, more-indebted refiner fails the standard bar, passes the oil rule',
  !qualityAt(refiner, '2025-06-01', QUALITY).pass && qualityAt(refiner, '2025-06-01', QUALITY_OIL).pass)
ok('oil groups get the oil rule, others the standard', qualityParams('Refiners') === QUALITY_OIL && qualityParams('Chips • AI') === QUALITY && qualityParams(null) === QUALITY)
const steps = qualitySteps(good)
ok('one step per 10-K filing date', steps.length === 2 && steps[0].from === '2024-02-20' && steps[1].fcf === 120)
ok('the step in force on a date matches qualityAt that day', qualityOn(steps, '2024-06-01').fcf === qualityAt(good, '2024-06-01').fcf && qualityOn(steps, '2023-01-01') === null)
const { basketToday } = await import('./lib/leaderQuality.mjs')
const ranked = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'].map((t, i) => ({ ticker: t, rank: i + 1, group: i < 6 ? 'Chips' : null }))
const closeOf = () => 10
const first = basketToday({ asOf: '2026-10-20', prev: null, ranked, closeOf })
ok('first night: strongest 10, at most 4 per group', first.rebalanced && first.tickers.join('') === 'ABCDGHIJKL')
const mid = basketToday({ asOf: '2026-10-21', prev: first, ranked: ranked.slice().reverse(), closeOf })
ok('same month: members held, not re-picked', !mid.rebalanced && mid.tickers.join('') === first.tickers.join(''))
ok('new month: re-picked', basketToday({ asOf: '2026-11-02', prev: mid, ranked: ranked.slice(6), closeOf }).tickers.join('') === 'GHIJKL')
ok('already logged today → nothing', basketToday({ asOf: '2026-10-21', prev: mid, ranked, closeOf }) === null)
ok('a missing close → nothing logged', basketToday({ asOf: '2026-11-02', prev: mid, ranked, closeOf: (t) => (t === 'A' ? null : 10) }) === null)
const { mergeFacts } = await import('./lib/sec.mjs')
const newCo = co({ NetCashProvidedByUsedInOperatingActivities: ['USD', [{ start: '2026-01-01', end: '2026-06-30', val: 9, form: '10-Q', filed: '2026-08-03' }]] })
const merged = mergeFacts([newCo, good])
ok('a moved company: old 10-Ks merge with the new record', qualityAt(merged, '2025-06-01').fcf === 120 && mergeFacts([good]) === good)
console.log(`${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
