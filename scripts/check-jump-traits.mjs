import { jumpTraits, jumpOutcome6, traitTable, traitHolds } from '../src/utils/jumpTraits.js'
let pass = 0, fail = 0
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m) } }
const day = (i) => new Date(Date.UTC(2024, 0, 1) + i * 86400e3).toISOString().slice(0, 10)
const bars = Array.from({ length: 400 }, (_, i) => ({ t: day(i), o: 4, h: 4.1, l: 3.9, c: 4, v: 1e6 }))
bars[250] = { t: day(250), o: 4, h: 6.1, l: 4, c: 6, v: 12e6 }
bars[251] = { ...bars[251], c: 6.5, h: 6.6 }
bars[255] = { ...bars[255], c: 5 }
const tr = jumpTraits(bars, 250, { filings: [{ form: '8-K', date: day(249), items: ['2.02'] }, { form: '424B5', date: day(200), items: [] }], siPct: 0.2, runwayQ: 3, binary: true, spyUp: true, jumps: bars.map((_, i) => i === 220) })
ok(tr.earnings === 'yes' && tr.size === '50%+' && tr.volume === '10×+' && tr.closeHigh === 'yes', 'jump-day traits')
ok(tr.price === '$5+' && tr.shorts === '15%+' && tr.runway === '< 4 qtrs' && tr.shelf === 'yes' && tr.priorJump === 'yes', 'context traits')
ok(tr.nextDay === 'yes' && tr.week === 'no', 'known-later traits')
ok(jumpTraits(bars, 100) === null, 'too little history → null')
ok(jumpTraits(bars, 250, {}).earnings === null, 'no filings → unknown, not "no"')
const o = jumpOutcome6(bars, 250)
ok(o && o.ret === 4 / 6 - 1 && !o.gained && jumpOutcome6(bars, 300) === null, 'outcome at 126 sessions')
const rows = [...Array(40)].map((_, i) => ({ traits: { earnings: i < 20 ? 'yes' : 'no' }, out: { ret: i < 20 ? 0.2 : -0.2, gained: i < 20, doubled: false } }))
const t = traitTable(rows)
ok(t.all.gained === 0.5 && t.by.earnings.yes.gained === 1 && Math.abs(t.by.earnings.yes.lift - 0.5) < 1e-9, 'table + lift')
ok(traitHolds({ n: 40, lift: 0.1 }, { n: 35, lift: 0.09 }) === 'holds · more gain' && traitHolds({ n: 40, lift: 0.1 }, { n: 35, lift: -0.1 }) === 'no' && traitHolds({ n: 10, lift: 0.3 }, { n: 35, lift: 0.3 }) === 'too few', 'holds rule')
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
