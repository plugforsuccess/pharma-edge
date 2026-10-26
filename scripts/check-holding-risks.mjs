// npm run holdingrisks:check — src/utils/holdingRisks.js
import { riskRow, holdingRiskFacts, shortsRow, catalystRow, cashLine, bothLitLine, riskRows, runwayRow } from '../src/utils/holdingRisks.js'
import { compactFacts } from '../src/utils/fade.js'
let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL', name) } }
const day = (n) => new Date(Date.UTC(2026, 0, 1) + n * 86400e3).toISOString().slice(0, 10)
const bars = []
for (let i = 0; i < 300; i++) bars.push({ t: day(i), o: 100, h: 101, l: 99, c: 100, v: 1e6 })
bars.push({ t: day(300), o: 100, h: 122, l: 100, c: 120, v: 5e6 })
for (let i = 301; i < 306; i++) bars.push({ t: day(i), o: 121, h: 122, l: 120.5, c: 121, v: 1e6 })
for (let i = 306; i < 330; i++) { const c = 121 * 0.98 ** (i - 305); bars.push({ t: day(i), o: c, h: c + 1, l: c - 1, c, v: 1e6 }) }
const c = catalystRow(bars, 329)
ok('catalyst: the event and 24 sessions below its close', c.event === day(300) && c.sessionsBelow === 24 && c.level === 120 && Math.abs(c.jump - 0.2) < 1e-9)
ok('still holding → 0 sessions below', catalystRow(bars, 303).sessionsBelow === 0)
ok('no event on a flat stretch', catalystRow(bars, 250) === null)
ok('fact shows only after 20 sessions below', holdingRiskFacts({ catalyst: catalystRow(bars, 320) }).length === 0 && holdingRiskFacts({ catalyst: c }).length === 1)
const shorts = [{ date: day(290), shares: 1e6 }, { date: day(325), shares: 1.3e6 }]
const s = shortsRow(shorts, bars, 329, 10e6)
ok('shorts: +30% over 35 days, price down, 13% of shares', s && Math.abs(s.siChange - 0.3) < 1e-9 && s.spanDays === 35 && s.priceChange < -0.1 && Math.abs(s.siPct - 0.13) < 1e-9)
ok('stale shorts → no row', shortsRow([{ date: day(100), shares: 1e6 }, { date: day(200), shares: 2e6 }], bars, 329) === null)
ok('shorts up but price held → no fact', holdingRiskFacts({ shorts: { ...s, priceChange: 0.01 } }).length === 0)
const fy = (y, val, filed) => ({ start: `${y}-01-01`, end: `${y}-12-31`, val, form: '10-K', filed })
const fin = compactFacts({ facts: { 'us-gaap': {
  Revenues: { units: { USD: [fy(2025, 1e6, '2026-03-01')] } },
  NetCashProvidedByUsedInOperatingActivities: { units: { USD: [{ start: '2026-01-01', end: '2026-03-31', val: -6e6, form: '10-Q', filed: '2026-05-10' }] } },
  CashAndCashEquivalentsAtCarryingValue: { units: { USD: [{ end: '2026-03-31', val: 24e6, form: '10-Q', filed: '2026-05-10' }] } },
}, dei: {} } })
const row = riskRow({ bars, shorts, fin, sharesOut: 10e6, asOf: day(329) })
ok('runway row: 4 quarters, $24M, −$6M', row.runway && Math.abs(row.runway.quarters - 4) < 1e-9 && row.runway.periodEnd === '2026-03-31')
const facts = holdingRiskFacts(row)
ok('two facts, catalyst first', facts.length === 2 && facts[0].key.startsWith('catalyst:') && facts[1].key.startsWith('shorts:'))
ok('catalyst sentence', /^Has not held its Oct 28 close \(\$120\) for 24 sessions; now \$7\d\.\d\d\.$/.test(facts[0].text))
ok('shorts sentence', /^Short interest \+30% in 35 days to 13\.0% of shares out; price −\d+% over the same window\.$/.test(facts[1].text))
ok('both lit → the test line, both halves', /18% lower six months later at the median, and doubled one time in 3\./.test(bothLitLine(facts)) && bothLitLine(facts.slice(0, 1)) === null)
ok('cash line: plain numbers', cashLine(row) === 'Cash $24M at Mar 31 · $6M used last qtr')
// A JV-run company: $1.4M at the parent, $2.5M contributed to the LLC (a company-extension tag).
const finJv = compactFacts({ facts: { 'us-gaap': {
  NetCashProvidedByUsedInOperatingActivities: { units: { USD: [{ start: '2026-01-01', end: '2026-03-31', val: -2.36e6, form: '10-Q', filed: '2026-05-10' }, { start: '2026-01-01', end: '2026-06-30', val: -3.76e6, form: '10-Q', filed: '2026-08-10' }] } },
  CashAndCashEquivalentsAtCarryingValue: { units: { USD: [{ end: '2026-06-30', val: 41.4e6, form: '10-Q', filed: '2026-08-10' }] } },
}, mtek: { InvestmentInAirJouleLlc: { units: { USD: [{ start: '2026-01-01', end: '2026-03-31', val: 10e6, form: '10-Q', filed: '2026-05-10' }, { start: '2026-01-01', end: '2026-06-30', val: 12.5e6, form: '10-Q', filed: '2026-08-10' }] } } }, dei: {} } })
const rowJv = riskRow({ bars, fin: finJv, asOf: day(329) })
ok('JV spend from a company-extension tag, differenced to the quarter', Math.abs(rowJv.runway.jv - 2.5e6) < 1 && Math.abs(rowJv.runway.burn + 1.4e6) < 1)
ok('runway counts ops + JV', Math.abs(rowJv.runway.quarters - 41.4 / 3.9) < 1e-6)
ok('cash line shows both', cashLine(rowJv) === 'Cash $41M at Jun 30 · $1M ops + $3M to JV last qtr')
ok('fact-test runway factor is untouched', typeof runwayRow === 'function')
// AIRJ's real shape: the generic PaymentsToAcquireInvestments, plus equity-method income → counted.
const finGen = compactFacts({ facts: { 'us-gaap': {
  NetCashProvidedByUsedInOperatingActivities: { units: { USD: [{ start: '2026-01-01', end: '2026-03-31', val: -2.3e6, form: '10-Q', filed: '2026-05-10' }, { start: '2026-01-01', end: '2026-06-30', val: -3.8e6, form: '10-Q', filed: '2026-08-10' }] } },
  CashAndCashEquivalentsAtCarryingValue: { units: { USD: [{ end: '2026-06-30', val: 41.4e6, form: '10-Q', filed: '2026-08-10' }] } },
  PaymentsToAcquireInvestments: { units: { USD: [{ start: '2026-01-01', end: '2026-03-31', val: 10e6, form: '10-Q', filed: '2026-05-10' }, { start: '2026-01-01', end: '2026-06-30', val: 12.5e6, form: '10-Q', filed: '2026-08-10' }] } },
  IncomeLossFromEquityMethodInvestments: { units: { USD: [{ start: '2026-04-01', end: '2026-06-30', val: -2.5e6, form: '10-Q', filed: '2026-08-10' }] } },
}, dei: {} } })
const rowGen = riskRow({ bars, fin: finGen, asOf: day(329) })
ok('generic investments tag counts for an equity-method filer', Math.abs(rowGen.runway.jv - 2.5e6) < 1 && Math.abs(rowGen.runway.quarters - 41.4 / 4.0) < 1e-6)
const finNoEq = compactFacts({ facts: { 'us-gaap': {
  NetCashProvidedByUsedInOperatingActivities: { units: { USD: [{ start: '2026-01-01', end: '2026-03-31', val: 5e8, form: '10-Q', filed: '2026-05-10' }] } },
  CashAndCashEquivalentsAtCarryingValue: { units: { USD: [{ end: '2026-03-31', val: 2e9, form: '10-Q', filed: '2026-05-10' }] } },
  PaymentsToAcquireInvestments: { units: { USD: [{ start: '2026-01-01', end: '2026-03-31', val: 1e9, form: '10-Q', filed: '2026-05-10' }] } },
}, dei: {} } })
ok('…but not for a company buying securities with no equity-method stake', riskRow({ bars, fin: finNoEq, asOf: day(329) }).runway.jv === null)
ok('no cash row → no line', cashLine({ runway: null }) === null)
ok('no verdict words', [...facts.map((f) => f.text), bothLitLine(facts), cashLine(row)].every((t) => !/\b(sell|buy|hold|exit|should)\b/i.test(t)))
ok('empty row → nothing', holdingRiskFacts(null).length === 0)
ok('compact rows mirror the facts', riskRows(row).length === 2 && riskRows(row)[0].value === '24 sessions' && /^price −\d+%$/.test(riskRows(row)[1].value))
ok('a negative differenced JV figure is clamped, not shown', cashLine({ runway: { cash: 2e9, burn: 1.2e9, jv: -3e6, periodEnd: '2026-06-30' } }) === 'Cash $2.0B at Jun 30 · $1.2B generated last qtr')
console.log(`${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
