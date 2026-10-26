// npm run basketrecord:check — src/utils/basketRecord.js
import { basketIndex } from '../src/utils/basketRecord.js'
let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL', name) } }
ok('empty → null', basketIndex([]) === null)
const rows = [
  { as_of: '2026-10-26', tickers: ['A', 'B'], closes: [100, 50], spy_close: 500, rebalanced: true },
  { as_of: '2026-10-27', tickers: ['A', 'B'], closes: [110, 45], spy_close: 505, rebalanced: false },
  { as_of: '2026-11-02', tickers: ['A', 'C'], closes: [121, 10], spy_close: 510, rebalanced: true },
  { as_of: '2026-11-03', tickers: ['A', 'C'], closes: [121, 11], spy_close: 510, rebalanced: false },
]
const r = basketIndex(rows)
ok('one day: equal-weight mean of member moves (+10%, −10% → 0%)', Math.abs(r.series[1].basket - 0) < 1e-9 && Math.abs(r.series[1].spy - 0.01) < 1e-9)
ok('rebalance day: the old members carry the leg (A +10%, B unknown → +10%)', Math.abs(r.series[2].basket - 0.10) < 1e-9)
ok('after the rebalance the new members carry it (A 0%, C +10% → +5%)', Math.abs(r.basket - (1.10 * 1.05 - 1)) < 1e-9)
ok('summary', r.start === '2026-10-26' && r.days === 4 && r.rebalances === 2 && r.members.join() === 'A,C' && Math.abs(r.spy - 0.02) < 1e-9)
console.log(`${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
