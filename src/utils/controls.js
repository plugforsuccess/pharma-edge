// Matched controls and the pre-registered decision rule for the signal
// engine (docs/signal-engine/preregistration.md, recorded 2026-10-05 before
// this file existed). Pure functions; `npm run controls:check`.
//
//   SPY control     for every strategy trade, the same call on SPY entered on
//                   the same date, same exits, same pricing (paired)
//   random control  entries drawn at random on the same ticker with the same
//                   number of signals per calendar month, one position at a
//                   time; many replications → a distribution
//   DCA reference   one entry on the first bar of every month, overlapping
//   bootstrap       clustered by signal month (nearby trades aren't
//                   independent), percentile CI on the mean difference
//   periods         P1 2022–2023 · P2 2024→ by signal date, both required
//   market buckets  SPY's return over each trade's own holding window
//   IV proxy        premium × (0.3·RV60 + 0.7·RV252), premium calibrated on
//                   tickers with real IV history, held sticky through a trade
//   slippage tiers  by 60-day dollar volume: 2% / 4% / 7% per fill

import { replayFromEntries, trailingVol, OPTION_MODEL } from './replay.js'
import { EXIT_PLAYBOOK } from './afterTax.js'

export const PERIODS = [
  ['P1', '2022-01-01', '2023-12-31'],
  ['P2', '2024-01-01', '9999-12-31'],
]
export const PREMIUM_GRID = [1.0, 1.1, 1.2, 1.3]
export const RANDOM_REPS = 200
export const BOOTSTRAP_N = 2000
export const SAMPLE_FLOOR = { trades: 150, months: 20 }
export const SLIPPAGE_TIERS = [[500e6, 0.02], [50e6, 0.04], [0, 0.07]]
export const MARKET_BUCKETS = [['down', -Infinity, 0], ['flat', 0, 0.2], ['up', 0.2, Infinity]]

// Deterministic PRNG so a run can be reproduced.
export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const periodOf = (t) => PERIODS.find(([, a, b]) => t >= a && t <= b)?.[0] ?? null
export const monthOf = (t) => String(t).slice(0, 7)

// ── Pricing ─────────────────────────────────────────────────────────

export function ivProxy(rv60, rv252, premium = 1) {
  if (rv60 == null && rv252 == null) return null
  const a = rv60 ?? rv252, b = rv252 ?? rv60
  return premium * (0.3 * a + 0.7 * b)
}

// Premium = median of IV / (0.3·RV60 + 0.7·RV252) over samples that have a
// real IV. Returns { premium, n }; premium null under 30 samples.
export function calibratePremium(samples) {
  const ratios = samples.map((s) => (s.iv > 0 && (s.rv60 > 0 || s.rv252 > 0) ? s.iv / ivProxy(s.rv60, s.rv252, 1) : null)).filter((x) => x != null && Number.isFinite(x))
  if (ratios.length < 30) return { premium: null, n: ratios.length }
  const srt = [...ratios].sort((a, b) => a - b)
  return { premium: srt[Math.floor(srt.length / 2)], n: ratios.length }
}

// Per-bar vol series for pricing: the proxy at `premium` from RV60 / RV252.
export function proxyVolSeries(closes, premium) {
  const rv60 = trailingVol(closes, 60)
  const rv252 = trailingVol(closes, 252)
  return closes.map((_, i) => ivProxy(rv60[i], rv252[i], premium))
}

export function slippageTier(dollarVolume) {
  for (const [floor, slip] of SLIPPAGE_TIERS) if (dollarVolume >= floor) return slip
  return SLIPPAGE_TIERS[SLIPPAGE_TIERS.length - 1][1]
}

// 60-day average dollar volume per bar.
export function dollarVolumeSeries(bars, n = 60) {
  const out = new Array(bars.length).fill(null)
  let sum = 0
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].c * (bars[i].v || 0)
    if (i >= n) sum -= bars[i - n].c * (bars[i - n].v || 0)
    if (i >= n - 1) out[i] = sum / n
  }
  return out
}

// Trailing-12-month dividend yield per bar from an ex-date → amount map.
export function dividendYieldSeries(bars, dividends = {}) {
  const out = new Array(bars.length).fill(0)
  const dates = Object.keys(dividends).sort()
  if (!dates.length) return out
  for (let i = 0; i < bars.length; i++) {
    const t = bars[i].t
    const from = new Date(`${t}T00:00:00Z`); from.setUTCFullYear(from.getUTCFullYear() - 1)
    const f = from.toISOString().slice(0, 10)
    let sum = 0
    for (const d of dates) { if (d > t) break; if (d > f) sum += dividends[d] }
    out[i] = bars[i].c > 0 ? sum / bars[i].c : 0
  }
  return out
}

// The pricing hooks for one ticker at one premium.
export function pricingFor(bars, { premium, dividends = {}, realIv = null } = {}) {
  const closes = bars.map((b) => b.c)
  const proxy = proxyVolSeries(closes, premium)
  const dv = dollarVolumeSeries(bars)
  const q = dividendYieldSeries(bars, dividends)
  // Real IV (date → iv) wins over the proxy when present on the signal day.
  const volAt = (i) => (realIv && realIv[bars[i].t] > 0 ? realIv[bars[i].t] : proxy[i])
  return {
    volAt, sticky: true,
    slipAt: (i) => slippageTier(dv[i] ?? 0),
    yieldAt: (i) => q[i] ?? 0,
    volSourceAt: (i) => (realIv && realIv[bars[i].t] > 0 ? 'iv' : 'proxy'),
    tierAt: (i) => slippageTier(dv[i] ?? 0),
  }
}

// ── Entries for the controls ────────────────────────────────────────

export function entriesAtDates(bars, dates) {
  const idx = new Map(bars.map((b, i) => [b.t, i]))
  const out = new Array(bars.length).fill(false)
  const sorted = bars.map((b) => b.t)
  for (const d of dates) {
    let i = idx.get(d)
    if (i == null) { // nearest earlier bar (SPY is open whenever a stock is, but be safe)
      let lo = 0, hi = sorted.length - 1
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (sorted[mid] <= d) lo = mid; else hi = mid - 1 }
      i = sorted[lo] <= d ? lo : null
    }
    if (i != null) out[i] = true
  }
  return out
}

// Same count of signals per calendar month, on random days of that month.
export function randomEntries(bars, signalDates, rng) {
  const byMonth = new Map()
  for (const d of signalDates) byMonth.set(monthOf(d), (byMonth.get(monthOf(d)) ?? 0) + 1)
  const barsByMonth = new Map()
  bars.forEach((b, i) => { const m = monthOf(b.t); if (!barsByMonth.has(m)) barsByMonth.set(m, []); barsByMonth.get(m).push(i) })
  const out = new Array(bars.length).fill(false)
  for (const [m, k] of byMonth) {
    const pool = (barsByMonth.get(m) ?? []).filter((i) => i < bars.length - 1)
    const picks = new Set()
    let guard = 0
    while (picks.size < Math.min(k, pool.length) && guard++ < 1000) picks.add(pool[Math.floor(rng() * pool.length)])
    for (const i of picks) out[i] = true
  }
  return out
}

export function dcaEntries(bars) {
  const out = new Array(bars.length).fill(false)
  let last = ''
  bars.forEach((b, i) => { const m = monthOf(b.t); if (m !== last && i < bars.length - 1) { out[i] = true; last = m } })
  return out
}

// ── Running the controls for one ticker ─────────────────────────────

// Strategy trades (already run) → paired SPY-control returns, the random
// distribution and DCA trades, all under the same pricing hooks and plan.
export function controlsForTicker({ bars, spyBars, trades, pricing, spyPricing, plan = EXIT_PLAYBOOK, opt = OPTION_MODEL, reps = RANDOM_REPS, seed = 1 }) {
  const spyIdx = new Map(spyBars.map((b, i) => [b.t, i]))
  const spyCloses = spyBars.map((b) => b.c)
  // Paired SPY control: one SPY trade per strategy trade, overlapping allowed.
  const spyEntries = entriesAtDates(spyBars, trades.map((t) => t.signalT))
  const spyTrades = replayFromEntries(spyBars, spyEntries, { allowOverlap: true, plan, opt, ...spyPricing })
  const spyBySignal = new Map(spyTrades.map((t) => [t.signalT, t]))
  const paired = trades.map((t) => {
    let st = spyBySignal.get(t.signalT)
    if (!st) { // nearest earlier SPY bar
      const keys = [...spyBySignal.keys()].filter((k) => k <= t.signalT).sort()
      st = keys.length ? spyBySignal.get(keys[keys.length - 1]) : null
    }
    // SPY's return over the strategy trade's own holding window.
    const a = spyIdx.get(t.t) ?? nearestIdx(spyBars, t.t)
    const b = spyIdx.get(t.endT) ?? nearestIdx(spyBars, t.endT)
    const spyHold = a != null && b != null && spyCloses[a] > 0 ? spyCloses[b] / spyCloses[a] - 1 : null
    return { ...t, spyControl: st ? st.optionReturn : null, spyHold }
  })
  // Random control: distribution of the mean over reps.
  const rng = mulberry32(seed)
  const signalDates = trades.map((t) => t.signalT)
  const random = []
  for (let r = 0; r < reps; r++) {
    const entries = randomEntries(bars, signalDates, rng)
    const rt = replayFromEntries(bars, entries, { allowOverlap: false, plan, opt, ...pricing })
    random.push(rt.map((t) => ({ signalT: t.signalT, optionReturn: t.optionReturn, open: t.open })))
  }
  const dca = replayFromEntries(bars, dcaEntries(bars), { allowOverlap: true, plan, opt, ...pricing })
    .map((t) => ({ signalT: t.signalT, optionReturn: t.optionReturn, open: t.open }))
  return { paired, random, dca }
}

function nearestIdx(bars, t) {
  let lo = 0, hi = bars.length - 1
  if (!bars.length || bars[0].t > t) return null
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (bars[mid].t <= t) lo = mid; else hi = mid - 1 }
  return lo
}

// ── Aggregation across tickers ──────────────────────────────────────

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null)

// Two-sample version: resample clusters (months) with replacement and take
// mean(A) − mean(B) over the picked clusters each time.
export function clusterBootstrapDiff(aItems, bItems, valueOf, clusterOf, { n = BOOTSTRAP_N, seed = 11 } = {}) {
  const months = new Map()
  const add = (items, side) => { for (const it of items) { const c = clusterOf(it); if (!months.has(c)) months.set(c, { a: [], b: [] }); months.get(c)[side].push(valueOf(it)) } }
  add(aItems, 'a'); add(bItems, 'b')
  const clusters = [...months.values()]
  const mA = mean(aItems.map(valueOf)), mB = mean(bItems.map(valueOf))
  if (!clusters.length || mA == null || mB == null) return { diff: mA != null && mB != null ? mA - mB : null, lo: null, hi: null, clusters: clusters.length }
  const rng = mulberry32(seed)
  const diffs = []
  for (let r = 0; r < n; r++) {
    let sa = 0, ka = 0, sb = 0, kb = 0
    for (let c = 0; c < clusters.length; c++) { const pick = clusters[Math.floor(rng() * clusters.length)]; for (const v of pick.a) { sa += v; ka++ } for (const v of pick.b) { sb += v; kb++ } }
    if (ka && kb) diffs.push(sa / ka - sb / kb)
  }
  diffs.sort((a, b) => a - b)
  return { diff: mA - mB, lo: diffs[Math.floor(0.025 * diffs.length)] ?? null, hi: diffs[Math.floor(0.975 * diffs.length)] ?? null, clusters: clusters.length }
}

// Percentile CI of the mean of `values` grouped by cluster key, resampling
// clusters with replacement.
export function clusterBootstrap(items, valueOf, clusterOf, { n = BOOTSTRAP_N, seed = 7 } = {}) {
  const byC = new Map()
  for (const it of items) { const c = clusterOf(it); if (!byC.has(c)) byC.set(c, []); byC.get(c).push(valueOf(it)) }
  const clusters = [...byC.values()]
  if (!clusters.length) return { mean: null, lo: null, hi: null, clusters: 0 }
  const rng = mulberry32(seed)
  const means = []
  for (let r = 0; r < n; r++) {
    let s = 0, k = 0
    for (let c = 0; c < clusters.length; c++) { const pick = clusters[Math.floor(rng() * clusters.length)]; for (const v of pick) { s += v; k++ } }
    means.push(k ? s / k : 0)
  }
  means.sort((a, b) => a - b)
  return { mean: mean(items.map(valueOf)), lo: means[Math.floor(0.025 * n)], hi: means[Math.floor(0.975 * n)], clusters: clusters.length }
}

export function marketBucket(spyHold) {
  if (spyHold == null) return null
  return MARKET_BUCKETS.find(([, a, b]) => spyHold > a && spyHold <= b)?.[0] ?? (spyHold <= 0 ? 'down' : 'up')
}

// One period's numbers: strategy vs the three controls.
export function periodResult(paired, randomReps, dcaTrades, { period = null, completedOnly = false } = {}) {
  const inP = (t) => (period == null || periodOf(t.signalT) === period) && (!completedOnly || !t.open)
  const strat = paired.filter(inP)
  const withSpy = strat.filter((t) => t.spyControl != null)
  const months = new Set(strat.map((t) => monthOf(t.signalT))).size
  const diff = clusterBootstrap(withSpy, (t) => t.optionReturn - t.spyControl, (t) => monthOf(t.signalT))
  const stratMean = mean(strat.map((t) => t.optionReturn))
  // Random: mean per replication over this period's trades.
  const repMeans = randomReps.map((rep) => mean(rep.filter(inP).map((t) => t.optionReturn))).filter((x) => x != null)
  const below = repMeans.filter((m) => m < stratMean).length
  const dca = dcaTrades.filter(inP)
  const dcaDiff = clusterBootstrapDiff(strat, dca, (t) => t.optionReturn, (t) => monthOf(t.signalT))
  const lostHalf = (list) => (list.length ? list.filter((t) => t.optionReturn <= -0.5).length / list.length : null)
  return {
    n: strat.length, months, open: strat.filter((t) => t.open).length,
    strategy: { mean: stratMean, median: median(strat.map((t) => t.optionReturn)), win: strat.length ? strat.filter((t) => t.optionReturn > 0).length / strat.length : null, lostHalf: lostHalf(strat) },
    spy: { mean: mean(withSpy.map((t) => t.spyControl)), lostHalf: withSpy.length ? withSpy.filter((t) => t.spyControl <= -0.5).length / withSpy.length : null, diff: diff.mean, lo: diff.lo, hi: diff.hi, n: withSpy.length },
    random: { reps: repMeans.length, mean: mean(repMeans), percentile: repMeans.length ? below / repMeans.length : null },
    dca: { n: dca.length, mean: mean(dca.map((t) => t.optionReturn)), diff: dcaDiff.diff, lo: dcaDiff.lo, hi: dcaDiff.hi },
    sampleFloor: strat.length >= SAMPLE_FLOOR.trades && months >= SAMPLE_FLOOR.months,
  }
}

function median(xs) { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2 }

export function bucketResults(paired) {
  const out = {}
  for (const [k] of MARKET_BUCKETS) {
    const list = paired.filter((t) => marketBucket(t.spyHold) === k)
    const withSpy = list.filter((t) => t.spyControl != null)
    out[k] = { n: list.length, strategy: mean(list.map((t) => t.optionReturn)), spy: mean(withSpy.map((t) => t.spyControl)), win: list.length ? list.filter((t) => t.optionReturn > 0).length / list.length : null }
  }
  return out
}

// The pre-registered rule. `periods` = { P1: periodResult, P2: periodResult }.
export function verdict(periods) {
  const ps = PERIODS.map(([k]) => periods[k]).filter(Boolean)
  if (ps.length < PERIODS.length || ps.some((p) => !p.sampleFloor)) return { verdict: 'inconclusive', why: 'sample floor not met in a period' }
  const edge = ps.every((p) => p.spy.lo != null && p.spy.lo > 0)
    && ps.every((p) => p.random.percentile != null && p.random.percentile >= 0.95)
    && ps.every((p) => p.strategy.lostHalf != null && p.spy.lostHalf != null && p.strategy.lostHalf <= p.spy.lostHalf + 0.05)
  if (edge) return { verdict: 'edge', why: 'CI above zero, ≥95th percentile of random entries, lost-half not worse, in both periods' }
  const noEdge = ps.some((p) => p.spy.diff != null && p.spy.diff <= 0) || ps.every((p) => p.spy.hi != null && p.spy.hi <= 0.10)
  if (noEdge) return { verdict: 'no edge', why: ps.some((p) => p.spy.diff <= 0) ? 'point estimate ≤ 0 in a period' : 'CI upper bound ≤ +10 points in both periods' }
  return { verdict: 'inconclusive', why: 'CI spans zero with an upper bound above +10 points, or edge in one period only' }
}
