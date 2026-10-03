// Checks for src/utils/signalSuite.js (Bravo / Echo / Tango / Hardening / Exits).
// Run: npm run suite:check
import {
  rma, atr, mfi, percentileNearestRank, alignCloses, suiteModel, forwardReturns, horizonStats, SUITE_PARAMS,
  periodKey, normalizePeriods, periodCloseDays, stepToDays, suiteOnDays,
} from '../src/utils/signalSuite.js'

let passed = 0
const failures = []
function eq(name, got, want, tol) {
  const ok = tol != null ? got != null && Math.abs(got - want) <= tol : JSON.stringify(got) === JSON.stringify(want)
  if (ok) passed++
  else failures.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

// RMA: seeded with the SMA, then Wilder smoothing.
const r = rma([1, 2, 3, 4, 5], 3)
eq('rma seed', r[2], 2)
eq('rma next', r[3], (2 * 2 + 4) / 3, 1e-12)

// ATR on a flat 2-wide range = 2.
const flatBars = Array.from({ length: 30 }, (_, i) => ({ t: `d${i}`, o: 10, h: 11, l: 9, c: 10, v: 1 }))
eq('atr flat', atr(flatBars, 14)[29], 2, 1e-12)

// MFI: only up days → 100; alternating equal flow → 50.
const upSrc = Array.from({ length: 25 }, (_, i) => 10 + i)
eq('mfi all up', mfi(upSrc, upSrc.map(() => 1), 20)[24], 100)
const alt = Array.from({ length: 41 }, (_, i) => (i % 2 ? 11 : 10))
const altV = alt.map((s) => 110 / s) // same dollar flow either way
eq('mfi balanced', mfi(alt, altV, 20)[40], 50, 1e-9)

// Percentile, nearest rank (Pine): 80th of 1..10 = 8, 20th = 2.
const ten = Array.from({ length: 10 }, (_, i) => i + 1)
eq('p80 nearest rank', percentileNearestRank(ten, 10, 80)[9], 8)
eq('p20 nearest rank', percentileNearestRank(ten, 10, 20)[9], 2)
eq('percentile needs a full window', percentileNearestRank(ten, 10, 80)[8], null)

// Align external closes by day, carrying forward.
eq('align', alignCloses([{ t: 'a' }, { t: 'b' }, { t: 'c' }], [{ t: 'a', c: 1 }, { t: 'c', c: 3 }]), [1, 1, 3])

// Synthetic daily bars: a long uptrend with pullbacks, a top, a downtrend.
const bars = []
let seed = 7
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
let c = 100
let d = Date.UTC(2020, 0, 1)
for (let i = 0; i < 1100; i++) {
  while ([0, 6].includes(new Date(d).getUTCDay())) d += 86400000
  const drift = i < 700 ? 0.0012 + Math.sin(i / 25) * 0.006 : -0.0015 + Math.sin(i / 25) * 0.006
  const o = c
  c = o * (1 + drift + (rnd() - 0.5) * 0.02)
  bars.push({ t: new Date(d).toISOString().slice(0, 10), o, h: Math.max(o, c) * (1 + rnd() * 0.012), l: Math.min(o, c) * (1 - rnd() * 0.012), c, v: Math.round(1e6 * (0.5 + rnd() * 1.5)) })
  d += 86400000
}
const spy = bars.map((b, i) => ({ t: b.t, c: 300 * (1 + i * 0.0003) }))
const vix = bars.map((b) => ({ t: b.t, c: 18 }))
const m = suiteModel(bars, { spy, vix })
// Hardening needs all three pillars inside 5 bars — rare by design. A wider
// window and no velocity gate give the invariant checks signals to test.
const loose = { windowBull: 60, windowBear: 120, velocityPts: -100, atrExpansion: 0, volumeFloor: 0 }
const mr = suiteModel(bars, { spy, vix, params: loose })
eq('loose params produce hardening signals', mr.bulls.length > 0 && mr.bears.length > 0, true)
eq('signals are candidates that passed every gate', mr.signals.every((s) => {
  const c = mr.candidates.find((x) => x.i === s.i && x.side === s.side)
  return c && Object.values(c.gates).every(Boolean)
}), true)

eq('bravo basis warms up at 200', m.bravo.basis[198] == null && m.bravo.basis[199] != null, true)
eq('echo rails adaptive after 200 values', m.echo.upper[100] === SUITE_PARAMS.staticRail && m.echo.upper[400] !== SUITE_PARAMS.staticRail, true)
eq('echo rails ordered', m.echo.upper.every((u, i) => u >= m.echo.lower[i]), true)
const idx = (flags) => flags.map((f, i) => (f ? i : -1)).filter((i) => i >= 0)
const gaps = (list) => list.slice(1).map((x, k) => x - list[k])
eq('bravo fires', idx(m.bravo.bull).length > 0 && idx(m.bravo.bear).length > 0, true)
eq('bravo diamonds only where the condition turns on', idx(m.bravo.bullOn).every((i) => !idx(m.bravo.bullOn).includes(i - 1)), true)
eq('bravo diamonds are a subset of up-closes above the basis', idx(m.bravo.bullOn).every((i) => bars[i].c > bars[i - 1].c && m.bravo.regime[i] === 1), true)
// Exactly the Pine's visual event: raw on now, off the bar before — no cooldown.
const bravoRawBull = bars.map((b, i) => i > 0 && m.bravo.basis[i] != null && b.c > m.bravo.basis[i] && m.bravo.fast[i] > m.bravo.basis[i]
  && m.bravo.fast[i - SUITE_PARAMS.slopeLookback] != null && m.bravo.fast[i] - m.bravo.fast[i - SUITE_PARAMS.slopeLookback] > 0 && b.c > bars[i - 1].c)
eq('bravo diamonds = every turn-on (Pine visual)', idx(m.bravo.bullOn), idx(bravoRawBull.map((x, i) => x && !bravoRawBull[i - 1])))
eq('daily periods are the days', normalizePeriods([{ t: '2026-10-01' }, { t: '2026-10-02' }], '1d').map((x) => x.k), ['2026-10-01', '2026-10-02'])
eq('bravo cooldown ≥ 5', gaps(idx(m.bravo.bull)).every((g) => g >= 5), true)
eq('echo cooldown ≥ 5', gaps(idx(m.echo.bull)).every((g) => g >= 5), true)
eq('tango cooldown ≥ 8', gaps(idx(m.tango.bull)).every((g) => g >= 8), true)
eq('echo fires both ways', idx(m.echo.bull).length > 0 && idx(m.echo.bear).length > 0, true)
eq('echo bull = crossed up through the lower rail', idx(m.echo.bull).every((i) => m.echo.line[i - 1] <= m.echo.lower[i - 1] && m.echo.line[i] > m.echo.lower[i]), true)
eq('tango bull needs volume above average', idx(m.tango.bull).every((i) => bars[i].v > bars.slice(i - 19, i + 1).reduce((s, b) => s + b.v, 0) / 20), true)
eq('hardening stars 1–4', mr.signals.every((s) => s.stars >= 1 && s.stars <= 4 && s.stars === 1 + s.boosters.length), true)
eq('hardening bulls only in a bull regime', mr.bulls.every((s) => mr.bravo.regime[s.i] === 1), true)
eq('hardening bears only in a bear regime', mr.bears.every((s) => mr.bravo.regime[s.i] === -1), true)
eq('exits carry reasons', m.exits.length > 0 && m.exits.every((x) => x.why.length > 0), true)
// The regime flip exit fires when the regime leaves bull — not the bar after every Bravo signal.
const flipExits = m.exits.filter((x) => x.why.includes('B')).map((x) => x.i)
eq('B exits only on a regime change', flipExits.every((i) => m.bravo.regime[i - 1] === 1 && m.bravo.regime[i] !== 1), true)
eq('B exits are not "the bar after a Bravo signal"', flipExits.length < idx(m.bravo.bull).length, true)

// VIX ≥ 30 blocks bull signals, not bear ones.
const hot = suiteModel(bars, { spy, vix: bars.map((b) => ({ t: b.t, c: 40 })), params: loose })
eq('vix blocks bulls', hot.bulls.length, 0)
eq('vix leaves bears', hot.bears.length, mr.bears.length)
// A stronger RS booster: the ticker beating a flat SPY adds a star.
const flatSpy = suiteModel(bars, { spy: bars.map((b) => ({ t: b.t, c: 300 })), vix, params: loose })
eq('rs booster when beating SPY', flatSpy.bulls.every((s) => s.boosters.includes('RS') === (bars[s.i].c > bars[s.i - 20].c)), true)

// No look-ahead: signals up to bar k are the same with or without later bars.
const k = 900
const cut = suiteModel(bars.slice(0, k + 1), { spy, vix, params: loose })
const upTo = (list) => JSON.stringify(list.filter((s) => s.i <= k).map((s) => [s.i, s.side ?? s.why.join(''), s.stars ?? '']))
eq('hardening has no look-ahead', upTo(cut.signals), upTo(mr.signals))
eq('exits have no look-ahead', upTo(cut.exits), upTo(mr.exits))

// Forward returns + stats.
const H = [['3M', 63]]
const fr = forwardReturns(bars.map((b) => b.c), [{ i: 10 }, { i: 1090 }], H)
eq('forward return', fr[0].returns[0], bars[73].c / bars[10].c - 1, 1e-12)
eq('open when not enough bars', fr[1].returns[0], null)
eq('stats for sells count falls', horizonStats([{ returns: [-0.1] }, { returns: [0.2] }], H, (x) => x < 0)[0].winRate, 0.5)

// Weekly / monthly on the daily chart.
eq('week key = Monday', periodKey('2026-10-01', '1wk'), '2026-09-28')
eq('week key on a Monday', periodKey('2026-09-28', '1wk'), '2026-09-28')
eq('month key', periodKey('2026-10-01', '1mo'), '2026-10')
const live = normalizePeriods([{ t: '2026-09-01', c: 1 }, { t: '2026-10-01', c: 2 }, { t: '2026-10-03', c: 3 }], '1mo')
eq('live duplicate merged into its period', live.map((x) => [x.t, x.c]), [['2026-09-01', 1], ['2026-10-01', 3]])
const days = ['2026-09-28', '2026-09-29', '2026-10-02', '2026-10-05', '2026-10-06'].map((t) => ({ t }))
const weeks = normalizePeriods([{ t: '2026-09-21' }, { t: '2026-09-28' }, { t: '2026-10-05' }], '1wk')
const cdays = periodCloseDays(days, weeks, '1wk')
eq('period closes on its last day', cdays, [-1, 2, 4])
eq('step: a value appears on its close day, never earlier', stepToDays([10, 20, 30], cdays, 5), [null, null, 20, 20, 30])
// Weekly suite from the synthetic daily bars: weekly bars built by hand.
const wk = []
for (const b of bars) {
  const k = periodKey(b.t, '1wk')
  const last = wk[wk.length - 1]
  if (last && last.k === k) { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; last.v += b.v }
  else wk.push({ k, t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })
}
const ws = suiteModel(wk, { params: loose })
const wd = suiteOnDays(bars, wk, ws, '1wk')
eq('weekly events land on a Friday-or-last day of their week', wd.signals.every((x) => x.i < 0 || periodKey(bars[x.i].t, '1wk') === wk[x.pi].k), true)
eq('weekly event day is the last day of that week', wd.signals.every((x) => x.i < 0 || x.i === bars.length - 1 || periodKey(bars[x.i + 1].t, '1wk') !== wk[x.pi].k), true)
eq('weekly regime stepped to days', wd.bravo.regime.length, bars.length)

console.log(`signal-suite checks: ${passed} passed, ${failures.length} failed`)
console.log(`  (synthetic, default gates: ${m.bulls.length} bull / ${m.bears.length} bear; loose: ${mr.bulls.length} / ${mr.bears.length}; ${m.exits.length} exits)`)
if (failures.length) {
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
