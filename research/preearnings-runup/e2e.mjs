// End-to-end check on synthetic chains: a planted edge must pass, no edge must fail,
// and the out-of-sample set must stay out of an in-sample run. node e2e.mjs
import { run } from './backtest.mjs'
import { RULES, bsDelta, rng } from './lib.mjs'
let pass = 0, fail = 0
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m) } }
// Weekday sessions 2023-01-02 → 2026-10-27.
const sessions = []
for (let t = Date.UTC(2023, 0, 2); t <= Date.UTC(2026, 9, 27); t += 86400e3) { const d = new Date(t); if (d.getUTCDay() % 6) sessions.push(d.toISOString().slice(0, 10)) }
const tks = RULES.universe.slice(0, 24)
// Four AMC reports a year per ticker, staggered.
const events = []
for (const [j, tk] of tks.entries()) for (let i = 40 + j; i < sessions.length - 3; i += 63) events.push({ tk, status: 'confirmed', timing: 'AMC', L: sessions[i], date: sessions[i] })
const evIdx = new Map(tks.map((tk) => [tk, events.filter((e) => e.tk === tk).map((e) => sessions.indexOf(e.L))]))
const fridayOnOrAfter = (i) => { for (let k = i; k < sessions.length; k++) if (new Date(`${sessions[k]}T12:00:00Z`).getUTCDay() === 5) return sessions[k]; return sessions.at(-1) }
// Option price: Black-Scholes-ish premium = spot × iv × √T × 0.4 scaled by moneyness; IV rises into a report when `edge`.
const ncdf = (x) => 0.5 * (1 + Math.tanh(0.7978845608 * (x + 0.044715 * x ** 3)))
function bsPrice(S, K, T, v, type) { const sd = v * Math.sqrt(T), d1 = (Math.log(S / K) + 0.5 * v * v * T) / sd, d2 = d1 - sd; const c = S * ncdf(d1) - K * ncdf(d2); return type === 'call' ? c : c - S + K }
function provider(edge) {
  return (tk, date) => {
    const i = sessions.indexOf(date); if (i < 0) return null
    const next = evIdx.get(tk).find((L) => L >= i)
    const toEvent = next == null ? 99 : next - i
    const S = 100
    const ivAt = (time) => 0.35 + (edge && toEvent <= 5 ? 0.5 / (toEvent + 1) + (toEvent === 0 && time === '15:55' ? 0.15 : 0) : 0)
    const exp = fridayOnOrAfter(Math.min(sessions.length - 1, (next ?? i) + 1))
    const snapshots = {}, spot = {}
    for (const time of ['10:00', '15:45', '15:55']) {
      const T = Math.max(0.5, (Date.parse(exp) - Date.parse(date)) / 86400e3 + 0.3) / 365, v = ivAt(time)
      spot[time] = S
      snapshots[time] = []
      for (let K = 80; K <= 120; K += 1) for (const type of ['call', 'put']) {
        const m = Math.max(0.05, bsPrice(S, K, T, v, type)), half = Math.max(0.01, m * 0.03)
        snapshots[time].push({ expiry: exp, strike: K, type, bid: +(m - half).toFixed(2), ask: +(m + half).toFixed(2), iv: v, delta: bsDelta(S, K, T, v, type), oi: 2000, prevVol: 500 })
      }
    }
    return { avgOptVol20: 100000, ivRank: 50, spot, snapshots }
  }
}
const closesBy = new Map(tks.map((tk) => [tk, sessions.map(() => 100)]))
const withEdge = run({ events, sessions, closesBy, getDay: provider(true), oos: true })
const P = withEdge.results['put|0.2|same-day|pre-release'], S = withEdge.results['straddle|0.5|2|pre-release']
ok(P.metrics.n >= 100, `planted edge: ≥ 100 out-of-sample primary trades (${P.metrics.n})`)
ok(S.verdict === 'pass', `planted IV run-up: the 2-day straddle passes (${S.verdict} ${JSON.stringify(S.checks)} exp ${S.metrics.expectancy?.toFixed(3)} ctrl ${S.controlMean?.toFixed(3)})`)
ok(withEdge.verdict === 'edge', `overall verdict edge (${withEdge.verdict})`)
const none = run({ events, sessions, closesBy, getDay: provider(false), oos: true })
ok(none.verdict === 'no edge', `no planted edge → no edge (${none.verdict})`)
ok(none.results['straddle|0.5|2|pre-release'].metrics.expectancy < 0, 'flat IV: costs make the straddle lose')
const is = run({ events, sessions, closesBy, getDay: provider(true), oos: false })
ok(Object.values(is.results).every((r) => r.trades.every((t) => t.date < RULES.oosFrom)), 'in-sample run never touches out-of-sample events')
ok(is.verdict === 'in-sample (not graded)', 'in-sample is never graded')
ok(Object.values(withEdge.results).every((r) => r.trades.every((t) => t.date >= RULES.oosFrom)), 'out-of-sample run uses only out-of-sample events')
const held = withEdge.results['put|0.2|same-day|held-through']
ok(held.metrics.n > 0 && held.trades.every((t) => t.quoteTimes === '10:00→10:00'), 'held-through exits the next morning')
ok(P.trades.every((t) => t.quoteTimes === '10:00→15:55'), 'primary: 10:00 entry, 15:55 exit')
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
