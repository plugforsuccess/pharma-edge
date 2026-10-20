// Weakness signals (owner, 2026-10-20: "find stocks that also indicate
// weakness and thus likely will go down"). Pure facts — each one a yes / no
// on a day, from prices up to that day and the annual reports filed by it.
// Thresholds fixed before the test ran (docs/signal-engine/preregistration.md,
// "the weakness test"); the test decides whether the score means anything.
// npm run weakness:check.

export const WEAK = Object.freeze({
  slope200Down: -0.014, // the 200-day down at least 1.4% over 20 days
  nearLow: 0.05,        // close within 5% of the 52-week low
  crash: 0.20,          // close 20%+ under its 20-day high
  stretched: 0.35,      // close 35%+ above the 200-day
  dilution: 0.10,       // diluted shares up more than 10% in a year
  dropHorizon: 126,     // trading days (≈ 6 months) for the outcome
  drop: 0.30,           // a fall of 30% from the close to the lowest low
})

export const PRICE_SIGNALS = ['below200', 'falling200', 'nearLow', 'crash', 'stretched']
export const BUSINESS_SIGNALS = ['negFcf', 'fcfFalling', 'dilution', 'debtUp']

// Price facts on one bar. traits: { vs200, slope200 } (leaders.js at(i));
// bars: [{ h, l, c }], i: the bar. → { below200, falling200, nearLow, crash, stretched }
export function priceWeakness(bars, i, traits, p = WEAK) {
  if (!traits || i < 252) return null
  const c = bars[i].c
  let lo = Infinity, hi20 = 0
  for (let k = i - 251; k <= i; k++) lo = Math.min(lo, bars[k].l ?? bars[k].c)
  for (let k = Math.max(0, i - 19); k <= i; k++) hi20 = Math.max(hi20, bars[k].h ?? bars[k].c)
  return {
    below200: traits.vs200 < 0,
    falling200: traits.slope200 <= p.slope200Down,
    nearLow: c <= lo * (1 + p.nearLow),
    crash: hi20 > 0 && c <= hi20 * (1 - p.crash),
    stretched: traits.vs200 >= p.stretched,
  }
}

// Business facts from the annual rows known by the day (quality.js
// annualFinancials, oldest first). null when there is no annual report.
export function businessWeakness(rows, p = WEAK) {
  if (!rows?.length) return null
  const cur = rows[rows.length - 1], prev = rows[rows.length - 2], prev2 = rows[rows.length - 3]
  const num = (x) => x != null && Number.isFinite(x)
  return {
    negFcf: num(cur.fcf) && cur.fcf < 0,
    fcfFalling: !!(prev && prev2 && num(cur.fcf) && num(prev.fcf) && num(prev2.fcf) && cur.fcf < prev.fcf && prev.fcf < prev2.fcf),
    dilution: !!(prev && num(cur.shares) && num(prev.shares) && prev.shares > 0 && cur.shares / prev.shares - 1 > p.dilution),
    debtUp: !!(prev && num(cur.netDebt) && num(prev.netDebt) && num(cur.fcf) && num(prev.fcf) && cur.netDebt > prev.netDebt && cur.fcf < prev.fcf),
  }
}

// → { price, business, score, lit } — counts of signals lit.
export function weaknessScore(price, business) {
  const lit = [...PRICE_SIGNALS.filter((k) => price?.[k]), ...BUSINESS_SIGNALS.filter((k) => business?.[k])]
  const pc = PRICE_SIGNALS.filter((k) => price?.[k]).length
  const bc = BUSINESS_SIGNALS.filter((k) => business?.[k]).length
  return { price: pc, business: bc, score: pc + bc, lit }
}

// The outcome after bar i: the deepest fall from the close to a later low
// within the horizon, and the return at the horizon's end. null when the
// horizon isn't complete yet (no partial grades).
export function forwardDrop(bars, i, p = WEAK) {
  const end = i + p.dropHorizon
  if (end >= bars.length) return null
  const c0 = bars[i].c
  let lo = Infinity
  for (let k = i + 1; k <= end; k++) lo = Math.min(lo, bars[k].l ?? bars[k].c)
  const maxFall = lo / c0 - 1
  return { maxFall, dropped: maxFall <= -p.drop, ret: bars[end].c / c0 - 1 }
}

// Precision / recall / lift of a flag over stock-months.
// rows: [{ flagged, dropped, ret }] → { n, flagged, base, precision, recall, lift, medianRet, medianAll }
export function flagStats(rows) {
  const med = (xs) => { const v = xs.filter((x) => x != null).sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null }
  const n = rows.length
  const drops = rows.filter((r) => r.dropped).length
  const f = rows.filter((r) => r.flagged)
  const hit = f.filter((r) => r.dropped).length
  const base = n ? drops / n : null
  const precision = f.length ? hit / f.length : null
  return { n, flagged: f.length, drops, base, precision, recall: drops ? hit / drops : null, lift: base && precision != null ? precision / base : null, medianRet: med(f.map((r) => r.ret)), medianAll: med(rows.map((r) => r.ret)) }
}

// The pre-registered pass mark (preregistration.md, "the weakness test").
export const WEAK_PASS = Object.freeze({ lift: 2, recall: 0.3, medianGap: 0.05 })
export function weakVerdict(s, p = WEAK_PASS) {
  if (!s || s.lift == null || s.recall == null || s.medianRet == null || s.medianAll == null) return 'inconclusive'
  return s.lift >= p.lift && s.recall >= p.recall && s.medianRet <= s.medianAll - p.medianGap ? 'pass' : 'fail'
}
