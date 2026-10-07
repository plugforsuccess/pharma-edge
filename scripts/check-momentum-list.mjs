// npm run momentumlist:check — src/utils/momentumList.js
import { momentumToday, moveGroups, forwardOutcome, SWING_PLAN } from '../src/utils/momentumList.js'
import { bsCall } from '../src/utils/replay.js'
let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL', name) } }
const day = (i) => new Date(Date.UTC(2023, 0, 2) + i * 86400e3).toISOString().slice(0, 10)
const mk = (n, f) => Array.from({ length: n }, (_, i) => ({ t: day(i), c: f(i) }))
// 40 tickers, growth rate g per bar; ticker 39 grows fastest. Ticker 0 falls (below its 200-day).
const items = Array.from({ length: 40 }, (_, k) => ({ ticker: `T${String(k).padStart(2, '0')}`, bars: mk(300, (i) => (k === 0 ? 200 - i * 0.3 : 100 * Math.exp((k / 4000) * i))) }))
const { picks, eligible, scored } = momentumToday(items)
ok('scored every ticker with a year of history', scored === 40)
ok('the falling ticker is not eligible', eligible === 39 && !picks.some((p) => p.ticker === 'T00'))
ok('top decile of 39 eligible = 3', picks.length === 3)
ok('fastest first', picks[0].ticker === 'T39' && picks[0].rank === 1 && picks[2].ticker === 'T37')
ok('fewer than 30 eligible → no picks', momentumToday(items.slice(0, 20)).picks.length === 0)
// Groups: A and B share a noise series, C has its own.
let s = 1; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5)
const shared = Array.from({ length: 200 }, rnd), own = Array.from({ length: 200 }, rnd)
const path = (noise) => { let p = 100; return noise.map((x) => (p *= 1 + x * 0.04)) }
const g = moveGroups([{ ticker: 'A', closes: path(shared) }, { ticker: 'B', closes: path(shared.map((x, i) => x + own[i] * 0.1)) }, { ticker: 'C', closes: path(own) }])
ok('A and B move together', g.get('A').group === 'A' && g.get('B').group === 'A' && g.get('A').peers.includes('B'))
ok('C stands alone', g.get('C').group === 'C' && g.get('C').peers.length === 0)
// Forward outcome: flat then a jump that lifts the call past +75%.
const bars = mk(400, (i) => (i < 250 ? 100 : 160)).map((b, i) => ({ ...b, c: b.c * (1 + (i % 2 ? 0.01 : -0.01)) }))
const strike = 80, expiry = day(730), cost = bsCall(bars[200].c, strike, 530 / 365, 0.2)
const out = forwardOutcome(bars, { logged_on: bars[200].t, strike, expiry, cost, target: 0.75, hold_days: 378 })
ok('hit on the jump', out.status === 'hit' && out.closed_on === bars[250].t && out.call_ret >= 0.75)
const flat = mk(300, () => 100).map((b, i) => ({ ...b, c: 100 * (1 + (i % 2 ? 0.005 : -0.005)) }))
const o2 = forwardOutcome(flat, { logged_on: flat[100].t, strike: 80, expiry: day(830), cost: 25, target: 0.75, hold_days: 250 })
ok('still open before the cap', o2.status === 'open' && o2.days === 199)
const o3 = forwardOutcome(flat, { logged_on: flat[100].t, strike: 80, expiry: day(830), cost: 25, target: 0.75, hold_days: 50 })
ok('capped after hold_days bars', o3.status === 'capped' && o3.days === 50)
ok('unknown when logged after the data', forwardOutcome(flat, { logged_on: '2099-01-01', strike: 80, expiry: day(830), cost: 25 }).status === 'unknown')
ok('plan is +75% / 378 bars', SWING_PLAN.target === 0.75 && SWING_PLAN.holdDays === 378)
console.log(`momentum list checks: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
