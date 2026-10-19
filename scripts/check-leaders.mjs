// npm run leaders:check — src/utils/leaders.js
import { LEADER, leaderSeries, leaderMisses, isLeader, pctRank } from '../src/utils/leaders.js'
let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL', name) } }
const day = (i) => new Date(Date.UTC(2021, 0, 4) + Math.floor(i * 7 / 5) * 86400e3).toISOString().slice(0, 10)
// A steady riser with mild noise, and SPY rising too.
const bars = Array.from({ length: 600 }, (_, i) => ({ t: day(i), c: 50 * Math.exp(0.0012 * i) * (1 + 0.004 * Math.sin(i)) }))
const spy = Array.from({ length: 600 }, (_, i) => ({ t: day(i), c: 400 * Math.exp(0.0004 * i) }))
const ls = leaderSeries(bars, spy)
const t = ls.at(599)
ok('no traits before a year of history', ls.at(200) === null)
ok('12-1 return of a +0.12%/day riser ≈ +31%', Math.abs(t.mom12 - (Math.exp(0.0012 * 231) - 1)) < 0.03)
ok('well above a rising 200-day', t.vs200 > 0.09 && t.slope200 > 0.014)
ok('S&P above its 200-day', t.spyUp === true)
ok('misses only what fails', JSON.stringify(leaderMisses({ ...t, volRank: 0.2 })) === '[]' && JSON.stringify(leaderMisses({ ...t, volRank: 0.9, vs200: 0.05 })) === '["vs200","volRank"]')
ok('the S&P check is off: a leader whatever the S&P', isLeader({ ...t, volRank: 0.2, spyUp: false }) && isLeader({ ...t, volRank: 0.2, spyUp: null }))
ok('the S&P check still works when asked for', !isLeader({ ...t, volRank: 0.2, spyUp: false }, { ...LEADER, spyUp: true }))
ok('a falling stock is not a leader', leaderMisses(leaderSeries(bars.map((b, i) => ({ t: b.t, c: 100 * Math.exp(-0.001 * i) })), spy).at(599)).includes('mom12'))
ok('pctRank: the max of a rising series = 1', pctRank(Array.from({ length: 300 }, (_, i) => i), 299) === 1)
ok('thresholds', LEADER.mom12 === 0.17 && LEADER.vs200 === 0.09 && LEADER.volRankMax === 0.45 && LEADER.spyUp === false)
console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
