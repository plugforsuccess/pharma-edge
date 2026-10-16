// npm run callhistory:check — src/utils/callHistory.js
import { callPath, callHistory, anyDayHistory, callStats, simulateCall, breakevenMoves, CALL_HORIZONS, ATM_MODEL, atmTrade, PLAYS, playModel, playExpiry, playContract, SWING_HOLDS, playSpan, exitTrade, exitHistory, exitStats, SWING_EXIT } from '../src/utils/callHistory.js'
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
const burst = bars.map((_, i) => i >= 200 && i < 215)
ok('a burst of signals in one dip counts once', callHistory(bars, burst, { vols }).length === 1)
ok('signals a month apart count separately', callHistory(bars, bars.map((_, i) => i === 200 || i === 221), { vols }).length === 2)
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
const atm = callPath(bars, vols, 100, ATM_MODEL)
ok('ATM strike = the entry price', Math.abs(atm.strike - bars[100].o) < 1e-9)
ok('ATM costs less and moves more (%) than ITM on a rise', atm.cost < p.cost && atm.call[3] > p.call[3])
const at = atmTrade({ S: 100, trade, asOf: '2026-10-15' })
ok('ATM trade: strike at price, cheaper, delta ~0.6', at.strike === 100 && at.cost < trade.cost && at.delta > 0.5 && at.delta < 0.7)
// Plays: at the money, 1M / 3M / 6M / 12M marked after 1 and 2 weeks, LEAPS after 6 / 12 months.
ok('five plays', PLAYS.map((x) => x.key).join() === '1M,3M,6M,12M,LEAPS')
const m1 = PLAYS[0], lp = PLAYS[4]
const sw = callPath(bars, vols, 100, playModel(m1), m1.holds)
ok('swing path: two holds, ATM strike', sw.call.length === 2 && Math.abs(sw.strike - bars[100].o) < 1e-9)
ok('1M call costs less than the 2-year one', sw.cost < callPath(bars, vols, 100, playModel(lp), lp.holds).cost)
ok('swing stats carry 1W / 2W', callStats(callHistory(bars, entries, { vols, opt: playModel(m1), horizons: m1.holds }), m1.holds).map((x) => x.label).join() === '1W,2W')
ok('expiry is a Friday, near the target', [m1, PLAYS[1], PLAYS[3]].every((pl) => { const e = playExpiry('2026-10-15', pl); const d = new Date(`${e}T00:00:00Z`); const gap = (d - new Date('2026-10-15T00:00:00Z')) / 86400e3; return d.getUTCDay() === 5 && gap >= pl.dte * 0.75 && Math.abs(gap - pl.dte) <= 20 }))
ok('LEAPS expiry is a January', playExpiry('2026-10-15', lp) === '2029-01-19')
ok('1M expiry from Oct 15 = Nov 20', playExpiry('2026-10-15', m1) === '2026-11-20')
const c1 = playContract({ S: 100, vol: 0.3, asOf: '2026-10-15', play: m1 })
ok('ATM contract: strike at price, ~0.5 delta', c1.strike === 100 && c1.delta > 0.48 && c1.delta < 0.6)
const ssim = simulateCall({ S: 100, trade: c1, asOf: '2026-10-15', moves: m1.moves, horizons: SWING_HOLDS })
ok('swing sim: flat after 2 weeks loses more than after 1', ssim[1].cells[2].ret < ssim[0].cells[2].ret && ssim[0].cells[2].ret < 0)
ok('swing sim: +10% in a week more than doubles a 1M ATM call', ssim[0].cells[4].ret > 1)
// History over the call's life: stock vs the ATM call held to expiry, same signals.
ok('spans 1M/3M/6M/12M/2Y', PLAYS.map((x) => x.span).join() === '1M,3M,6M,12M,2Y')
const sp = callStats(callHistory(bars, entries, { vols, opt: playModel(m1), horizons: playSpan(m1) }), playSpan(m1))[0]
ok('span stats carry the stock gain and its win rate', sp.n > 0 && sp.stock != null && sp.stockWin != null && sp.stockMedian != null)
const toExp = callPath(bars, vols, 100, playModel(m1), playSpan(m1))
const S0 = bars[100].o, Sx = bars[121].c
ok('1M call held to expiry ≈ intrinsic', Math.abs((toExp.call[0] + 1) * toExp.cost - Math.max(0, Sx - S0) * 0.98) < 0.5)
// Exit plan grading (owner, 2026-10-16): swing = all out at +40% or after 2 weeks.
{
  const closes = bars.map((b) => b.c)
  const swing = PLAYS[0], leaps = PLAYS[PLAYS.length - 1]
  const tr = exitTrade(bars, closes, vols, 100, swing)
  ok('swing trade closes within the 2-week window', tr && !tr.open && tr.endI - tr.i <= SWING_EXIT.maxHold)
  ok('swing exit is all-or-nothing (one sale)', tr.exits.length === 1 && Math.abs(tr.exits[0].frac - 1) < 1e-9)
  ok('swing sale is target or cap', ['target', 'cap'].includes(tr.exits[0].reason))
  const jump = bars.map((b, i) => (i > 300 && i <= 320 ? { ...b, o: b.o * (1 + (i - 300) * 0.02), h: b.h * (1 + (i - 300) * 0.02), l: b.l * (1 + (i - 300) * 0.02), c: b.c * (1 + (i - 300) * 0.02) } : i > 320 ? { ...b, o: b.o * 1.4, h: b.h * 1.4, l: b.l * 1.4, c: b.c * 1.4 } : b))
  const tj = exitTrade(jump, jump.map((b) => b.c), trailingVol(jump.map((b) => b.c), 60), 300, swing)
  ok('a sharp rally hits the +40% target', tj.exits[0].reason === 'target' && tj.optionReturn > 0.3)
  const tl = exitTrade(bars, closes, vols, 100, leaps)
  ok('LEAPS uses the playbook (not a 2-week cap)', tl && !tl.exits.some((x) => x.reason === 'cap'))
  const eh = exitHistory(bars, entries, swing, { vols })
  ok('one graded trade per signal', eh.length === 3)
  const es = exitStats([{ ret: -0.5, days: 10 }, { ret: -0.1, days: 10 }, { ret: 0.2, days: 3, hit: false }, { ret: 0.45, days: 2, hit: true }])
  ok('exit stats: median, win, bad quarter, average', es.n === 4 && es.median === -0.1 && es.win === 0.5 && es.badq === -0.5 && es.avg === 0.013 && es.hit === 0.25)
  ok('exit stats empty', exitStats([]).n === 0)
}
console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
