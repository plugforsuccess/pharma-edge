import { simulate, entryFacts, exitedEarly, isRunUp, POLICIES, EXIT } from '../src/utils/exitPolicies.js'
let pass = 0, fail = 0
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m) } }
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e
const P = Object.fromEntries(POLICIES.map((p) => [p.key, p]))
const mk = (closes, opens) => closes.map((c, i) => ({ o: opens?.[i] ?? c, h: c, l: c, c }))
const S = 1 - EXIT.slip
// Up to 2× by session 40, then a slide to 1.2×.
const path = [10]; for (let k = 1; k <= 40; k++) path.push(10 + k * 0.25); for (let k = 1; k <= 80; k++) path.push(20 - k * 0.1); for (let k = 0; k < 300; k++) path.push(12)
const b = mk(path)
const hold = simulate(b, 0, P.hold)
ok(near(hold.R, 12 * S / 10 - 1) && hold.exitIdx === 120, 'hold sells at the close of t+120')
const tr = simulate(b, 0, P.trail25)
// peak 20, trail triggers at close ≤ 15 → session 90 (20 − 50·0.1 = 15), fills next open (14.9)
ok(tr.exitIdx === 91 && near(tr.R, 14.9 * S / 10 - 1), `25% trail: out the open after the first close 25% under the peak (${tr.exitIdx}, ${tr.R.toFixed(4)})`)
const th = simulate(b, 0, P.thirds)
// ⅓ at the open after the first close ≥ 15 (k=20 → 15.0 at index 20, fill open 21 = 15.25), ⅓ after ≥ 20 (index 40, fill 41 = 19.9), rest on the trail at 14.9
ok(near(th.R, (15.25 / 3 + 19.9 / 3 + 14.9 / 3) * S / 10 - 1, 1e-9), `thirds: two targets and the runner on the trail (${th.R.toFixed(4)})`)
// Stage trail tightens and never loosens.
const st = Array(b.length).fill('clear'); for (let i = 40; i < 45; i++) st[i] = 'distribution'
const sg = simulate(b, 0, P.stage, st)
// after the Distribution days the trail is 15%: exit at the first close ≤ 17 → index 70 (20 − 30·0.1), fill 71 = 16.9
ok(sg.exitIdx === 71 && near(sg.R, 16.9 * S / 10 - 1), `stage trail tightens to 15% and stays there (${sg.exitIdx})`)
const sgClear = simulate(b, 0, P.stage, Array(b.length).fill('clear'))
ok(sgClear.exitIdx === tr.exitIdx && near(sgClear.R, tr.R), 'stage trail under Clear equals the 25% trail')
const ts = simulate(b, 0, P.thirdsStage, st)
ok(near(ts.R, (15.25 / 3 + 19.9 / 3 + 16.9 / 3) * S / 10 - 1), 'thirds + stage trail')
// Gap down fills at the open, not the stop level.
const gap = [...path.slice(0, 41)]; gap.push(19.9, 12, 12); for (let k = 0; k < 200; k++) gap.push(12)
const gb = mk(gap, gap.map((c, i) => (i === 42 ? 11 : c)))
const gt = simulate(gb, 0, P.trail25)
ok(gt.exitIdx === 43 && near(gt.R, 12 * S / 10 - 1), 'a gap is filled at the next open')
// Facts
const f = entryFacts(b, 0)
ok(near(f.G, 1.0) && f.dbl === 40, 'peak gain and the first 2× close')
ok(exitedEarly(tr, f) === false, 'the trail exited after the double, not early')
const early = simulate(b, 0, P.stage, Array(b.length).fill('broken'))
ok(early.exitIdx < 40 || early.exitIdx > 40, 'broken-stage trail exits on a 10% give-back')
const pre = [10, 10.5, 9.4, 10.6, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]
const pb = mk([...pre, ...Array(300).fill(21)])
const ef = entryFacts(pb, 0), ps = simulate(pb, 0, P.stage, Array(pb.length).fill('broken'))
ok(ef.dbl === 13 && ps.exitIdx === 3 && exitedEarly(ps, ef), 'a 10% trail that sells before the double counts as an early exit')
ok(simulate(b, b.length - 50, P.hold) === null, 'incomplete horizon is null')
// Entry rule
const ru = mk(Array.from({ length: 70 }, (_, i) => (i < 60 ? 10 : 15.1)))
ok(isRunUp(ru, 65) && !isRunUp(mk(Array(70).fill(10)), 65), 'run-up entry: close ≥ 1.5× the 60-session low')
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
