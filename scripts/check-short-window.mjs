import { entrySignal, pathAfter, putAfter, shortAfter, pathStats, windowVerdict, SHORT_WINDOW, bearCallAfter, shortPlusCallAfter } from '../src/utils/shortWindow.js'
let pass = 0, fail = 0
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m) } }
const day = (i) => new Date(Date.UTC(2024, 0, 1) + i * 86400e3).toISOString().slice(0, 10)
// 80 zig-zag bars around 10, a jump to 12 at 80, then a path.
const mk = (path) => {
  const b = Array.from({ length: 80 }, (_, i) => { const c = 10 * (1 + 0.03 * (i % 2 ? 1 : -1)); return { t: day(i), o: c, h: c, l: c, c, v: 1e6 } })
  b.push({ t: day(80), o: 10, h: 12, l: 10, c: 12, v: 5e6 })
  path.forEach((c, k) => b.push({ t: day(81 + k), o: c, h: c, l: c, c, v: 1e6 }))
  return b
}
const flat = (n, c) => Array(n).fill(c)
const b1 = mk([12.5, 11.9, 11.8, 11.7, 11.6, 11.5, ...flat(200, 11)])
ok(entrySignal(b1, 80, 'E0') === 80, 'E0 = the jump bar')
ok(entrySignal(b1, 80, 'E3') === 84 && entrySignal(b1, 80, 'E5') === 86, 'E3 / E5: 3 / 5 closes in a row under the jump close')
ok(entrySignal(b1, 80, 'D10') === null && entrySignal(mk([11, 10.7, ...flat(200, 10)]), 80, 'D10') === 82, 'D10: a close 10% under J within 5 sessions')
ok(entrySignal(mk(flat(200, 13)), 80, 'E3') === null, 'a held jump never signals E3')
// Path: entry at the open after 84 = 11.6 → falls to 6 by bar 100.
const b2 = mk([12.5, 11.9, 11.8, 11.7, 11.6, ...Array.from({ length: 15 }, (_, k) => 11.6 - (k + 1) * 0.375), ...flat(200, 6)])
const pa = pathAfter(b2, 84)
ok(pa && Math.abs(pa.entry - b2[85].o) < 1e-9, 'entry at the next open')
ok(pa.by[21].falls[0.4] && pa.by[21].dd < -0.4 && !pa.by[21].rose, '1M: fell 40%+, deepest drawdown under −40%, no rise')
ok(pathAfter(mk(flat(60, 11)), 84) === null, 'incomplete horizon → null')
// Put with the take: sold the first close ≥ 20% under the entry.
const pt = putAfter(b2, 84, 42, { take: true }), ph = putAfter(b2, 84, 42)
ok(pt.took && pt.days < 42 && !ph.took, 'take sells early; hold runs to expiry')
ok(ph.ret > 0 && pt.ret > -1, 'a 48% fall pays the held put')
// Short: covered at the −20% target.
const sh = shortAfter(b2, 84)
ok(sh && !sh.stopped && sh.ret > 0.15, 'short covered at the target')
const up = shortAfter(mk([12.5, 11.9, 11.8, 11.7, 11.6, 14, 18, ...flat(200, 18)]), 84)
ok(up.stopped && up.ret < -0.5, 'short stopped at +50%')
const st = pathStats([pa, null, pa])
ok(st.n === 2 && st.by[21].falls[0.4] === 1, 'pathStats skips nulls')
const rows = (n, r) => Array.from({ length: n }, (_, i) => ({ t: `${2024 + (i % 3)}-03-01`, trade: { ret: r } }))
ok(windowVerdict(rows(120, 0.2)).verdict === 'pass' && windowVerdict(rows(50, 0.2)).verdict === 'inconclusive' && windowVerdict(rows(120, -0.1)).verdict === 'fail', 'verdict')
ok(SHORT_WINDOW.primary.entry === 'E3' && SHORT_WINDOW.primary.putDays === 42 && SHORT_WINDOW.take === 0.2, 'pre-registered primary')
// Addendum 1: bear call spread and short stock + short call, 21 sessions.
const down = mk([12.5, 11.9, 11.8, 11.7, 11.6, ...flat(200, 9)])
const bc = bearCallAfter(down, 84)
ok(bc && bc.credit > 0 && bc.credit < bc.width && Math.abs(bc.ret - bc.credit / (bc.width - bc.credit)) < 1e-9, 'bear call: stock falls → keep the whole credit')
const rocket = mk([12.5, 11.9, 11.8, 11.7, 11.6, ...flat(200, 30)])
const bcUp = bearCallAfter(rocket, 84)
ok(Math.abs(bcUp.ret + 1) < 1e-9, 'bear call: stock rockets → lose exactly the max loss (−100% of risk)')
ok(bearCallAfter(down, 84, { otm: 0.5 }).credit < bc.credit, 'a higher short strike collects less')
const spc = shortPlusCallAfter(down, 84)
ok(spc && spc.ret > 0.2 && spc.prem > 0 && !spc.stopped, 'short + call: a fall pays the short and keeps the premium')
const spcUp = shortPlusCallAfter(rocket, 84)
ok(spcUp.ret < -2, 'short + call: a rocket loses on both legs (> 2× the price)')
const climb = mk([12.5, 11.9, 11.8, 11.7, 11.6, ...Array.from({ length: 30 }, (_, k) => 11.6 * (1 + 0.06 * (k + 1))), ...flat(200, 40)])
const spcStop = shortPlusCallAfter(climb, 84, { stop: 0.5 }), spcHold = shortPlusCallAfter(climb, 84)
ok(spcStop.stopped && spcStop.ret > spcHold.ret, 'the +50% stop closes both early and caps the loss on a steady climb')
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
