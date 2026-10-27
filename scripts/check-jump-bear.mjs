import { jumpVol, putTrade, spreadTrade, shortTrade, bearStats, bearVerdict, JUMP_BEAR } from '../src/utils/jumpBear.js'
import { bsPut } from '../src/utils/replay.js'
let pass = 0, fail = 0
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m) } }
const close = (a, b, e = 1e-9) => Math.abs(a - b) < e
const day = (i) => new Date(Date.UTC(2024, 0, 1) + i * 86400e3).toISOString().slice(0, 10)
// Zig-zag history (vol > 0), a jump at 100, entry open 10 at 101, then a path.
const mk = (path) => {
  const b = Array.from({ length: 101 }, (_, i) => { const c = 10 * (1 + 0.03 * (i % 2 ? 1 : -1)); return { t: day(i), o: c, h: c, l: c, c, v: 1e6 } })
  b[100] = { t: day(100), o: 10, h: 12, l: 10, c: 12, v: 5e6 }
  path.forEach((c, k) => b.push({ t: day(101 + k), o: k === 0 ? 10 : c, h: c, l: c, c, v: 1e6 }))
  return b
}
const flat = (n, c) => Array(n).fill(c)
// 1. Put: stock goes to 6 → payoff 4 on strike 10
const down = mk(flat(200, 6)); down[101].o = 10
const vol = jumpVol(down, 100)
ok(vol > 0.15, 'vol computed on the jump day')
const pt = putTrade(down, 100)
const paid = bsPut(10, 10, 126 / 252, vol, 0.04) * 1.02
ok(pt && close(pt.paid, paid) && close(pt.ret, (4 * 0.98) / paid - 1), 'put: payoff at expiry on the premium paid')
const up = mk(flat(200, 14)); up[101].o = 10
ok(close(putTrade(up, 100).ret, -1), 'put expires worthless above the strike')
ok(putTrade(mk(flat(50, 6)), 100) === null, 'put: incomplete horizon is null')
// 2. Short: down to 6 → (9.8 − 6.12 − fee) / 10
const sh = shortTrade(down, 100, { borrow: 0.3, stop: 1.0 })
ok(close(sh.ret, (10 * 0.98 - 6 * 1.02 - 10 * 0.3 * 126 / 252) / 10) && !sh.stopped, 'short: covered at the horizon, borrow accrued')
const spike = mk([10, 15, 21, ...flat(200, 30)])
const ss = shortTrade(spike, 100, { borrow: 0.3, stop: 1.0 })
ok(ss.stopped && ss.days === 2 && close(ss.ret, (9.8 - 21 * 1.02 - 10 * 0.3 * 2 / 252) / 10), 'short: stopped at the first close ≥ 2× entry')
ok(shortTrade(spike, 100, { borrow: 0.3, stop: null }).ret < -1.9, 'short with no stop takes the whole run')
// 3. Spread: falls hard → takes fire, ends positive; rallies → stop at −50%
const sp = spreadTrade(mk([10, 9, 8, 7, 6, 5, 4, ...flat(200, 4)]), 100)
ok(sp && !sp.skipped && sp.ret > 0, `spread: profit on a collapse (${sp && sp.ret})`)
const sr = spreadTrade(mk([10, 11, 12, 13, 14, ...flat(200, 15)]), 100)
ok(sr && !sr.skipped && sr.stopped && sr.ret < -0.45 && sr.ret > -0.75, `spread: stopped near −50% on a rally (${sr && sr.ret})`)
const cheapVol = Array.from({ length: 101 }, (_, i) => ({ t: day(i), o: 10, h: 10, l: 10, c: i % 2 ? 10.01 : 10, v: 1e6 }))
cheapVol[100] = { t: day(100), o: 10, h: 10, l: 10, c: 10.01, v: 5e6 }; flat(80, 10).forEach((c, k) => cheapVol.push({ t: day(101 + k), o: c, h: c, l: c, c, v: 1e6 }))
const sk = spreadTrade(cheapVol, 100)
ok(sk === null || sk.skipped || sk.ret != null, 'spread: low-vol case handled')
// stats + verdict
const rows = (n, r, y = '2024') => Array.from({ length: n }, (_, i) => ({ t: `${['2024', '2025', '2026'][i % 3]}-03-01`, trade: { ret: r } }))
ok(bearVerdict(rows(120, 0.2)).verdict === 'pass', 'pass: positive average and median every year')
ok(bearVerdict(rows(50, 0.2)).verdict === 'inconclusive', 'under 100 is inconclusive')
const mixed = rows(120, 0.2).map((r) => (r.t.startsWith('2025') ? { ...r, trade: { ret: -0.5 } } : r))
ok(bearVerdict(mixed).verdict === 'fail', 'fail: one losing year')
const st = bearStats([{ ret: -1 }, { ret: 0.5 }, { ret: 2 }, { skipped: true }])
ok(st.n === 3 && st.skipped === 1 && close(st.median, 0.5) && close(st.lostHalf, 1 / 3) && st.worst === -1, 'bearStats')
ok(JUMP_BEAR.short.primary.borrow === 0.3 && JUMP_BEAR.short.primary.stop === 1 && JUMP_BEAR.put.primary === 126 && JUMP_BEAR.spread.horizon === 63, 'pre-registered constants')
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
