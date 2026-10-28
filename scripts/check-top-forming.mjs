import { topFormingSeries, quadFit, rsiSeries, swingHighs, STAGE_RANK } from '../src/utils/topForming.js'
import { TOP_FORMING } from '../src/utils/topFormingConfig.js'
let pass = 0, fail = 0
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m) } }
const day = (i) => { const d = new Date(Date.UTC(2018, 0, 1)); let k = 0; while (k < i) { d.setUTCDate(d.getUTCDate() + 1); if (d.getUTCDay() % 6) k++ } return d.toISOString().slice(0, 10) }
const mk = (closes, opts = {}) => closes.map((c, i) => ({ t: day(i), o: opts.o?.[i] ?? (i ? closes[i - 1] : c), h: Math.max(c, i ? closes[i - 1] : c) * (opts.hw?.[i] ?? 1.005), l: Math.min(c, i ? closes[i - 1] : c) * (opts.lw?.[i] ?? 0.995), c, v: opts.v?.[i] ?? 1e6 }))
// quad fit
const q = quadFit(Array.from({ length: 30 }, (_, x) => 1 + 0.1 * x + 0.02 * x * x))
ok(q && Math.abs(q.c - 0.02) < 1e-9 && q.r2 > 0.999, 'quadratic fit recovers c and R²')
// RSI bounds
const r = rsiSeries(Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5))
ok(r.slice(15).every((x) => x > 0 && x < 100), 'RSI in (0, 100)')

// 1. Flat 300 days then a parabolic run of 40 days: A1 and A2 fire, stage Extended.
const flat = Array(300).fill(10)
const para = Array.from({ length: 40 }, (_, k) => 10 * Math.exp(0.002 * k * k + 0.005 * k))
const run = mk([...flat, ...para])
const s1 = topFormingSeries(run)
const L = run.length - 1
ok(s1.signals.A1[L] > 0.9, `A1 extension strong at the top (${s1.signals.A1[L]?.toFixed(2)}, ext ${s1.ext[L]?.toFixed(2)})`)
ok(s1.signals.A2[L] === 1, 'A2 parabolic fires on an accelerating run')
ok(s1.signals.A2[300 + 5] === 0, 'A2 not yet at the start of the run')
const linear = mk([...flat, ...Array.from({ length: 40 }, (_, k) => 10 + 0.2 * k)])
ok(topFormingSeries(linear).signals.A2.at(-1) === 0, 'A2 does not fire on a straight-line trend')
// With C not built, the score is renormalised over A, B, E: extension alone tops out near 33 (< 35),
// so a run with no exhaustion signal stays Clear (the committed rule); one climax bar lifts it to Extended.
ok(s1.score[L] < 35 && s1.stage[L] === 'clear', `extension alone stays Clear under the rule (score ${s1.score[L]?.toFixed(1)})`)

// 2. Climax bar: 4× volume, close in the bottom third.
const cl = [...flat, ...para.slice(0, 30)]
const v = cl.map(() => 1e6); v[cl.length - 1] = 4e6
const hw = cl.map(() => 1.005); hw[cl.length - 1] = 1.08
const cb = mk(cl, { v, hw }); cb[cb.length - 1].c = cb[cb.length - 1].l + 0.1 * (cb[cb.length - 1].h - cb[cb.length - 1].l)
ok(topFormingSeries(cb).signals.B1.at(-1) === 1, 'B1 climax: 4× volume with the close in the bottom third')
const cb2 = mk(cl, { v: cl.map(() => 1e6) })
ok(topFormingSeries(cb2).signals.B1.at(-1) === 0, 'B1 quiet without the volume')
const scb = topFormingSeries(cb)
ok(scb.stage.at(-1) === 'extended', `extension plus a climax bar reads Extended (score ${scb.score.at(-1)?.toFixed(1)}, ${scb.stage.at(-1)})`)

// 3. Distribution days: 6 down days on rising volume in the last 25.
const dc = [...flat, ...Array.from({ length: 25 }, (_, k) => 10 + (k % 2 ? -0.1 : 0.15) * 1)]
const dv = dc.map((_, i) => 1e6 + (i % 2 ? 5e5 : 0) + i)
const sd = topFormingSeries(mk(dc, { v: dv }))
ok(sd.signals.B2.at(-1) === 1, `B2 counts 6+ distribution days (${sd.signals.B2.at(-1)})`)

// 4. Divergence: two swing highs, the second higher in price, RSI lower.
const dvc = [...flat]
for (let k = 0; k < 20; k++) dvc.push(10 + k * 0.5)            // steep rise to 19.5
for (let k = 0; k < 10; k++) dvc.push(19.5 - k * 0.4)           // pullback
for (let k = 0; k < 20; k++) dvc.push(15.5 + k * 0.22)          // slow rise to ~19.7 (higher high, weaker RSI)
for (let k = 0; k < 8; k++) dvc.push(19.7 - k * 0.3)
const sdv = topFormingSeries(mk(dvc))
ok(sdv.signals.B3.at(-1) >= 0.5, `B3 divergence: higher high on weaker RSI (${sdv.signals.B3.at(-1)})`)

// 5. Exhaustion gap: extended, gap up 8%, filled within 3 sessions.
const eg = [...flat, ...Array.from({ length: 30 }, (_, k) => 10 * (1 + k * 0.03))] // ext ~ +80%
const last = eg.at(-1); eg.push(last * 1.08, last * 1.02, last * 0.98)
const ego = eg.map((c, i) => (i ? eg[i - 1] : c)); ego[eg.length - 3] = last * 1.08
const egb = mk(eg, { o: ego })
ok(topFormingSeries(egb).signals.B4.at(-1) === 1, 'B4 exhaustion gap filled within 3 sessions')

// 6. Lower highs after the 52-week high, then a trend break and a weekly breakdown.
const lh = [...flat]
for (let k = 0; k < 40; k++) lh.push(10 * (1 + k * 0.025))    // to ~19.75 (ext > 30%)
const peaks = [19.75, 18.5, 17.5]
for (const p of peaks.slice(1)) { for (let k = 0; k < 8; k++) lh.push(lh.at(-1) - 0.25); for (let k = 0; k < 8; k++) lh.push(lh.at(-1) + (p - lh.at(-1)) / (8 - k)) }
for (let k = 0; k < 25; k++) lh.push(lh.at(-1) * 0.985)        // breakdown
const slh = topFormingSeries(mk(lh))
const at = lh.length - 1
ok(slh.signals.B5.slice(at - 30).some((x) => x === 1), 'B5 lower highs after the 52-week high')
ok(slh.signals.E1[at] === 1, 'E1 close under the 50-day after a +30% extension')
ok(slh.signals.E2[at] === 1, 'E2 weekly close under the 10-week')
// 7. Failed retest: break, rally to the 50-day, fail, new low.
const fr = [...flat]
for (let k = 0; k < 40; k++) fr.push(10 * (1 + k * 0.025))
for (let k = 0; k < 20; k++) fr.push(fr.at(-1) * 0.975)        // break below the 50-day
const sma50At = (arr) => arr.slice(-50).reduce((a, b) => a + b, 0) / 50
for (let k = 0; k < 4; k++) fr.push(fr.at(-1) + (sma50At(fr) * 0.995 - fr.at(-1)) / (4 - k)) // rally to just under the 50-day close
const frh = fr.map(() => 1.005); frh[fr.length - 1] = sma50At(fr) / fr.at(-1) * 1.01            // the high touches it
for (let k = 0; k < 12; k++) { fr.push(fr.at(-1) * 0.97); frh.push(1.005) }  // fail, then a close under every close since the break
const sfr = topFormingSeries(mk(fr, { hw: frh }))
ok(sfr.signals.E3.at(-1) === 1, 'E3 failed retest then a new low')
// 8. Stage path on the breakdown: Trend broken needs Distribution in the prior 20 sessions.
const stages = new Set(slh.stage.filter(Boolean))
ok(!slh.stage.some((st, i) => st === 'broken' && !slh.stage.slice(Math.max(0, i - 20), i).some((p) => p === 'distribution' || p === 'broken')), 'Trend broken only follows Distribution')
ok(slh.score.every((x) => x == null || (x >= 0 && x <= 100)), 'score in 0–100')
ok(['clear', 'extended', 'distribution', 'broken'].includes([...stages][0]), `stages are the descriptive names (${[...stages].join(', ')})`)

// 9. No look-ahead: values on day t are identical when later bars are cut off.
const rng = (() => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647 })()
const walk = []; let p = 10
for (let i = 0; i < 700; i++) { p *= 1 + (rng() - 0.48) * 0.06; walk.push(p) }
const wb = mk(walk, { v: walk.map(() => 1e6 * (0.5 + rng())) })
const full = topFormingSeries(wb)
let same = true
for (const t of [300, 360, 450, 551, 640, 699]) {
  const part = topFormingSeries(wb.slice(0, t + 1))
  for (const k of Object.keys(full.signals)) if (full.signals[k][t] !== part.signals[k][t]) { same = false; console.log('lookahead', k, t, full.signals[k][t], part.signals[k][t]) }
  if (full.score[t] !== part.score[t] || full.stage[t] !== part.stage[t]) { same = false; console.log('lookahead score/stage', t) }
}
ok(same, 'no look-ahead: every signal, score and stage on day t uses bars through t only')
ok(TOP_FORMING.weights.D === 0 && TOP_FORMING.stageNames.broken === 'Trend broken' && !('euphoria' in TOP_FORMING.stageNames), 'config: D at 0, descriptive stage names')
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
