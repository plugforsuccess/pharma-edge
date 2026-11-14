import { reportOnJump, nextReport, isFresh, recordPath, recordSummary, monthLabel } from '../src/utils/jumpRecord.js'
let pass = 0, fail = 0
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m) } }
const f8 = (date, items = ['2.02']) => ({ form: '8-K', date, items })
const filings = [f8('2026-05-12'), f8('2026-08-11'), f8('2026-11-09'), f8('2026-11-10', ['8.01']), { form: '424B5', date: '2026-11-10', items: [] }]
ok(reportOnJump(filings, '2026-11-10') === '2026-11-09', 'a 2.02 filed the evening before the jump counts')
ok(reportOnJump(filings, '2026-11-20') === null, 'no report near the jump → null')
ok(reportOnJump([f8('2026-11-10', ['8.01'])], '2026-11-10') === null, 'other 8-K items are not earnings')
ok(JSON.stringify(nextReport(['2026-11-05', '2027-02-10'], filings, '2026-11-10')) === '{"date":"2027-02-10","est":false}', 'calendar date after the jump wins')
const est = nextReport([], filings, '2026-11-10')
ok(est.est === true && est.date === '2027-02-08', `no calendar → last 2.02 + a quarter (${est.date})`)
ok(nextReport([], filings, '2027-03-01').date === '2027-05-10', 'stepped forward past the date')
ok(nextReport([], [], '2026-11-10').date === null, 'no filings → unknown')
ok(isFresh({ event: '2026-11-10' }, '2026-11-14') && !isFresh({ event: '2026-10-01' }, '2026-11-14') && !isFresh(null, '2026-11-14'), 'fresh = within 7 days')
const day = (i) => new Date(Date.UTC(2026, 0, 1) + i * 86400e3).toISOString().slice(0, 10)
const bars = Array.from({ length: 60 }, (_, i) => ({ t: day(i), o: 10, h: 10.5, l: i > 30 ? 7 : 9.5, c: i === 20 ? 12 : i > 30 ? 8 : 10, v: 1 }))
const rp = recordPath(bars, day(20))
ok(rp && rp.path['0.25'] && rp.path['1'] && !rp.path['2'] && rp.last === 8, 'path keys as strings, only months reached')
ok(Math.abs(rp.path['1'].ret - (bars[41].c / 12 - 1)) < 1e-4 && rp.path['1'].low <= rp.path['1'].ret, 'path from the jump close; low ≤ close change')
ok(recordPath(bars, '1999-01-01') === null, 'unknown jump date → null')
const rows = [{ earnings_jump: true, path: { '1': { ret: -0.3, low: -0.35 } } }, { earnings_jump: false, path: { '1': { ret: 0.1, low: -0.05 } } }, { earnings_jump: false, path: {} }]
const s = recordSummary(rows)
ok(s.n === 3 && s.all[1].n === 2 && s.earnings[1].down20 === 1 && s.other[1].below === 0 && s.all[0.25].n === 0, 'summary splits earnings vs other, counts per month')
ok(monthLabel(0.25) === '1W' && monthLabel(0.75) === '3W' && monthLabel(1.5) === '1.5M', 'labels')
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
