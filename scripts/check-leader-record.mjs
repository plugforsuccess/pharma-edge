// npm run leaderrecord:check — src/utils/leaderRecord.js
import { leaderStints, stintSummary } from '../src/utils/leaderRecord.js'
let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL', name) } }
const bars = Array.from({ length: 40 }, (_, i) => ({ t: `d${String(i).padStart(2, '0')}`, c: 100 + i }))
const days = (on) => bars.map((_, i) => on.some(([a, b]) => i >= a && i <= b))
const spy = new Map(bars.map((b, i) => [b.t, 500 + i]))

const a = leaderStints(bars, days([[5, 10], [25, 39]]), { spy, lookback: 40, mergeGap: 5 })
ok('two stints', a.length === 2)
ok('left the list: noted, but held to today', a[0].joined_on === 'd05' && a[0].left_on === 'd11' && a[0].left_close === 111 && Math.abs(a[0].gain - (139 / 105 - 1)) < 1e-4 && a[0].days === 34 && !a[0].open)
ok('open: to today', a[1].open && a[1].left_on === null && a[1].last_close === 139 && Math.abs(a[1].gain - (139 / 125 - 1)) < 1e-4)
ok('S&P same days', Math.abs(a[0].spy_gain - (539 / 505 - 1)) < 1e-4)
const m = leaderStints(bars, days([[5, 10], [14, 20]]), { lookback: 40, mergeGap: 5 })
ok('a dip of ≤ the gap that ends back on merges', m.length === 1 && m[0].joined_on === 'd05' && m[0].left_on === 'd21')
const n = leaderStints(bars, days([[5, 10], [17, 20]]), { lookback: 40, mergeGap: 5 })
ok('a longer gap splits', n.length === 2)
const old = leaderStints(bars, days([[2, 4], [12, 39]]), { lookback: 20, mergeGap: 5 })
ok('open stint kept even when it joined before the lookback', old.length === 1 && old[0].joined_on === 'd12')
const s = stintSummary(a)
ok('summary', s.n === 2 && s.higher === 1 && s.beat === 1 && s.median > 0)
ok('no bars', leaderStints([], []).length === 0)
ok('default: a 3-week dip merges', leaderStints(bars, days([[2, 8], [24, 30]]), { lookback: 40 }).length === 1)
console.log(`${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
