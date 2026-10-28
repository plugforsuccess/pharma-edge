import { RULES, featureSeries, lastCloseIndex, outcome, vsNormal, groupStats, bootDiff, verdict } from './lib.mjs'
let pass = 0, fail = 0
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m) } }
const day = (i) => new Date(Date.UTC(2020, 0, 1) + i * 86400e3).toISOString().slice(0, 10)
const bars = Array.from({ length: 400 }, (_, i) => { const c = 100 + i * 0.5 + (i % 2 ? 1 : -1); return { t: day(i), o: c, h: c + 1, l: c - 1, c } })
const f = featureSeries(bars)
ok(f.at(399).above200 > 0 && f.at(399).above50 > 0, 'features: uptrend sits above its averages')
ok(lastCloseIndex(bars, day(300), 'AMC') === 300 && lastCloseIndex(bars, day(300), 'BMO') === 299, 'L: AMC same session, BMO previous')
const gapDay = { ...bars[301] }; const holed = bars.filter((_, i) => i !== 301)
ok(lastCloseIndex(holed, day(301), 'BMO') === 300, 'L: BMO report on a missing day → the session before')
// Drop to the 50-day after L = 350.
const b2 = bars.map((b) => ({ ...b })); const s50 = f.s50[351]
b2[351] = { ...b2[351], o: b2[350].c * 0.9, l: s50 - 1, c: b2[350].c * 0.9 }
const f2 = featureSeries(b2)
const spy = new Map(b2.map((b) => [b.t, 100]))
const o = outcome(b2, 350, f2, spy)
ok(o && Math.abs(o.day1 + 0.1) < 1e-9 && o.day1x === o.day1 && o.down && o.reach50 && o.reach20, 'outcome: −10%, SPY flat, reached the 50-day and 20-day')
ok(outcome(b2, 396, f2, spy) === null, 'outcome: needs 5 sessions after')
ok(vsNormal([0.02, -0.04, 0.03], 0.1) === null && Math.abs(vsNormal([0.02, -0.04, 0.03, 0.05], -0.07) - 0.07 / 0.035) < 1e-9, 'vsNormal: ≥ 4 prior reports, median of |moves|')
const row = (t, x, extra = {}) => ({ t, vsNormal: 1, out: { day1: x, day1x: x, day5x: x, down: x < 0, reach50: !!extra.r, reach20: !!extra.r } })
const ext = [], not = []
for (const y of RULES.pass.years) for (let k = 0; k < 40; k++) { const d = `${y}-0${1 + (k % 9)}-1${k % 9}`; ext.push(row(d, -0.03 + (k % 5) * 0.004, { r: k % 2 === 0 })); not.push(row(d, 0.005 + (k % 5) * 0.004 - 0.008, { r: k % 6 === 0 })) }
const v = verdict(ext, not)
ok(v.verdict === 'pass' && v.won === 10 && v.boot.hi < 0, 'verdict: a clear effect in every year passes')
ok(verdict(ext.slice(0, 200), not).verdict === 'inconclusive', 'verdict: < 300 extended is inconclusive')
const flip = ext.map((r) => (r.t.startsWith('2016') || r.t.startsWith('2017') || r.t.startsWith('2018') || r.t.startsWith('2019') ? { ...r, out: { ...r.out, day1x: 0.05 } } : r))
ok(verdict(flip, not).checks.years === false, 'verdict: losing 4 years fails the year rule')
const g = groupStats([row('2020-01-01', -0.1), row('2020-01-02', 0.02)])
ok(g.n === 2 && g.down === 0.5 && Math.abs(g.day1xMedian + 0.04) < 1e-9 && g.fell5 === 0.5, 'groupStats')
ok(bootDiff([], not).diff === null, 'bootDiff: empty group')
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
