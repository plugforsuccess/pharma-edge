import { rejectionLevels, nearestLevels, swings, atrAt, REJECTION } from '../src/utils/rejections.js'
let pass = 0, fail = 0
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m) } }
const day = (i) => new Date(Date.UTC(2025, 0, 1) + i * 86400e3).toISOString().slice(0, 10)
// A range between 90 and 110: price rises to 110 and is rejected with upper wicks, falls to 90 and bounces.
const bars = []
for (let i = 0; i < 160; i++) {
  const ph = i % 40, up = ph < 20, base = up ? 91 + ph : 109 - (ph - 20)
  let o = base - 0.5, c = base + 0.5, h = c + 0.3, l = o - 0.3
  if (!up) { o = base + 0.5; c = base - 0.5; h = o + 0.3; l = c - 0.3 }
  if (ph === 19) { o = 108.6; c = 108.4; h = 110; l = 108.2 }   // shooting star at 110
  if (ph === 39) { o = 91.4; c = 91.6; h = 91.8; l = 90 }       // hammer at 90
  bars.push({ t: day(i), o, h, l, c, v: 1e6 })
}
const atr = atrAt(bars)
ok(atr[13] != null && atr[12] == null && atr.at(-1) > 0, 'ATR warms up over 14 bars')
const sw = swings(bars)
ok(sw.some((s) => s.side === 'high' && s.price === 110) && sw.some((s) => s.side === 'low' && s.price === 90), 'swing highs at 110, swing lows at 90')
const lv = rejectionLevels(bars)
const top = lv.find((l) => Math.abs(l.price - 110) < 1), bot = lv.find((l) => Math.abs(l.price - 90) < 1)
ok(top && top.fromAbove >= 3 && top.fromBelow === 0, `110 is a ceiling rejected ${top?.fromAbove}×`)
ok(bot && bot.fromBelow >= 3 && bot.fromAbove === 0, `90 is a floor rejected ${bot?.fromBelow}×`)
ok(top.role === 'resistance' && bot.role === 'support', 'roles by where the last close sits')
ok(lv.every((l) => l.touches >= REJECTION.minTouches), 'only levels with 2+ rejections')
ok(lv[0].touches >= lv.at(-1).touches, 'strongest first')
// A plain trend with no wicks has no rejection levels.
const trend = Array.from({ length: 120 }, (_, i) => ({ t: day(i), o: 100 + i, h: 101 + i, l: 100 + i, c: 101 + i, v: 1 }))
ok(rejectionLevels(trend).length === 0, 'a wickless trend has none')
ok(rejectionLevels(bars.slice(0, 10)).length === 0, 'too few bars → none')
// Touches on neighbouring bars count once.
const twin = bars.map((b) => ({ ...b }))
for (const k of [19, 59, 99, 139]) twin[k + 1] = { ...twin[k], t: twin[k + 1].t }
const t2 = rejectionLevels(twin).find((l) => Math.abs(l.price - 110) < 1)
ok(t2 && t2.fromAbove === top.fromAbove, 'back-to-back rejections count once')
// A slow climb of swing highs 1% apart never chains into one wide level.
const stair = []
for (let i = 0; i < 300; i++) { const step = Math.floor(i / 20), ph = i % 20, base = 100 * (1.01 ** step) + (ph < 10 ? ph * 0.05 : (20 - ph) * 0.05); stair.push({ t: day(i), o: base - 0.1, h: base + (ph === 10 ? 1 : 0.15), l: base - 0.3, c: base, v: 1 }) }
const sl = rejectionLevels(stair, { ...REJECTION, minTouches: 1 })
const span = sl.length ? Math.max(...sl.map((l) => l.price)) - Math.min(...sl.map((l) => l.price)) : 0
ok(sl.length >= 5 && span > 10, `swing points 1% apart stay separate levels (${sl.length} levels)`)
// A stock that quadrupled: its old base (24 floor / 26 ceiling, narrow bars) must not
// merge into one level on today's much wider ATR.
const quad = []
for (let i = 0; i < 200; i++) {
  const ph = i % 20, up = ph < 10, base = up ? 24.3 + ph * 0.15 : 25.7 - (ph - 10) * 0.15
  let o = base - 0.05, c = base + 0.05, h = c + 0.03, l = o - 0.03
  if (!up) { o = base + 0.05; c = base - 0.05; h = o + 0.03; l = c - 0.03 }
  if (ph === 9) { o = 25.75; c = 25.7; h = 26; l = 25.65 }
  if (ph === 19) { o = 24.25; c = 24.3; h = 24.35; l = 24 }
  quad.push({ t: day(i), o, h, l, c, v: 1 })
}
for (let i = 0; i < 120; i++) { const b = 26 + i * 0.7; quad.push({ t: day(200 + i), o: b, h: b + 3 + (i % 3), l: b - 3, c: b + 1, v: 1 }) }
const ql = rejectionLevels(quad)
ok(ql.some((l) => Math.abs(l.price - 24) < 0.3) && ql.some((l) => Math.abs(l.price - 26) < 0.3), `old 24 floor and 26 ceiling stay separate on per-bar tolerance (${ql.map((l) => l.price.toFixed(2)).join(', ')})`)
// The chart shows the nearest 3 each side within 35%.
const fake = [90, 95, 99, 101, 104, 108, 112, 140, 60].map((price, k) => ({ price, touches: 2, role: price >= 100 ? 'resistance' : 'support', last: k }))
const nl = nearestLevels(fake, 100)
ok(nl.map((l) => l.price).join(',') === '101,104,108,99,95,90', `nearest 3 above and below, far ones dropped (${nl.map((l) => l.price).join(',')})`)
// The window: counting from a later bar gives fewer touches; a window after the range has none at 110.
const half = rejectionLevels(bars, REJECTION, { from: 80 }).find((l) => Math.abs(l.price - 110) < 1)
ok(half && half.fromAbove < top.fromAbove && half.first >= 80, `a shorter window counts only its own rejections (${half?.fromAbove} vs ${top.fromAbove})`)
ok(rejectionLevels(quad, REJECTION, { from: 200 }).every((l) => l.price > 27), 'a window after the old base shows none of its levels')
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
