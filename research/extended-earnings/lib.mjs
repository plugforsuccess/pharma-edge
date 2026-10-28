// Extended into earnings (PREREG.md). Pure functions; node check.mjs.
import { sma, rsi } from '../../src/utils/indicators.js'
import { extendedFlags } from '../../src/utils/confluence.js'

export const RULES = Object.freeze({
  version: 'prereg-2026-10-28', since: '2016-01-01', minBars: 252, gapDays: 20, after: 5,
  normalLook: 8, normalMin: 4,
  pass: Object.freeze({ minN: 300, medianGap: 0.015, downGap: 0.08, reachX: 1.5, yearsWon: 7, years: ['2016', '2017', '2018', '2019', '2020', '2021', '2022', '2023', '2024', '2025'] }),
  bootstrap: Object.freeze({ reps: 10000, seed: 11 }),
})

// Per-bar features for one ticker. bars: [{ t, o, h, l, c }] sorted.
export function featureSeries(bars) {
  const c = bars.map((b) => b.c)
  const s20 = sma(c, 20), s50 = sma(c, 50), s200 = sma(c, 200), r = rsi(c, 14)
  const dist200 = c.map((x, i) => (s200[i] ? (x / s200[i] - 1) * 100 : null))
  const ext = extendedFlags(r, dist200)
  const pct = (s, i) => (s[i] ? c[i] / s[i] - 1 : null)
  return { s20, s50, s200, rsi: r, ext, at: (i) => ({ rsi: r[i], above20: pct(s20, i), above50: pct(s50, i), above200: pct(s200, i), extended: !!ext[i] }) }
}

// L = index of the last close before the report. timing 'BMO' → previous session, 'AMC' → that session.
export function lastCloseIndex(bars, date, timing) {
  let lo = 0, hi = bars.length - 1, d = -1
  while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m].t <= date) { d = m; lo = m + 1 } else hi = m - 1 }
  if (d < 0) return -1
  if (bars[d].t !== date) return timing === 'BMO' ? d : -1   // report day missing from bars: BMO → the session before it
  return timing === 'AMC' ? d : d - 1
}

// spyClose: Map t → close.
export function outcome(bars, L, f, spyClose, p = RULES) {
  const A = L + 1, E = L + p.after
  if (L < 0 || E >= bars.length) return null
  const c0 = bars[L].c, s0 = spyClose.get(bars[L].t), sA = spyClose.get(bars[A].t), sE = spyClose.get(bars[E].t)
  const day1 = bars[A].c / c0 - 1, day5 = bars[E].c / c0 - 1
  let reach50 = false, reach20 = false
  for (let k = A; k <= E; k++) { if (f.s50[k] && bars[k].l <= f.s50[k]) reach50 = true; if (f.s20[k] && bars[k].l <= f.s20[k]) reach20 = true }
  return {
    day1, day5, gap: bars[A].o > 0 ? bars[A].o / c0 - 1 : null,
    day1x: s0 && sA ? day1 - (sA / s0 - 1) : null, day5x: s0 && sE ? day5 - (sE / s0 - 1) : null,
    down: day1 < 0, reach50, reach20,
  }
}

const quant = (xs, q) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); if (!v.length) return null; const k = (v.length - 1) * q, lo = Math.floor(k); return v[lo] + (v[Math.ceil(k)] - v[lo]) * (k - lo) }
export const median = (xs) => quant(xs, 0.5)
const mean = (xs) => { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }

// |day1| ÷ median |day1| of the previous `normalLook` reports (≥ normalMin).
export function vsNormal(prevDay1, day1, p = RULES) {
  const v = prevDay1.slice(-p.normalLook).map(Math.abs)
  if (v.length < p.normalMin) return null
  const m = median(v)
  return m > 0 ? Math.abs(day1) / m : null
}

export function groupStats(rows) {
  const o = rows.map((r) => r.out)
  const share = (k) => (o.length ? o.filter((x) => x[k]).length / o.length : null)
  return {
    n: rows.length, day1Median: median(o.map((x) => x.day1)), day1xMedian: median(o.map((x) => x.day1x)), day1xMean: mean(o.map((x) => x.day1x)),
    day5xMedian: median(o.map((x) => x.day5x)), down: share('down'), reach50: share('reach50'), reach20: share('reach20'),
    vsNormal: median(rows.map((r) => r.vsNormal)), bigMove: rows.filter((r) => r.vsNormal != null).length ? rows.filter((r) => r.vsNormal >= 1.5).length / rows.filter((r) => r.vsNormal != null).length : null,
    fell5: o.length ? o.filter((x) => x.day1x <= -0.05).length / o.length : null,
  }
}

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 } }
const weekOf = (t) => { const d = new Date(`${t}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10) }
// Mean(a) − mean(b) of day1x, each resampled by report week. → { diff, lo, hi }
export function bootDiff(a, b, { reps = RULES.bootstrap.reps, seed = RULES.bootstrap.seed } = {}) {
  const groups = (rows) => { const m = new Map(); for (const r of rows) { const x = r.out.day1x; if (!Number.isFinite(x)) continue; const k = weekOf(r.t); const g = m.get(k) ?? { s: 0, n: 0 }; g.s += x; g.n++; m.set(k, g) } return [...m.values()] }
  const A = groups(a), B = groups(b), rand = rng(seed)
  if (!A.length || !B.length) return { diff: null, lo: null, hi: null }
  const draw = (G) => { let s = 0, n = 0; for (let k = 0; k < G.length; k++) { const g = G[Math.floor(rand() * G.length)]; s += g.s; n += g.n } return s / n }
  const d = new Array(reps); for (let i = 0; i < reps; i++) d[i] = draw(A) - draw(B)
  const tot = (G) => G.reduce((x, g) => x + g.s, 0) / G.reduce((x, g) => x + g.n, 0)
  return { diff: tot(A) - tot(B), lo: quant(d, 0.025), hi: quant(d, 0.975) }
}

export function verdict(ext, not, p = RULES.pass) {
  const E = groupStats(ext), N = groupStats(not)
  if (E.n < p.minN) return { verdict: 'inconclusive', E, N }
  const boot = bootDiff(ext, not)
  const years = Object.fromEntries(p.years.map((y) => { const e = ext.filter((r) => r.t.startsWith(y)), n = not.filter((r) => r.t.startsWith(y)); return [y, { e: e.length, n: n.length, ext: median(e.map((r) => r.out.day1x)), not: median(n.map((r) => r.out.day1x)) }] }))
  const won = Object.values(years).filter((y) => y.ext != null && y.not != null && y.ext < y.not).length
  const checks = {
    median: E.day1xMedian <= N.day1xMedian - p.medianGap,
    down: E.down >= N.down + p.downGap,
    reach: N.reach50 > 0 ? E.reach50 >= p.reachX * N.reach50 : E.reach50 > 0,
    interval: boot.hi != null && boot.hi < 0,
    years: won >= p.yearsWon,
  }
  return { verdict: Object.values(checks).every(Boolean) ? 'pass' : 'fail', E, N, boot, years, won, checks }
}
