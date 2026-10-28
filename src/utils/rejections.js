// Price rejection levels (owner, 2026-10-28: "an indicator that shows all
// price rejection levels"). A rejection is a bar that pushed into a price
// and closed back away from it with a wick: an upper wick at a ceiling, a
// lower wick at a floor. Levels come from confirmed swing highs and lows,
// merged when they sit within half an ATR of each other; each level counts
// every bar that rejected it. Facts about past prices, no forecast.
// Pure; npm run rejections:check.

export const REJECTION = Object.freeze({
  pivot: 5,         // a swing high / low is the extreme of 5 bars either side
  atrBars: 14,
  tolAtr: 0.5,      // levels within ½ ATR merge; a touch is within ½ ATR of the level
  minTolPct: 0.004, // never tighter than 0.4% of price
  wick: 0.3,        // the rejecting wick is ≥ 30% of the bar's range
  closeAway: 0.25,  // and the close ends ≥ ¼ of the tolerance away from the level
  gap: 3,           // touches on bars within 3 of each other count once
  turn: 2,          // the rejecting bar is the high (ceiling) or low (floor) of 2 bars either side: a turn, not a mid-range wick
  minTouches: 2,
})

export function atrAt(bars, n = REJECTION.atrBars) {
  const out = new Array(bars.length).fill(null)
  let s = 0
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], pc = i ? bars[i - 1].c : b.c
    const tr = Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc))
    s += tr
    if (i >= n) s -= Math.max(bars[i - n].h - bars[i - n].l, Math.abs(bars[i - n].h - (i - n ? bars[i - n - 1].c : bars[i - n].c)), Math.abs(bars[i - n].l - (i - n ? bars[i - n - 1].c : bars[i - n].c)))
    if (i >= n - 1) out[i] = s / n
  }
  return out
}

export function swings(bars, k = REJECTION.pivot) {
  const out = []
  for (let i = k; i < bars.length - k; i++) {
    let hi = true, lo = true
    for (let j = i - k; j <= i + k && (hi || lo); j++) {
      if (j === i) continue
      if (bars[j].h > bars[i].h || (bars[j].h === bars[i].h && j < i)) hi = false
      if (bars[j].l < bars[i].l || (bars[j].l === bars[i].l && j < i)) lo = false
    }
    if (hi) out.push({ i, price: bars[i].h, side: 'high' })
    if (lo) out.push({ i, price: bars[i].l, side: 'low' })
  }
  return out
}

// → [{ price, touches, fromAbove, fromBelow, first, last, role }] strongest first.
// fromAbove = rejections of price pushing up into it (a ceiling); fromBelow = pushing down (a floor).
// The tolerance is set per bar from that bar's ATR (owner, 2026-10-28: on a stock that
// doubled, today's ATR applied to old prices merged years of a base into one "18×" floor).
// from: only swings and rejections on bars from this index on count (owner, 2026-10-28:
// "the number of times depends on the chart window selected") — earlier bars still warm up the ATR.
export function rejectionLevels(bars, p = REJECTION, { from = 0 } = {}) {
  if (!bars?.length || bars.length < p.pivot * 2 + p.atrBars) return []
  const atr = atrAt(bars, p.atrBars)
  const firstAtr = atr.find((x) => x != null) ?? 0
  const tolAt = (i) => Math.max((atr[i] ?? firstAtr) * p.tolAtr, bars[i].c * p.minTolPct)
  const lastClose = bars[bars.length - 1].c
  // 1. Cluster swing prices; a level is at most one tolerance wide (from its lowest swing).
  const piv = swings(bars, p.pivot).filter((x) => x.i >= from).sort((a, b) => a.price - b.price)
  const clusters = []
  for (const s of piv) {
    const c = clusters[clusters.length - 1]
    if (c && s.price - c.min <= tolAt(s.i)) { c.sum += s.price; c.n++ } else clusters.push({ sum: s.price, n: 1, min: s.price })
  }
  // 2. Count rejections at each level, each bar judged on its own tolerance.
  const levels = []
  for (const c of clusters) {
    const L = c.sum / c.n
    let above = 0, below = 0, first = null, last = null, lastI = -Infinity
    for (let i = Math.max(0, from); i < bars.length; i++) {
      const b = bars[i], range = b.h - b.l
      if (!(range > 0)) continue
      const tol = tolAt(i)
      if (b.h < L - tol || b.l > L + tol) continue
      const upWick = (b.h - Math.max(b.o, b.c)) / range, dnWick = (Math.min(b.o, b.c) - b.l) / range
      let topTurn = true, botTurn = true
      for (let j = Math.max(0, i - p.turn); j <= Math.min(bars.length - 1, i + p.turn); j++) { if (j === i) continue; if (bars[j].h > b.h) topTurn = false; if (bars[j].l < b.l) botTurn = false }
      const ceiling = topTurn && b.h >= L - tol && b.h <= L + tol && b.c <= L - p.closeAway * tol && upWick >= p.wick
      const floor = botTurn && b.l <= L + tol && b.l >= L - tol && b.c >= L + p.closeAway * tol && dnWick >= p.wick
      if (!ceiling && !floor) continue
      if (i - lastI <= p.gap) continue
      lastI = i
      if (ceiling) above++; else below++
      if (first == null) first = i
      last = i
    }
    const touches = above + below
    if (touches >= p.minTouches) levels.push({ price: L, touches, fromAbove: above, fromBelow: below, first, last, role: L >= lastClose ? 'resistance' : 'support' })
  }
  return levels.sort((a, b) => b.touches - a.touches || b.last - a.last)
}

// What the chart draws: the nearest `perSide` ceilings above and floors below the
// last close, within `within` of it (owner, 2026-10-28: six floors 25–55% under
// CSCO and nothing near the price read as broken).
export const NEAREST = Object.freeze({ perSide: 3, within: 0.35 })
export function nearestLevels(levels, lastClose, { perSide = NEAREST.perSide, within = NEAREST.within } = {}) {
  const near = levels.filter((l) => Math.abs(l.price / lastClose - 1) <= within)
  const by = (role) => near.filter((l) => l.role === role).sort((a, b) => Math.abs(a.price - lastClose) - Math.abs(b.price - lastClose)).slice(0, perSide)
  return [...by('resistance'), ...by('support')]
}
