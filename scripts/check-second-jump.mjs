import { eventFlags, listedFlags, jumpOutcome, countedJumps, wasListed, jumpStats, secondJumpVerdict, SECOND_JUMP } from '../src/utils/secondJump.js'
import { catalystRow, shortsRow, HOLDING_RISK } from '../src/utils/holdingRisks.js'
let pass = 0, fail = 0
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m) } }
const day = (i) => new Date(Date.UTC(2024, 0, 1) + i * 86400e3).toISOString().slice(0, 10)
// 400 flat bars at $10, volume 1M; a jump at 260 to $12 on 5M; fade to $9 for 40 sessions; a second jump at 320.
const bars = Array.from({ length: 600 }, (_, i) => ({ t: day(i), o: 10, h: 10.1, l: 9.9, c: 10, v: 1e6 }))
bars[260] = { ...bars[260], c: 12, h: 12.2, v: 5e6 }
for (let i = 261; i < 320; i++) bars[i] = { ...bars[i], o: 8.5, h: 8.6, l: 8.4, c: 8.5 }
bars[320] = { ...bars[320], o: 8.5, h: 10.4, l: 9, c: 10.2, v: 4e6 }
for (let i = 321; i < 600; i++) bars[i] = { ...bars[i], o: 10.2, h: 10.3, l: 10.1, c: 10.2 }
bars[321].o = 10
const shorts = [{ date: day(255), shares: 1e6 }, { date: day(300), shares: 1.4e6 }]
const ev = eventFlags(bars)
ok(ev[260] && ev[320] && ev.filter(Boolean).length === 2, 'two event days')
const lst = listedFlags(bars, ev, shorts)
// cross-check against the shipped helpers on a lit day and an unlit day
for (const i of [290, 310, 270, 330]) {
  const cr = catalystRow(bars, i), sr = shortsRow(shorts, bars, i)
  const ref = !!(cr && cr.sessionsBelow >= HOLDING_RISK.belowSessions && sr && sr.siChange >= HOLDING_RISK.siRise && sr.priceChange != null && sr.priceChange <= -HOLDING_RISK.priceDrop)
  ok(lst[i] === ref, `listedFlags matches the shipped scan at ${i} (${lst[i]} vs ${ref})`)
}
ok(lst[310] === true && lst[270] === false, 'lit 50 sessions after the jump, not 10 after')
ok(wasListed(lst, 320) && !wasListed(lst, 260), 'second jump is listed, first is not')
ok(JSON.stringify(countedJumps(ev, 0)) === '[260,320]', 'both jumps counted (60 apart)')
const ev2 = ev.slice(); ev2[270] = true
ok(JSON.stringify(countedJumps(ev2, 0)) === '[260,320]', 'a jump 10 sessions after a counted one is skipped')
const o = jumpOutcome(bars, 320)
ok(o && o.entry === 10 && Math.abs(o.ret[126] - 0.02) < 1e-9, 'entry at next open, 126-session return')
ok(o.hit === false && o.fell === false && o.doubled === false, 'no target, no fall, no double')
ok(jumpOutcome(bars, 590) === null, 'incomplete horizon is null')
const up = bars.map((b) => ({ ...b })); for (let i = 330; i < 600; i++) up[i] = { ...up[i], c: 15, h: 15, l: 15 }
const ou = jumpOutcome(up, 320)
ok(ou.hit && Math.abs(ou.target - 0.5) < 1e-9 && ou.daysToHit === 9, '+40% target exits at the first close past it')
const mk = (r126, fell) => ({ ret: { 21: 0, 63: 0, 126: r126 }, target: r126, hit: false, fell, doubled: false })
const L = jumpStats(Array.from({ length: 120 }, () => mk(0.15, false))), A = jumpStats(Array.from({ length: 300 }, () => mk(0.0, false))), B = jumpStats(Array.from({ length: 300 }, (_, i) => mk(0, i % 4 === 0)))
ok(secondJumpVerdict(L, A, B) === 'pass', 'pass: median +15 pts, no falls')
ok(secondJumpVerdict(jumpStats(Array.from({ length: 50 }, () => mk(0.5, false))), A, B) === 'inconclusive', 'under 100 is inconclusive')
ok(secondJumpVerdict(jumpStats(Array.from({ length: 120 }, (_, i) => mk(0.15, i % 2 === 0))), A, B) === 'fail', 'fail: falls above the any-day rate')
ok(SECOND_JUMP.horizon === 126 && SECOND_JUMP.gap === 21, 'pre-registered constants')
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
