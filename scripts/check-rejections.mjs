import { rejectionLevels, swings, atrAt, REJECTION } from '../src/utils/rejections.js'
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
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
