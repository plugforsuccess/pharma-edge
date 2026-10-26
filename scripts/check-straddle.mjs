// npm run straddle:check — src/utils/straddle.js
import { straddleValue, straddleTrade, straddleStats, straddleVerdict, STRADDLE } from '../src/utils/straddle.js'
let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL', name) } }
const day = (n) => new Date(Date.UTC(2025, 0, 1) + n * 86400e3).toISOString().slice(0, 10)
// ATM straddle ≈ 0.8 · S · σ · √T.
ok('ATM straddle premium ≈ 0.8·S·σ·√T', Math.abs(straddleValue(100, 100, 0.5, 0.4) - 0.8 * 100 * 0.4 * Math.sqrt(0.5)) < 0.8)
ok('at expiry the value is the distance from the strike', straddleValue(130, 100, 0, 0.4) === 30 && straddleValue(70, 100, 0, 0.4) === 30)
// A noisy flat stock loses most of the premium; a stock that halves pays.
const flat = [], down = []
let s = 100
for (let i = 0; i < 400; i++) { s *= 1 + ((i % 7) - 3) * 0.004; flat.push({ t: day(i), c: s }) }
let d = 100
for (let i = 0; i < 400; i++) { d *= i < 200 ? 1 + ((i % 7) - 3) * 0.004 : 0.9965; down.push({ t: day(i), c: d }) }
const tf = straddleTrade(flat, 200), td = straddleTrade(down, 200)
ok('flat stock: the straddle loses', tf && tf.ret < -0.3 && tf.hit === false)
ok('a stock that halves: the straddle pays', td && td.ret > 0.5)
ok('target exit fires on the way down', straddleTrade(down, 200, { target: 2 }).hit === true && straddleTrade(down, 200, { target: 2 }).days < 126)
ok('horizon past the data → null', straddleTrade(flat, 350) === null)
ok('a higher premium multiplier costs more', straddleTrade(down, 200, { premium: 1.6 }).premium > straddleTrade(down, 200, { premium: 1.0 }).premium)
const st = straddleStats([tf, td, null])
ok('stats ignore nulls', st.n === 2 && st.win === 0.5)
ok('verdict: pass needs count, positive average, +10 pts and a better median', straddleVerdict({ n: 150, avg: 0.2, median: 0.05 }, { avg: 0.05, median: 0 }) === 'pass' && straddleVerdict({ n: 150, avg: 0.12, median: 0.05 }, { avg: 0.05, median: 0 }) === 'fail' && straddleVerdict({ n: 50, avg: 0.5, median: 0.3 }, { avg: 0, median: 0 }) === 'inconclusive')
ok('defaults are the pre-registered ones', STRADDLE.horizon === 126 && STRADDLE.premium === 1.3 && STRADDLE.target === 2 && STRADDLE.slip === 0.02)
console.log(`${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
