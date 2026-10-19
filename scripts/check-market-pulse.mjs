// npm run marketpulse:check — src/utils/marketPulse.js
import { marketPulse, marketRead } from '../src/utils/marketPulse.js'
let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL', name) } }
const line = (n, f) => Array.from({ length: n }, (_, i) => ({ t: `d${i}`, c: f(i) }))

const up = marketPulse({ asOf: '2026-10-16', spy: line(260, (i) => 400 + i), vix: line(10, (i) => 20 - i),
  stocks: [{ vs200: 0.2 }, { vs200: -0.1 }, { vs200: 0.05 }, { vs200: null }],
  leaders: [{ ticker: 'MU', theme: 'Chips & AI' }, { ticker: 'AMD', theme: 'Chips & AI' }, { ticker: 'VLO', theme: 'Refiners' }, { ticker: 'X', theme: null }] })
ok('rising SPY above its 200-day', up.spy_above === true && up.spy_slope200 > 0 && up.spy_vs200 > 0)
ok('breadth counts known only', up.universe === 3 && up.above200 === 2 && Math.abs(up.breadth - 0.6667) < 1e-3)
ok('leaders + groups sorted', up.leaders === 4 && up.groups[0].name === 'Chips & AI' && up.groups[0].n === 2 && up.groups.some((g) => g.name === 'Other'))
ok('vix level + 5d change', up.vix === 11 && up.vix_5d === -5)
ok('read: uptrend, green, broad', marketRead(up).trend === 'Uptrend' && marketRead(up).tone === 'green' && marketRead(up).breadth === 'broad')
const down = marketPulse({ asOf: 'x', spy: line(260, (i) => 700 - i) })
ok('falling SPY below → downtrend', down.spy_above === false && marketRead(down).tone === 'red')
ok('short history → no trend', marketPulse({ asOf: 'x', spy: line(50, () => 1) }).spy_above === undefined && marketRead(marketPulse({ asOf: 'x' })) === null)
ok('streak: above every day since the 200-day exists', up.spy_streak === 61 && up.spy_spark.length === 63 && up.vix_spark.length === 10)
const flip = marketPulse({ asOf: 'x', spy: line(260, (i) => (i < 255 ? 400 + i : 300)) })
ok('streak: 5 closes below after a drop', flip.spy_above === false && flip.spy_streak === 5)
console.log(`${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
