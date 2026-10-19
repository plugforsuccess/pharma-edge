// npm run riskflags:check — src/utils/riskFlags.js
import { leaderFlags } from '../src/utils/riskFlags.js'
let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL', name) } }
const keys = (f) => f.map((x) => x.key).join(',')

ok('no traits → no flags', leaderFlags({ traits: null }).length === 0)
ok('calm leader → no flags', leaderFlags({ traits: { vs200: 0.15, off20: 0.02, theme: { name: 'Software' } }, asOf: '2026-10-19' }).length === 0)
const vlo = leaderFlags({ traits: { vs200: 0.62, off20: 0.01, theme: { name: 'Refiners' } }, asOf: '2026-10-19' })
ok('very stretched refiner', keys(vlo) === 'stretched,commodity' && vlo[0].tone === 'red')
const e = leaderFlags({ traits: { vs200: 0.2 }, earnings: { date: '2026-10-21', time: 'AMC' }, asOf: '2026-10-19' })
ok('earnings in 2 days, red, after the close', e[0]?.key === 'earnings' && e[0].tone === 'red' && /after the close/.test(e[0].body))
ok('earnings tomorrow wording', /tomorrow/.test(leaderFlags({ traits: { vs200: 0.1 }, earnings: { date: '2026-10-20' }, asOf: '2026-10-19' })[0].title))
ok('earnings past or far → none', leaderFlags({ traits: { vs200: 0.1 }, earnings: { date: '2026-12-01' }, asOf: '2026-10-19' }).length === 0
  && leaderFlags({ traits: { vs200: 0.1 }, earnings: { date: '2026-10-10' }, asOf: '2026-10-19' }).length === 0)
ok('pullback flag at 10%+', keys(leaderFlags({ traits: { vs200: 0.2, off20: 0.12 }, asOf: '2026-10-19' })) === 'pullback')
ok('crowded group at 3+', keys(leaderFlags({ traits: { vs200: 0.2, theme: { name: 'Chips & AI' } }, groupSize: 6 })) === 'crowded')
ok('no advice words', [...vlo, ...e].every((f) => !/\b(buy|sell|hold)\b/i.test(f.title + f.body)))
console.log(`${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
