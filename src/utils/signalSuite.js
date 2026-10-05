// Signal suite — a port of the Bravo / Echo / Tango / Hardening / Exit Meta
// Pine scripts (plugforsuccess/wiley-indicator-suite) to daily bars, for the
// entry chart (/charts/entry/:ticker). Pure functions.
// `npm run suite:check` runs scripts/check-signal-suite.mjs.
//
//   Bravo     trend: EMA(hl2, 200) basis ± 2 × ATR(200), fast EMA(hl2, 21)
//             with its 5-bar slope. Bull = close and fast EMA above the
//             basis, fast EMA rising, up close (bear mirrored); 5-bar
//             cooldown between same-side signals.
//   Echo      momentum: RSI(14) − 50, EMA(3). Adaptive rails = the 80th /
//             20th percentile (nearest rank) of its last 200 values, ±30
//             until then. Bull = crosses back up through the lower rail and
//             rising (bear mirrored); 5-bar cooldown.
//   Tango     flow: MFI(hlc3, 20) − 50, EMA(9) twice. Same rails as Echo,
//             and the cross needs volume above its 20-day average; 8-bar
//             cooldown.
//   Hardening all three pillars fire within 5 bars (bull) / 60 bars
//             (bear); fires on the bar that completes the set. Then: volume
//             ≥ its 20-day average, the daily Bravo regime agrees, Echo moved
//             ≥ 15 points over 5 bars, ATR(14) ≥ 1.1 × its value 5 bars ago,
//             and (bulls only) VIX < 30. Stars = 1 + boosters (beats SPY
//             over 20 bars, volume ≥ 2 × average, range ≥ 1.5 × ATR), max 4.
//   Exits     a long is exited when Echo or Tango fires bear, or Bravo's
//             regime flips from bull. Glyphs E / T / B.
//
// Two deliberate differences from the Pine (owner-visible, documented in
// CLAUDE.md): the Pine "regime flip" and "daily agreement" read Bravo's
// cooldown-gated signal stream, which drops to 0 the bar after every signal
// — so the flip exit fired right after nearly every Bravo signal and the
// daily agreement only passed on Bravo's own signal bars. Here both read
// Bravo's regime: close and the fast EMA above the basis (bull) / below
// (bear).

import { ema, sma, rsi } from './indicators.js'

export const SUITE_PARAMS = Object.freeze({
  bandLength: 200, fastLength: 21, bandMult: 2, slopeLookback: 5, bravoCooldown: 5,
  echoLength: 14, echoSmooth: 3, echoCooldown: 5,
  tangoLength: 20, tangoSmooth: 9, tangoCooldown: 8,
  railLookback: 200, railUpper: 80, railLower: 20, staticRail: 30,
  windowBull: 5, windowBear: 60, volumeFloor: 1, velocityPts: 15, velocityBars: 5,
  atrExpansion: 1.1, vixMax: 30,
})

// Wilder's moving average (Pine ta.rma), seeded with the SMA of the first n.
export function rma(values, n) {
  const out = new Array(values.length).fill(null)
  let prev = null
  let sum = 0
  let count = 0
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (v == null) continue
    if (prev == null) {
      sum += v; count++
      if (count === n) { prev = sum / n; out[i] = prev }
      continue
    }
    prev = (prev * (n - 1) + v) / n
    out[i] = prev
  }
  return out
}

export function atr(bars, n) {
  const tr = bars.map((b, i) => (i === 0 ? b.h - b.l
    : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c))))
  return rma(tr, n)
}

// Money Flow Index (Pine ta.mfi).
export function mfi(src, volume, n) {
  const out = new Array(src.length).fill(null)
  const up = src.map((s, i) => (i > 0 && s > src[i - 1] ? s * volume[i] : 0))
  const dn = src.map((s, i) => (i > 0 && s < src[i - 1] ? s * volume[i] : 0))
  let u = 0
  let d = 0
  for (let i = 1; i < src.length; i++) {
    u += up[i]; d += dn[i]
    if (i > n) { u -= up[i - n]; d -= dn[i - n] }
    if (i >= n) out[i] = d === 0 ? 100 : 100 - 100 / (1 + u / d)
  }
  return out
}

// Pine ta.percentile_nearest_rank over the last n values (null until n).
export function percentileNearestRank(values, n, pct) {
  const out = new Array(values.length).fill(null)
  for (let i = n - 1; i < values.length; i++) {
    const w = values.slice(i - n + 1, i + 1)
    if (w.some((x) => x == null)) continue
    w.sort((a, b) => a - b)
    const rankIdx = Math.max(0, Math.ceil((pct / 100) * n) - 1)
    out[i] = w[rankIdx]
  }
  return out
}

// Same-side signals at least `bars` apart.
function cooldown(raw, bars) {
  let last = -Infinity
  return raw.map((r, i) => {
    if (r && i - last >= bars) { last = i; return true }
    return false
  })
}

// Bars since `flags` was last true (Pine ta.barssince), null if never.
function barsSince(flags) {
  let last = null
  return flags.map((f, i) => { if (f) last = i; return last == null ? null : i - last })
}

// Map an external daily series ({ t, c }) onto the bars' days (last known
// value carried forward; null before the first).
export function alignCloses(bars, series = []) {
  const byDay = new Map(series.map((b) => [b.t, b.c]))
  let last = null
  return bars.map((b) => { if (byDay.has(b.t)) last = byDay.get(b.t); return last })
}

function oscillator(line, p) {
  const upper = percentileNearestRank(line, p.railLookback, p.railUpper).map((v) => v ?? p.staticRail)
  const lower = percentileNearestRank(line, p.railLookback, p.railLower).map((v) => v ?? -p.staticRail)
  return { upper, lower }
}

export function suiteModel(bars, { spy = [], vix = [], params = SUITE_PARAMS } = {}) {
  const p = { ...SUITE_PARAMS, ...params }
  const n = bars.length
  const close = bars.map((b) => b.c)
  const vol = bars.map((b) => b.v || 0)
  const hl2 = bars.map((b) => (b.h + b.l) / 2)
  const hlc3 = bars.map((b) => (b.h + b.l + b.c) / 3)
  const volAvg = sma(vol, 20)

  // Bravo
  const basis = ema(hl2, p.bandLength)
  const bandAtr = atr(bars, p.bandLength)
  const upperBand = basis.map((b, i) => (b != null && bandAtr[i] != null ? b + bandAtr[i] * p.bandMult : null))
  const lowerBand = basis.map((b, i) => (b != null && bandAtr[i] != null ? b - bandAtr[i] * p.bandMult : null))
  const fast = ema(hl2, p.fastLength)
  // Reclaim zone (owner, 2026-10-05): Bravo's basis ± half an ATR(200) — a
  // quarter of the band each side; the strip the regime flips in. Price
  // above it = reclaimed, below = lost, inside = contested.
  const zoneHigh = basis.map((b, i) => (b != null && bandAtr[i] != null ? b + bandAtr[i] * 0.5 : null))
  const zoneLow = basis.map((b, i) => (b != null && bandAtr[i] != null ? b - bandAtr[i] * 0.5 : null))
  const slope = fast.map((f, i) => (f != null && fast[i - p.slopeLookback] != null ? f - fast[i - p.slopeLookback] : null))
  const ok = (i) => basis[i] != null && fast[i] != null && slope[i] != null && i > 0
  const bravoBullRaw = bars.map((_, i) => ok(i) && close[i] > basis[i] && fast[i] > basis[i] && slope[i] > 0 && close[i] > close[i - 1])
  const bravoBearRaw = bars.map((_, i) => ok(i) && close[i] < basis[i] && fast[i] < basis[i] && slope[i] < 0 && close[i] < close[i - 1])
  const bravoBull = cooldown(bravoBullRaw, p.bravoCooldown)
  const bravoBear = cooldown(bravoBearRaw, p.bravoCooldown)
  // Diamonds: exactly the Pine's plotted "visual" event — the bar the raw
  // condition turns on after being off, no cooldown (owner, 2026-10-03: the
  // Bravo diamonds must match TradingView; a cooldown hid most of them).
  const bravoBullOn = bravoBullRaw.map((x, i) => x && !bravoBullRaw[i - 1])
  const bravoBearOn = bravoBearRaw.map((x, i) => x && !bravoBearRaw[i - 1])
  // Regime: above / below the basis with the fast EMA on the same side.
  const regime = bars.map((_, i) => (basis[i] == null || fast[i] == null ? 0
    : close[i] > basis[i] && fast[i] > basis[i] ? 1 : close[i] < basis[i] && fast[i] < basis[i] ? -1 : 0))

  // Echo
  const echo = ema(rsi(close, p.echoLength).map((v) => (v == null ? null : v - 50)), p.echoSmooth)
  const echoRails = oscillator(echo, p)
  const crossUp = (line, rail, i) => i > 0 && line[i] != null && line[i - 1] != null && line[i - 1] <= rail.lower[i - 1] && line[i] > rail.lower[i] && line[i] > line[i - 1]
  const crossDn = (line, rail, i) => i > 0 && line[i] != null && line[i - 1] != null && line[i - 1] >= rail.upper[i - 1] && line[i] < rail.upper[i] && line[i] < line[i - 1]
  const echoBull = cooldown(bars.map((_, i) => crossUp(echo, echoRails, i)), p.echoCooldown)
  const echoBear = cooldown(bars.map((_, i) => crossDn(echo, echoRails, i)), p.echoCooldown)

  // Tango
  const tango = ema(ema(mfi(hlc3, vol, p.tangoLength).map((v) => (v == null ? null : v - 50)), p.tangoSmooth), p.tangoSmooth)
  const tangoRails = oscillator(tango, p)
  const volUp = (i) => volAvg[i] != null && vol[i] > volAvg[i]
  const tangoBull = cooldown(bars.map((_, i) => crossUp(tango, tangoRails, i) && volUp(i)), p.tangoCooldown)
  const tangoBear = cooldown(bars.map((_, i) => crossDn(tango, tangoRails, i) && volUp(i)), p.tangoCooldown)

  // Hardening
  const within = (flags, w) => barsSince(flags).map((x) => x != null && x <= w)
  const [bB, eB, tB] = [within(bravoBull, p.windowBull), within(echoBull, p.windowBull), within(tangoBull, p.windowBull)]
  const [bS, eS, tS] = [within(bravoBear, p.windowBear), within(echoBear, p.windowBear), within(tangoBear, p.windowBear)]
  const atr14 = atr(bars, 14)
  const spyC = alignCloses(bars, spy)
  const vixC = alignCloses(bars, vix)
  const ret20 = (arr, i) => (i >= 20 && arr[i] != null && arr[i - 20] ? (arr[i] - arr[i - 20]) / arr[i - 20] : null)

  const signals = []
  const candidates = [] // every completed set, with the gates it passed
  for (let i = 1; i < n; i++) {
    const bullSet = bB[i] && eB[i] && tB[i]
    const bearSet = bS[i] && eS[i] && tS[i]
    const bullFire = bullSet && !(bB[i - 1] && eB[i - 1] && tB[i - 1])
    const bearFire = bearSet && !(bS[i - 1] && eS[i - 1] && tS[i - 1])
    if (!bullFire && !bearFire) continue
    const side = bullFire ? 'bull' : 'bear'
    const floor = volAvg[i] != null && vol[i] >= volAvg[i] * p.volumeFloor
    const htf = side === 'bull' ? regime[i] === 1 : regime[i] === -1
    const move = echo[i] != null && echo[i - p.velocityBars] != null ? echo[i] - echo[i - p.velocityBars] : null
    const velocity = move != null && (side === 'bull' ? move >= p.velocityPts : move <= -p.velocityPts)
    const atrOk = atr14[i] != null && atr14[i - 5] != null && atr14[i] > atr14[i - 5] * p.atrExpansion
    const vixOk = side === 'bear' || vixC[i] == null || vixC[i] < p.vixMax
    candidates.push({ i, t: bars[i].t, side, gates: { volume: floor, regime: htf, velocity, atr: atrOk, vix: vixOk } })
    if (!(floor && htf && velocity && atrOk && vixOk)) continue
    const rs = ret20(close, i) != null && ret20(spyC, i) != null && ret20(close, i) > ret20(spyC, i)
    const spike = volAvg[i] != null && vol[i] > volAvg[i] * 2
    const range = atr14[i] != null && bars[i].h - bars[i].l > atr14[i] * 1.5
    const glyphs = [rs && 'RS', spike && 'Vol', range && 'Range'].filter(Boolean)
    signals.push({ i, t: bars[i].t, side, stars: Math.min(1 + glyphs.length, 4), boosters: glyphs, price: close[i] })
  }

  // Exit Meta (longs): opposite Echo / Tango, or the regime leaving bull.
  const exits = []
  for (let i = 1; i < n; i++) {
    const why = [echoBear[i] && 'E', tangoBear[i] && 'T', regime[i - 1] === 1 && regime[i] !== 1 && 'B'].filter(Boolean)
    if (why.length) exits.push({ i, t: bars[i].t, why, price: close[i] })
  }

  return {
    params: p,
    bravo: { basis, upperBand, lowerBand, zoneLow, zoneHigh, fast, bull: bravoBull, bear: bravoBear, bullOn: bravoBullOn, bearOn: bravoBearOn, regime },
    echo: { line: echo, ...echoRails, bull: echoBull, bear: echoBear },
    tango: { line: tango, ...tangoRails, bull: tangoBull, bear: tangoBear },
    signals,
    candidates,
    bulls: signals.filter((s) => s.side === 'bull'),
    bears: signals.filter((s) => s.side === 'bear'),
    exits,
  }
}

// Triple event (owner, 2026-10-05): Bravo, Echo and Tango all turn bullish
// (or all bearish) within `within` bars — Bravo = its trend condition
// turning on (the B diamond), Echo / Tango = their line crossing zero (the
// pillar turning positive / negative; their rail-cross signals are rarer and
// cooldown-gated, so "all three within 2 bars" almost never met on them).
// Fires once, on the bar the third one arrives; a second firing inside
// `within` bars is folded into the first. Same math on daily or weekly
// bars. Without a `line` (synthetic suites) the pillar's bull / bear flags
// are used as the turns.
export function tripleEvents(suite, within = 2) {
  const n = suite.bravo.bullOn.length
  const zeroCross = (line, up) => line.map((v, i) => i > 0 && v != null && line[i - 1] != null && (up ? line[i - 1] <= 0 && v > 0 : line[i - 1] >= 0 && v < 0))
  const turns = (o, up) => (o.line ? zeroCross(o.line, up) : up ? o.bull : o.bear)
  const lastTrue = (arr) => { const out = new Array(n).fill(-1); let L = -1; for (let i = 0; i < n; i++) { if (arr[i]) L = i; out[i] = L } return out }
  const side = (a, b, c) => {
    const la = lastTrue(a), lb = lastTrue(b), lc = lastTrue(c)
    const out = new Array(n).fill(false)
    let last = -Infinity
    for (let i = 0; i < n; i++) {
      if (!(a[i] || b[i] || c[i])) continue
      const oldest = Math.min(la[i], lb[i], lc[i])
      if (oldest < 0 || i - oldest > within) continue
      if (i - last <= within) continue
      out[i] = true
      last = i
    }
    return out
  }
  return { bull: side(suite.bravo.bullOn, turns(suite.echo, true), turns(suite.tango, true)), bear: side(suite.bravo.bearOn, turns(suite.echo, false), turns(suite.tango, false)), within }
}

// Forward stock returns after each event (63 / 126 / 252 trading days).
export function forwardReturns(closes, events, horizons) {
  return events.map((e) => ({
    ...e,
    returns: horizons.map(([, h]) => (e.i + h < closes.length ? closes[e.i + h] / closes[e.i] - 1 : null)),
  }))
}

// Per-horizon stats; `win` decides what counts as a win (rise for buys,
// fall for sells).
export function horizonStats(trades, horizons, win = (r) => r > 0) {
  return horizons.map(([label], h) => {
    const done = trades.map((tr) => tr.returns[h]).filter((x) => x != null)
    return {
      label, n: done.length,
      winRate: done.length ? done.filter(win).length / done.length : null,
      avg: done.length ? done.reduce((s, x) => s + x, 0) / done.length : null,
    }
  })
}

// ---------------------------------------------------------------------------
// Weekly / monthly suite on the daily chart (owner, 2026-10-03: Hardening
// reads weekly or monthly, not daily). The suite runs on the period bars;
// each period's values land on the daily candle its period closes on (the
// last trading day of that week / month — the current period's latest day
// while it's still open), so nothing shows before it happened.
// ---------------------------------------------------------------------------

export const SUITE_TIMEFRAMES = {
  // Daily = the chart's own bars, like TradingView on a daily chart.
  '1d': { label: 'Daily', unit: 'day', horizons: [['3M', 63], ['6M', 126], ['12M', 252]], fresh: 10 },
  '1wk': { label: 'Weekly', unit: 'week', horizons: [['3M', 13], ['6M', 26], ['12M', 52]], fresh: 2 },
  '1mo': { label: 'Monthly', unit: 'month', horizons: [['3M', 3], ['6M', 6], ['12M', 12]], fresh: 1 },
}

// Period key of a 'YYYY-MM-DD' date: the week's Monday, or 'YYYY-MM'.
export function periodKey(t, tf) {
  if (tf === '1d') return String(t).slice(0, 10)
  if (tf === '1mo') return String(t).slice(0, 7)
  const d = new Date(`${String(t).slice(0, 10)}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d.toISOString().slice(0, 10)
}

// One bar per period (Yahoo can repeat the current period as a live bar:
// the last one wins, keeping the period's first date).
export function normalizePeriods(bars, tf) {
  const out = []
  for (const b of bars ?? []) {
    const k = periodKey(b.t, tf)
    if (out.length && out[out.length - 1].k === k) out[out.length - 1] = { ...b, t: out[out.length - 1].t, k }
    else out.push({ ...b, k })
  }
  return out
}

// For each period bar, the index of the daily bar its period closes on
// (-1 when that period isn't in the daily bars).
export function periodCloseDays(dailyBars, periodBars, tf) {
  const lastDay = new Map()
  dailyBars.forEach((b, i) => lastDay.set(periodKey(b.t, tf), i))
  return periodBars.map((p) => lastDay.get(p.k ?? periodKey(p.t, tf)) ?? -1)
}

// Per-day step series: each day shows the latest period that has closed on
// or before it (null before the first).
export function stepToDays(values, closeDays, nDays) {
  const out = new Array(nDays).fill(null)
  let k = 0
  let cur = null
  for (let d = 0; d < nDays; d++) {
    while (k < closeDays.length && (closeDays[k] < 0 || closeDays[k] <= d)) {
      if (closeDays[k] >= 0) cur = values[k]
      k++
    }
    out[d] = cur
  }
  return out
}

// Flags on periods → flags on their close days.
function flagsToDays(flags, closeDays, nDays) {
  const out = new Array(nDays).fill(false)
  flags.forEach((f, k) => { if (f && closeDays[k] >= 0) out[closeDays[k]] = true })
  return out
}

// The suite model reshaped for the daily chart: per-day series (step) and
// flags, events with `i` = their close day (and `pi` = period index). Events
// before the daily bars keep i = -1 (backtest only).
export function suiteOnDays(dailyBars, periodBars, suite, tf) {
  const n = dailyBars.length
  const cd = periodCloseDays(dailyBars, periodBars, tf)
  const step = (arr) => stepToDays(arr, cd, n)
  const flags = (arr) => flagsToDays(arr, cd, n)
  const ev = (list) => list.map((e) => ({ ...e, pi: e.i, i: cd[e.i] ?? -1 }))
  const osc = (o) => ({ line: step(o.line), upper: step(o.upper), lower: step(o.lower), bull: flags(o.bull), bear: flags(o.bear) })
  const signals = ev(suite.signals)
  return {
    tf, closeDays: cd,
    bravo: {
      basis: step(suite.bravo.basis), upperBand: step(suite.bravo.upperBand), lowerBand: step(suite.bravo.lowerBand),
      fast: step(suite.bravo.fast), bull: flags(suite.bravo.bull), bear: flags(suite.bravo.bear),
      bullOn: flags(suite.bravo.bullOn), bearOn: flags(suite.bravo.bearOn), regime: step(suite.bravo.regime).map((x) => x ?? 0),
      zoneLow: step(suite.bravo.zoneLow), zoneHigh: step(suite.bravo.zoneHigh),
    },
    echo: osc(suite.echo),
    tango: osc(suite.tango),
    signals,
    bulls: signals.filter((x) => x.side === 'bull'),
    bears: signals.filter((x) => x.side === 'bear'),
    exits: ev(suite.exits),
    candidates: ev(suite.candidates),
  }
}
