import { exitOf, exitStats } from '../src/utils/delisted.js'
let pass = 0, fail = 0
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m) } }
const r = (form, date, items = []) => ({ form, date, items })
const bk = exitOf([r('8-K', '2023-01-10', ['3.01']), r('8-K', '2023-05-01', ['1.03']), r('25-NSE', '2023-05-20')], 2022)
ok(bk.reason === 'bankruptcy' && bk.noticeToDelist === 130 && bk.floatToDelist === 324, 'bankruptcy: notice → delist and float mid-year → delist in days')
const acq = exitOf([r('DEFM14A', '2024-02-01'), r('25', '2024-04-01'), r('15-12B', '2024-04-11')], 2023)
ok(acq.reason === 'acquired' && acq.delisted === '2024-04-01' && acq.noticeToDelist === null, 'acquired: first Form 25, no notice')
ok(exitOf([r('15-12G', '2025-03-03')], 2024).reason === 'delisted, other', 'Form 15 alone counts as the delisting date')
ok(exitOf([r('8-K', '2025-01-01', ['3.01'])], 2024).reason === 'no delisting filing', 'a notice without a Form 25 / 15 is not a delisting')
const st = exitStats([bk, acq, exitOf([r('25-NSE', '2023-06-30')], 2022)])
ok(st.n === 3 && st.by.bankruptcy === 1 && st.by.acquired === 1 && st.floatToDelist.n === 3 && st.floatToDelist.median === 324, 'exitStats: counts and median')
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
