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
  const slope = fast.map((f, i) => (f != null && fast[i - p.slopeLookback] != null ? f - fast[i - p.slopeLookback] : null))
  const ok = (i) => basis[i] != null && fast[i] != null && slope[i] != null && i > 0
  const bravoBullRaw = bars.map((_, i) => ok(i) && close[i] > basis[i] && fast[i] > basis[i] && slope[i] > 0 && close[i] > close[i - 1])
  const bravoBearRaw = bars.map((_, i) => ok(i) && close[i] < basis[i] && fast[i] < basis[i] && slope[i] < 0 && close[i] < close[i - 1])
  const bravoBull = cooldown(bravoBullRaw, p.bravoCooldown)
  const bravoBear = cooldown(bravoBearRaw, p.bravoCooldown)
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
    bravo: { basis, upperBand, lowerBand, fast, bull: bravoBull, bear: bravoBear, regime },
    echo: { line: echo, ...echoRails, bull: echoBull, bear: echoBear },
    tango: { line: tango, ...tangoRails, bull: tangoBull, bear: tangoBear },
    signals,
    candidates,
    bulls: signals.filter((s) => s.side === 'bull'),
    bears: signals.filter((s) => s.side === 'bear'),
    exits,
  }
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
