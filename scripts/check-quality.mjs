// npm run quality:check — src/utils/quality.js
import { qualityAt, isFund } from '../src/utils/quality.js'
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
console.log(`${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
