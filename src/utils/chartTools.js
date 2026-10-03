// Chart drawing tools for /charts: two-pin Measure, Fibonacci retracement
// + extension levels, and an Auto swing finder. Pure functions — the chart
// component draws what these return. `npm run charttools:check` runs the
// checks in scripts/check-chart-tools.mjs.
//
// Bars are { t, o, h, l, c } where t is 'YYYY-MM-DD' (daily / weekly /
// monthly) or unix seconds of New York wall-clock time (intraday).
// A pin is { t, p }: a bar time and a price (that bar's high or low).

export const FIB_RETRACEMENTS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]
export const FIB_EXTENSIONS = [1.272, 1.618, 2.618]

// A bar time as epoch ms (dates at UTC midnight).
export function barMs(t) {
  if (typeof t === 'number') return t * 1000
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(t ?? ''))
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN
}

// The bar closest in time to t (pins saved on one range land on the
// nearest candle of another). null when t is outside the bars' span by
// more than one bar's width.
export function nearestBarIndex(bars, t) {
  if (!bars?.length) return -1
  let x = barMs(t)
  if (!Number.isFinite(x)) return -1
  const dateBars = typeof bars[0].t === 'string'
  // Mixed granularity: match by calendar day. An intraday pin goes to its
  // day's candle; a daily pin to that day's first intraday candle.
  if (dateBars && typeof t === 'number') x = Math.floor(x / 86400000) * 86400000
  if (!dateBars && typeof t === 'string') {
    const first = bars.findIndex((b) => Math.floor(barMs(b.t) / 86400000) * 86400000 === x)
    if (first >= 0) return first
  }
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < bars.length; i++) {
    const d = Math.abs(barMs(bars[i].t) - x)
    if (d < bestD) { bestD = d; best = i }
  }
  const span = bars.length > 1 ? (barMs(bars[bars.length - 1].t) - barMs(bars[0].t)) / (bars.length - 1) : 86400000
  return bestD <= span * 1.5 ? best : -1
}

// Snap a tap to the bar's high or low, whichever is nearer the tapped price.
export function snapPin(bar, price) {
  if (!bar) return null
  const p = Number.isFinite(price) && Math.abs(price - bar.h) < Math.abs(price - bar.l) ? bar.h : bar.l
  return { t: bar.t, p }
}

// Pins in time order, placed on these bars (null if either is off-range).
export function placePins(bars, pins) {
  if (!pins || pins.length < 2) return null
  const placed = pins.map((pin) => {
    const i = nearestBarIndex(bars, pin.t)
    return i < 0 ? null : { i, t: bars[i].t, p: pin.p }
  })
  if (placed.some((x) => !x)) return null
  return placed[0].i <= placed[1].i ? placed : [placed[1], placed[0]]
}

// The move between two placed pins: $ and % change, bars between, and
// calendar days when the bars carry dates.
export function measure(placed) {
  if (!placed) return null
  const [a, b] = placed
  const change = b.p - a.p
  const days = Math.round((barMs(b.t) - barMs(a.t)) / 86400000)
  return { from: a, to: b, change, pct: a.p > 0 ? change / a.p : null, candles: b.i - a.i, days }
}

// Fibonacci levels for the swing from a (earlier) to b (later).
// Retracements pull back from b toward a (0% = b, 100% = a); extensions
// run past b in the swing's direction. Prices at or below zero are dropped.
export function fibLevels(placed) {
  if (!placed) return []
  const [a, b] = placed
  const diff = b.p - a.p
  if (!diff) return []
  const up = diff > 0
  const out = FIB_RETRACEMENTS.map((r) => ({ kind: 'retracement', ratio: r, price: b.p - r * diff }))
    .concat(FIB_EXTENSIONS.map((e) => ({ kind: 'extension', ratio: e, price: a.p + e * diff })))
  return out.filter((l) => l.price > 0).map((l) => ({ ...l, up, label: `${+(l.ratio * 100).toFixed(1)}%` }))
}

// Auto: the biggest swing in view — the largest rise from a low to a later
// high, or fall from a high to a later low, measured in %. Ties go to the
// more recent swing. Returns two pins or null.
export function autoSwing(bars) {
  if (!bars || bars.length < 3) return null
  let best = null
  let minI = 0
  let maxI = 0
  for (let j = 1; j < bars.length; j++) {
    const rise = bars[minI].l > 0 ? bars[j].h / bars[minI].l - 1 : 0
    if (rise > 0 && (!best || rise >= best.size)) best = { size: rise, a: minI, ap: bars[minI].l, b: j, bp: bars[j].h }
    const fall = bars[maxI].h > 0 ? 1 - bars[j].l / bars[maxI].h : 0
    if (fall > 0 && (!best || fall >= best.size)) best = { size: fall, a: maxI, ap: bars[maxI].h, b: j, bp: bars[j].l }
    if (bars[j].l < bars[minI].l) minI = j
    if (bars[j].h > bars[maxI].h) maxI = j
  }
  if (!best || best.a === best.b) return null
  return [{ t: bars[best.a].t, p: best.ap }, { t: bars[best.b].t, p: best.bp }]
}
