// Checks for src/utils/replay.js (npm run replay:check).
import {
  normCdf, normInv, bsCall, strikeForDelta, trailingVol, replaySignals, replayTrades, tradeStats,
  bigMoves, gradeMoves, moveStats, replayModel, OPTION_MODEL,
  bsPut, replayPutSpreads, bigDrops, gradeDrops, dropStats, PUT_MODEL,
} from '../src/utils/replay.js'
import { entryModel } from '../src/utils/indicators.js'
import { suiteModel } from '../src/utils/signalSuite.js'
import { EXIT_PLAYBOOK } from '../src/utils/afterTax.js'

let passed = 0
const failures = []
function eq(name, got, want, tol = 0) {
  const ok = typeof want === 'number' && typeof got === 'number' ? Math.abs(got - want) <= tol : JSON.stringify(got) === JSON.stringify(want)
  if (ok) passed++
  else failures.push(`${name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
}

// Black-Scholes.
eq('N(0)', normCdf(0), 0.5, 1e-7)
eq('N(1.96)', normCdf(1.96), 0.975, 1e-4)
eq('N⁻¹(0.975)', normInv(0.975), 1.96, 1e-3)
eq('N⁻¹(0.01)', normInv(0.01), -2.3263, 1e-3)
eq('BS 100/100 1y 20% 5%', bsCall(100, 100, 1, 0.2, 0.05), 10.4506, 1e-3)
eq('BS at expiry = intrinsic', bsCall(120, 100, 0, 0.2), 20)
{
  const K = strikeForDelta(100, 2, 0.3, 0.75, 0.04)
  const d1 = (Math.log(100 / K) + (0.04 + 0.045) * 2) / (0.3 * Math.SQRT2)
  eq('strike lands on delta 0.75', normCdf(d1), 0.75, 1e-4)
  eq('0.75-delta strike is in the money', K < 100, true)
}
{
  const c = Array.from({ length: 70 }, (_, i) => 100 * (i % 2 ? 1.01 : 1))
  const v = trailingVol(c, 60)
  eq('vol null before the window', v[59], null)
  eq('vol of ±1% swings ≈ 15.8%', v[69], 0.01 * Math.sqrt(252), 0.002)
}

// A deterministic market: a seeded walk with regimes, so signals happen.
function market(n, seed = 7) {
  let s = seed
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 }
  const bars = []
  let p = 100
  const d0 = Date.UTC(2020, 0, 2)
  let day = 0
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 90) * 0.003
    const r = drift + (rnd() - 0.5) * 0.04
    const o = p
    p = Math.max(5, p * (1 + r))
    const h = Math.max(o, p) * (1 + rnd() * 0.01)
    const l = Math.min(o, p) * (1 - rnd() * 0.01)
    let t
    do { t = new Date(d0 + day * 86400000); day++ } while (t.getUTCDay() === 0 || t.getUTCDay() === 6)
    bars.push({ t: t.toISOString().slice(0, 10), o, h, l, c: p, v: 1e6 * (1 + rnd()) })
  }
  return bars
}

// No look-ahead: each day's entry / sell flags from the full history equal
// the flags from a model built on the bars up to that day only.
{
  const bars = market(900)
  const full = replaySignals(bars, entryModel(bars), suiteModel(bars))
  let mismatches = 0
  let checked = 0
  for (let t = 320; t < bars.length; t += 37) {
    const pre = bars.slice(0, t + 1)
    const s = replaySignals(pre, entryModel(pre), suiteModel(pre))
    for (const rule of ['confluence', 'zone', 'bravo', 'recovery']) if (s.entry[rule][t] !== full.entry[rule][t]) mismatches++
    if (s.sell[t] !== full.sell[t]) mismatches++
    if (s.bear.falling[t] !== full.bear.falling[t] || s.bear.any[t] !== full.bear.any[t] || s.buyOn[t] !== full.buyOn[t]) mismatches++
    if (s.buyScore[t] !== full.buyScore[t] || s.sellScore[t] !== full.sellScore[t]) mismatches++
    checked++
  }
  eq('prefix replays checked', checked >= 15, true)
  eq('no look-ahead in any signal', mismatches, 0)
  const anyEntry = ['confluence', 'zone', 'bravo'].some((r) => full.entry[r].some(Boolean))
  eq('the synthetic market produces entries', anyEntry, true)
  // Recovery never fires while the 200-day is rising, and never on the
  // same bar as a confluence entry.
  eq('recovery only while the 200-day falls', full.entry.recovery.every((x, i) => !x || !full.rising[i]), true)
  eq('recovery and confluence are disjoint', full.entry.recovery.every((x, i) => !(x && full.entry.confluence[i])), true)
}

// Trade mechanics on a hand-made path: flat 300 bars, then a steady rise.
{
  const bars = []
  const d0 = Date.UTC(2020, 0, 1)
  for (let i = 0; i < 700; i++) {
    const c = i < 300 ? 100 : 100 * 1.004 ** (i - 300)
    bars.push({ t: new Date(d0 + i * 86400000).toISOString().slice(0, 10), o: c, h: c * 1.002, l: c * 0.998, c, v: 1 })
  }
  const off = bars.map(() => false)
  const entry = off.slice(); entry[300] = true
  const sig = { entry: { confluence: entry }, sell: off.slice(), buyKey: off.map(() => '') }
  const vol = bars.map(() => 0.3)
  const [tr] = replayTrades(bars, sig, { exitRule: 'targets', vol })
  eq('enters the next bar', tr.i, 301)
  eq('target 1 sells 70%', tr.exits[0].reason === 't1' && Math.abs(tr.exits[0].frac - 0.7) < 1e-9, true)
  eq('target 1 at ≥ 2x cost', tr.exits[0].mult >= 2, true)
  eq('target 2 sells 15%', tr.exits[1]?.reason === 't2' && Math.abs(tr.exits[1].frac - 0.15) < 1e-9, true)
  eq('runner still open on a steady rise', tr.open, true)
  eq('option return beats the stock', tr.optionReturn > tr.stockReturn, true)

  // A sell signal right after target 1 closes the rest (both).
  const sell = off.slice()
  const t1 = tr.exits[0].i
  sell[t1 + 3] = true
  const [tb] = replayTrades(bars, { ...sig, sell }, { exitRule: 'both', vol })
  eq('both: signal sells the remaining 30%', tb.exits.map((x) => x.reason), ['t1', 'signal'])
  eq('both: fully closed', tb.open, false)
  const [ts] = replayTrades(bars, { ...sig, sell }, { exitRule: 'signals', vol })
  eq('signals only: one exit, all of it', ts.exits.length === 1 && Math.abs(ts.exits[0].frac - 1) < 1e-9, true)
  // Before target 1, `both` ignores the sell signal.
  const early = off.slice(); early[305] = true
  const [te] = replayTrades(bars, { ...sig, sell: early }, { exitRule: 'both', vol })
  eq('both: a signal before target 1 is ignored', te.exits[0].reason, 't1')
  const [tse] = replayTrades(bars, { ...sig, sell: early }, { exitRule: 'signals', vol })
  eq('signals: the early signal sells', tse.exits[0].reason === 'signal' && tse.exits[0].i === 305, true)

  // Time stop: no targets on a flat path → out with < rollDays left.
  const flatBars = bars.map((b, i) => ({ ...b, c: 100, o: 100, h: 100.2, l: 99.8, t: new Date(d0 + i * 86400000).toISOString().slice(0, 10) }))
  const [tt] = replayTrades(flatBars, sig, { exitRule: 'targets', vol: flatBars.map(() => 0.3), opt: { ...OPTION_MODEL, dte: 300 } })
  eq('time stop fires', tt.exits[0]?.reason, 'time')
  eq('time stop within rollDays of expiry', tt.days, 300 - EXIT_PLAYBOOK.rollDays, 1)
  eq('flat stock + time decay = a loss', tt.optionReturn < 0, true)

  // Runner trail after both targets: rise, then a 50% drop.
  const peakAt = 600
  const crash = bars.map((b, i) => (i <= peakAt ? b : { ...b, c: bars[peakAt].c * 0.97 ** (i - peakAt), o: bars[peakAt].c * 0.97 ** (i - peakAt) }))
  crash.forEach((b) => { b.h = b.c * 1.002; b.l = b.c * 0.998 })
  const [tc] = replayTrades(crash, sig, { exitRule: 'targets', vol })
  eq('runner leaves on the trail', tc.exits[tc.exits.length - 1].reason, 'trail')
  eq('trail exit after the peak', tc.exits[tc.exits.length - 1].i > peakAt, true)

  const st = tradeStats([tb, ts, tt])
  eq('stats count', st.n, 3)
  eq('stats win rate', st.winRate, 2 / 3, 1e-9)
}

// Big moves + grading.
{
  const bars = []
  const d0 = Date.UTC(2021, 0, 1)
  const path = (i) => (i < 40 ? 100 - i : i < 120 ? 60 + (i - 40) * 0.75 : 120 - (i - 120) * 0.2)
  for (let i = 0; i < 200; i++) { const c = path(i); bars.push({ t: new Date(d0 + i * 86400000).toISOString().slice(0, 10), o: c, h: c + 0.5, l: c - 0.5, c, v: 1 }) }
  const moves = bigMoves(bars, { minGain: 0.3 })
  eq('one big move', moves.length, 1)
  eq('move starts at the low', moves[0].lowI, 40)
  eq('move peaks at the top', moves[0].peakI, 120)
  eq('move gain', moves[0].gain, 120.5 / 59.5 - 1, 1e-9)
  const sig = { buyScore: bars.map(() => 0), buyKey: bars.map(() => ''), rising: bars.map((_, i) => i > 45) }
  const caughtTrade = { signalI: 44, i: 45, endI: 130, stock: 63.75, stockReturn: 0.6 }
  const g1 = gradeMoves(moves, [caughtTrade], sig, bars)
  eq('caught near the low', g1[0].caught, true)
  eq('kept share of the move', g1[0].kept, (63.75 * 1.6 - 63.75) / (120.5 - 59.5), 1e-9)
  const late = { signalI: 110, i: 111, endI: 150, stock: 112, stockReturn: 0.01 }
  const g2 = gradeMoves(moves, [late], sig, bars)
  eq('a late entry is a miss', g2[0].caught, false)
  eq('miss reason', g2[0].why, 'no buy signals')
  const ms = moveStats(g1)
  eq('catch rate', ms.catchRate, 1)
}

// Puts.
eq('put-call parity', bsPut(100, 100, 1, 0.2, 0.05), 10.4506 - 100 + 100 * Math.exp(-0.05), 1e-3)
eq('put at expiry = intrinsic', bsPut(80, 100, 0, 0.2), 20)
{
  // Flat 300 bars, then a steady fall: a put spread on the bear entry.
  const bars = []
  const d0 = Date.UTC(2020, 0, 1)
  for (let i = 0; i < 500; i++) {
    const c = i < 300 ? 100 : 100 * 0.995 ** (i - 300)
    bars.push({ t: new Date(d0 + i * 86400000).toISOString().slice(0, 10), o: c, h: c * 1.002, l: c * 0.998, c, v: 1 })
  }
  const off = bars.map(() => false)
  const on = off.slice(); on[300] = true
  const sig = { bear: { falling: on, any: on }, buyOn: off.slice(), sellScore: bars.map(() => 0), sellKey: bars.map(() => ''), falling: bars.map(() => true) }
  const vol = bars.map(() => 0.3)
  const [tr] = replayPutSpreads(bars, sig, { vol })
  eq('put spread opens the next bar', tr.i, 301)
  eq('long put at the money', tr.long, tr.stock, 1e-9)
  eq('short put one expected move lower', tr.short, tr.stock * (1 - 0.3 * Math.sqrt(90 / 365)), 1e-6)
  eq('debit within 40% of the width', tr.cost <= PUT_MODEL.maxDebit * tr.width, true)
  eq('take 1 sells half at 2x', tr.exits[0].reason === 't1' && Math.abs(tr.exits[0].frac - 0.5) < 1e-9 && tr.exits[0].mult >= 2, true)
  eq('put spread wins on a fall', tr.optionReturn > 0.5, true)
  eq('closed before expiry', tr.days <= PUT_MODEL.dte - PUT_MODEL.closeDte + 1, true)

  // A rising stock: the stop takes it out at −50%.
  const up = bars.map((b, i) => { const c = i < 300 ? 100 : 100 * 1.004 ** (i - 300); return { ...b, c, o: c, h: c * 1.002, l: c * 0.998 } })
  const [ts] = replayPutSpreads(up, sig, { vol })
  eq('stop fires on a rally', ts.exits[0].reason, 'stop')
  eq('stop loses about half', ts.optionReturn > -0.65 && ts.optionReturn < -0.45, true)

  // A flat stock: out at 21 DTE.
  const flat = bars.map((b) => ({ ...b, c: 100, o: 100, h: 100.2, l: 99.8 }))
  const [tf] = replayPutSpreads(flat, sig, { vol })
  eq('time close on a flat stock', tf.exits[0].reason, 'time')
  eq('time close at 21 DTE', tf.days, PUT_MODEL.dte - PUT_MODEL.closeDte, 1)

  // A thesis flip (2+ buy signals) closes what is left.
  const flipSig = { ...sig, buyOn: off.slice() }; flipSig.buyOn[310] = true
  const [tp] = replayPutSpreads(bars, flipSig, { vol })
  eq('buy signals flip the thesis', tp.exits.some((x) => x.reason === 'flip'), true)

  // Too-expensive spreads are skipped: a 1% vol floor makes the width tiny.
  const skipped = replayPutSpreads(bars, sig, { vol, opt: { ...OPTION_MODEL, volFloor: 0.01 }, pm: { ...PUT_MODEL, maxDebit: 0.0001 } })
  eq('spreads over the debit cap are skipped', skipped.length === 0 && skipped.skipped === 1, true)
}
{
  // Big drops + grading: a top at 40, a 50% fall to 120.
  const bars = []
  const d0 = Date.UTC(2021, 0, 1)
  const path = (i) => (i < 40 ? 100 + i : i < 100 ? 140 - (i - 40) * 1.1 : 74 + (i - 100) * 0.1)
  for (let i = 0; i < 200; i++) { const c = path(i); bars.push({ t: new Date(d0 + i * 86400000).toISOString().slice(0, 10), o: c, h: c + 0.5, l: c - 0.5, c, v: 1 }) }
  const drops = bigDrops(bars, { minDrop: 0.2, horizon: 63 })
  eq('one big drop', drops.length, 1)
  eq('drop starts at the high', drops[0].highI, 40)
  eq('drop ends near the low', Math.abs(drops[0].lowI - 100) <= 3, true)
  const sig = { sellScore: bars.map(() => 0), falling: bars.map(() => false) }
  const caught = { signalI: 45, i: 46, endI: 110, stock: 134, stockReturn: -0.4 }
  const g = gradeDrops(drops, [caught], sig)
  eq('drop caught', g[0].caught, true)
  eq('drop kept share', g[0].kept, (134 * 0.4) / (drops[0].high - drops[0].low), 1e-9)
  eq('missed drop reason', gradeDrops(drops, [], sig)[0].why, 'no sell signals')
  eq('drop catch rate', dropStats(g).catchRate, 1)
}

// The whole model runs on the synthetic market.
{
  const bars = market(1000, 11)
  const m = replayModel({ bars, model: entryModel(bars), suite: suiteModel(bars) })
  eq('fifteen entry × exit runs', Object.keys(m.runs).length, 15)
  eq('two put runs', Object.keys(m.puts).length, 2)
  eq('put trades enter after their signal', Object.values(m.puts).every((r) => r.trades.every((t) => t.i === t.signalI + 1)), true)
  eq('every trade enters after its signal', Object.values(m.runs).every((r) => r.trades.every((t) => t.i === t.signalI + 1)), true)
  eq('trades never overlap', Object.values(m.runs).every((r) => r.trades.every((t, k, a) => k === 0 || t.signalI > a[k - 1].endI)), true)
}

console.log(`replay checks: ${passed} passed, ${failures.length} failed`)
if (failures.length) { for (const f of failures) console.log('  ✗', f); process.exit(1) }
