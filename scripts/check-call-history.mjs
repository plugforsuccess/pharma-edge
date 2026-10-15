// npm run callhistory:check — src/utils/callHistory.js
import { callPath, callHistory, anyDayHistory, callStats, simulateCall, breakevenMoves, CALL_HORIZONS } from '../src/utils/callHistory.js'
import { trailingVol, bsCall } from '../src/utils/replay.js'
let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL', name) } }
const day = (i) => new Date(Date.UTC(2023, 0, 2) + Math.floor(i * 7 / 5) * 86400e3).toISOString().slice(0, 10)
// Zig-zag stock rising 0.2%/bar.
const bars = Array.from({ length: 600 }, (_, i) => { const c = 100 * Math.exp(0.002 * i) * (1 + (i % 2 ? 0.01 : -0.01)); return { t: day(i), o: c, h: c * 1.01, l: c * 0.99, c } })
const vols = trailingVol(bars.map((b) => b.c), 60)
const p = callPath(bars, vols, 100)
ok('path has four horizons', p && p.call.length === 4 && p.stock.length === 4)
ok('rising stock → call up and more than the stock at 12M', p.call[3] > p.stock[3] && p.stock[3] > 0)
ok('no vol yet → null', callPath(bars, vols, 10) === null)
const entries = bars.map((_, i) => i === 100 || i === 400 || i === 590)
const hist = callHistory(bars, entries, { vols })
ok('one path per signal', hist.length === 3 && hist[0].t === bars[100].t)
const st = callStats(hist)
ok('late signals drop out of long horizons', st[0].n === 2 && st[3].n === 1)
ok('stats fields', ['avg', 'median', 'win', 'badq', 'worst', 'best', 'stock'].every((k) => k in st[1]))
const any = anyDayHistory(bars, { vols })
ok('any-day samples every 5th bar', any.length > 100 && any.length < 110)
// Simulator: flat stock loses time value; +30% gains; 12M worth less than 1M at the same move.
const trade = { strike: 90, cost: bsCall(100, 90, 2, 0.3) * 1.02, vol: 0.3, expiry: '2028-10-15' }
const sim = simulateCall({ S: 100, trade, asOf: '2026-10-15' })
const cell = (h, m) => sim[h].cells.find((c) => Math.abs(c.move - m) < 1e-9)
ok('flat stock → small loss at 1M, bigger at 12M', cell(0, 0).ret < 0 && cell(3, 0).ret < cell(0, 0).ret)
ok('+30% → gain', cell(1, 0.3).ret > 0.3)
ok('P&L per contract = (value − cost) × 100', Math.abs(cell(2, 0.1).pnl - (cell(2, 0.1).value - trade.cost) * 100) < 1e-9)
const be = breakevenMoves({ S: 100, trade, asOf: '2026-10-15' })
ok('break-even move rises with time', be[0].move > 0 && be[3].move > be[0].move)
ok('horizons 1M/3M/6M/12M', CALL_HORIZONS.map((h) => h[0]).join() === '1M,3M,6M,12M')
console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
