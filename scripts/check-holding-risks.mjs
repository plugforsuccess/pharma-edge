// npm run holdingrisks:check — src/utils/holdingRisks.js
import { riskRow, holdingRiskFacts, shortsRow, catalystRow } from '../src/utils/holdingRisks.js'
import { compactFacts } from '../src/utils/fade.js'
let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL', name) } }
const day = (n) => new Date(Date.UTC(2026, 0, 1) + n * 86400e3).toISOString().slice(0, 10)
const bars = []
for (let i = 0; i < 300; i++) bars.push({ t: day(i), o: 100, h: 101, l: 99, c: 100, v: 1e6 })
bars.push({ t: day(300), o: 100, h: 122, l: 100, c: 120, v: 5e6 })
for (let i = 301; i < 306; i++) bars.push({ t: day(i), o: 121, h: 122, l: 120.5, c: 121, v: 1e6 })
for (let i = 306; i < 330; i++) { const c = 121 * 0.98 ** (i - 305); bars.push({ t: day(i), o: c, h: c + 1, l: c - 1, c, v: 1e6 }) }
const broke = catalystRow(bars, 329)
ok('catalyst: the jump and the day it broke', broke.event === day(300) && broke.brokeOn === day(306) && Math.abs(broke.jump - 0.2) < 1e-9 && broke.level === 120)
ok('catalyst held the day after', catalystRow(bars, 303).brokeOn === null && catalystRow(bars, 303).event === day(300))
ok('no event on a flat stretch', catalystRow(bars, 250) === null)
const shorts = [{ date: day(290), shares: 1e6 }, { date: day(325), shares: 1.3e6 }]
const s = shortsRow(shorts, bars, 329, 10e6)
ok('shorts: +30% between settlements, price down, 13% of shares', s && Math.abs(s.siChange - 0.3) < 1e-9 && s.priceChange < -0.1 && Math.abs(s.siPct - 0.13) < 1e-9 && s.from === day(290) && s.to === day(325))
ok('stale shorts → no row', shortsRow([{ date: day(100), shares: 1e6 }, { date: day(200), shares: 2e6 }], bars, 329) === null)
const fy = (y, val, filed) => ({ start: `${y}-01-01`, end: `${y}-12-31`, val, form: '10-K', filed })
const fin = compactFacts({ facts: { 'us-gaap': {
  Revenues: { units: { USD: [fy(2025, 1e6, '2026-03-01')] } },
  NetCashProvidedByUsedInOperatingActivities: { units: { USD: [{ start: '2026-01-01', end: '2026-03-31', val: -6e6, form: '10-Q', filed: '2026-05-10' }] } },
  CashAndCashEquivalentsAtCarryingValue: { units: { USD: [{ end: '2026-03-31', val: 24e6, form: '10-Q', filed: '2026-05-10' }] } },
}, dei: {} } })
const row = riskRow({ bars, shorts, fin, sharesOut: 10e6, asOf: day(329) })
ok('runway: 4 quarters from $24M and $6M burn', row.runway && Math.abs(row.runway.quarters - 4) < 1e-9 && row.runway.periodEnd === '2026-03-31')
const facts = holdingRiskFacts(row)
ok('three facts, catalyst first', facts.length === 3 && facts[0].key.startsWith('catalyst:') && facts[1].key.startsWith('shorts:') && facts[2].key.startsWith('runway:'))
ok('catalyst copy names the jump day and the break day', /Hasn't held its Oct 28 jump/.test(facts[0].title) && /\+20% that day/.test(facts[0].body) && /below that day's \$120 on Nov 3/.test(facts[0].body))
ok('shorts copy: +30% since the earlier settlement, price fell, 13% of shares', /Short interest \+30% since Oct 18/.test(facts[1].title) && /price fell/.test(facts[1].body) && /13% of the shares/.test(facts[1].body) && facts[1].tone === 'amber')
ok('runway copy: about 4 quarters, amounts, neutral tone', /about 4 quarters/.test(facts[2].title) && /\$24M on hand at Mar 31 against \$6M/.test(facts[2].body) && facts[2].tone === 'neutral')
ok('no verdict words anywhere', facts.every((f) => !/\b(sell|buy|hold|short it|exit)\b/i.test(f.title + ' ' + f.body)))
ok('cash-rich company shows no runway fact', holdingRiskFacts({ ...row, runway: { quarters: 12, cash: 1e9, burn: -5e7, periodEnd: '2026-03-31' } }).length === 2)
ok('shorts up, price held → neutral', holdingRiskFacts({ as_of: day(329), catalyst: null, runway: null, shorts: { ...s, priceChange: 0.01 } })[0].tone === 'neutral')
ok('empty row → nothing', holdingRiskFacts(null).length === 0 && holdingRiskFacts({ as_of: day(329), catalyst: null, shorts: null, runway: null }).length === 0)
console.log(`${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
