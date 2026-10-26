// The Fade Screen (owner spec, 2026-10-26): six factors scored to 100 on
// pre-revenue small caps — shorts pressing, a failed catalyst, runway,
// insider selling, capital redirect, trend break. Pure facts on a day from
// prices up to that day and filings made by it. Weights are the spec's,
// fixed before the test (docs/signal-engine/preregistration.md, "the Fade
// Screen test"); the test decides what the score means. npm run fade:check.

export const FADE = Object.freeze({
  siRise: 0.15, siDays: 30, siStale: 45, priceDrop: 0.10,          // 1 shorts pressing
  eventJump: 0.10, eventVolX: 3, eventLook: 60, eventWindow: 20,   // 2 failed catalyst
  runwayFull: 3, runwayPartial: 5,                                  // 3 runway (quarters)
  insiderDays: 60,                                                  // 4 insider selling
  trendBelowDays: 10,                                               // 6 trend break
  horizon: 126, fall: 0.40, rise: 1.00,                             // outcomes
  weights: Object.freeze({ shorts: 25, catalyst: 25, runway: 15, insider: 15, redirect: 10, trend: 10 }),
  tiers: Object.freeze({ caution: 30, watch: 50, actionable: 70 }),
})

const DAY = 86400e3
const days = (a, b) => (Date.parse(b) - Date.parse(a)) / DAY
const sma = (xs, n, i) => { if (i < n - 1) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += xs[k]; return s / n }

// ---- SEC facts, compacted (companyfacts JSON is too big to keep per company)
const TAGS = {
  revenue: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueNet'],
  ocf: ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
  cash: ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'],
}
const rowsOf = (facts, tags, unit) => tags.flatMap((t) => facts?.facts?.['us-gaap']?.[t]?.units?.[unit] ?? [])
// → { revenue: [{ end, filed, val }] (annual), ocf: [{ start, end, filed, val }], cash: [{ end, filed, val }], sharesOut: [{ end, filed, val }], hasRevenueTag }
export function compactFacts(facts) {
  const annual = (f) => f.start && f.end && days(f.start, f.end) >= 330 && days(f.start, f.end) <= 400 && /^10-K/.test(f.form ?? '')
  const revenue = rowsOf(facts, TAGS.revenue, 'USD').filter(annual).map((f) => ({ end: f.end, filed: f.filed, val: f.val }))
  const ocf = rowsOf(facts, TAGS.ocf, 'USD').filter((f) => f.start && f.end && f.filed).map((f) => ({ start: f.start, end: f.end, filed: f.filed, val: f.val }))
  const cash = rowsOf(facts, TAGS.cash, 'USD').filter((f) => !f.start && f.end && f.filed).map((f) => ({ end: f.end, filed: f.filed, val: f.val }))
  const sharesOut = (facts?.facts?.dei?.EntityCommonStockSharesOutstanding?.units?.shares ?? []).filter((f) => f.end && f.filed && f.val > 0).map((f) => ({ end: f.end, filed: f.filed, val: f.val }))
  const hasRevenueTag = TAGS.revenue.some((t) => facts?.facts?.['us-gaap']?.[t])
  return { revenue, ocf, cash, sharesOut, hasRevenueTag }
}
const latestFiled = (rows, asOf, pick = (r) => true) => { let b = null; for (const r of rows ?? []) if (r.filed <= asOf && pick(r) && (!b || r.end > b.end || (r.end === b.end && r.filed > b.filed))) b = r; return b }

// Latest annual revenue known by asOf; null when the company reports none.
export const revenueAt = (fin, asOf) => latestFiled(fin.revenue, asOf)?.val ?? null
export const cashAt = (fin, asOf) => latestFiled(fin.cash, asOf)?.val ?? null
export const sharesOutAt = (fin, asOf) => latestFiled(fin.sharesOut, asOf)?.val ?? null

// The latest single quarter's operating cash flow known by asOf: a ~90-day
// row directly, else a YTD row minus the YTD row one quarter shorter with
// the same start.
export function quarterlyOcfAt(fin, asOf) {
  const rows = (fin.ocf ?? []).filter((r) => r.filed <= asOf)
  const quarters = []
  for (const r of rows) {
    const d = days(r.start, r.end)
    if (d >= 80 && d <= 100) quarters.push({ end: r.end, val: r.val, filed: r.filed })
    else if (d > 100 && d <= 380) {
      const prev = rows.find((q) => q.start === r.start && q.end < r.end && days(q.end, r.end) >= 80 && days(q.end, r.end) <= 100)
      if (prev) quarters.push({ end: r.end, val: r.val - prev.val, filed: r.filed })
    }
  }
  let b = null
  for (const q of quarters) if (!b || q.end > b.end || (q.end === b.end && q.filed > b.filed)) b = q
  return b ? b.val : null
}

// ---- factors
// shorts: [{ date, shares }] (FINRA settlements); bars: [{ t, c }]; i: the bar.
export function shortsPressing(shorts, bars, i, p = FADE) {
  const asOf = bars[i].t
  const rows = (shorts ?? []).filter((s) => s.date <= asOf && s.shares != null).sort((a, b) => a.date.localeCompare(b.date))
  const cur = rows[rows.length - 1]
  if (!cur || days(cur.date, asOf) > p.siStale) return { points: 0, known: false }
  let prev = null
  for (const r of rows) { if (days(r.date, cur.date) >= p.siDays) prev = r; else break }
  if (!prev || !(prev.shares > 0)) return { points: 0, known: false }
  const siChange = cur.shares / prev.shares - 1
  let j = i
  while (j > 0 && bars[j - 1].t >= prev.date) j--
  const priceChange = bars[i].c / bars[j].c - 1
  const siUp = siChange >= p.siRise
  return { points: siUp && priceChange <= -p.priceDrop ? p.weights.shorts : siUp ? 10 : 0, known: true, siChange, priceChange }
}

// The long-side inverse (owner spec v2, 2026-10-26; pre-registered before
// its run): short interest DOWN ≥ siRise vs the settlement ~30 days earlier
// while the close is UP ≥ priceDrop over the same span.
export function shortsCovering(shorts, bars, i, p = FADE) {
  const asOf = bars[i].t
  const rows = (shorts ?? []).filter((s) => s.date <= asOf && s.shares != null).sort((a, b) => a.date.localeCompare(b.date))
  const cur = rows[rows.length - 1]
  if (!cur || days(cur.date, asOf) > p.siStale) return { on: false, known: false }
  let prev = null
  for (const r of rows) { if (days(r.date, cur.date) >= p.siDays) prev = r; else break }
  if (!prev || !(prev.shares > 0)) return { on: false, known: false }
  const siChange = cur.shares / prev.shares - 1
  let j = i
  while (j > 0 && bars[j - 1].t >= prev.date) j--
  const priceChange = bars[i].c / bars[j].c - 1
  return { on: siChange <= -p.siRise && priceChange >= p.priceDrop, known: true, siChange, priceChange }
}
// Catalyst held: the latest event day is ≥ eventWindow sessions back and no
// close since has undercut its close.
export function catalystHeld(bars, i, p = FADE) {
  const ev = eventDays(bars, i, p)
  if (!ev.length) return { on: false }
  const k = ev[ev.length - 1]
  if (i - k < p.eventWindow) return { on: false, event: bars[k].t, young: true }
  const level = bars[k].c
  for (let m = k + 1; m <= i; m++) if (bars[m].c < level) return { on: false, event: bars[k].t, brokeOn: bars[m].t }
  return { on: true, event: bars[k].t, level }
}

// Event days inside the look-back: a close up ≥ eventJump on volume ≥ eventVolX × the prior 20-day average.
export function eventDays(bars, i, p = FADE) {
  const out = []
  for (let k = Math.max(21, i - p.eventLook + 1); k <= i; k++) {
    const b = bars[k], a = bars[k - 1]
    if (!(b.v > 0)) continue
    let s = 0
    for (let m = k - 20; m < k; m++) s += bars[m].v ?? 0
    if (b.c / a.c - 1 >= p.eventJump && b.v >= p.eventVolX * (s / 20)) out.push(k)
  }
  return out
}
// Fires when any event's close was undercut within eventWindow sessions, by bar i.
export function failedCatalyst(bars, i, p = FADE) {
  for (const k of eventDays(bars, i, p)) {
    const level = bars[k].c
    for (let m = k + 1; m <= Math.min(i, k + p.eventWindow); m++) if (bars[m].c < level) return { points: p.weights.catalyst, event: bars[k].t, level, brokeOn: bars[m].t }
  }
  return { points: 0 }
}

export function runway(fin, asOf, p = FADE) {
  const cash = cashAt(fin, asOf), burn = quarterlyOcfAt(fin, asOf)
  if (cash == null || burn == null) return { points: 0, known: false }
  if (burn >= 0) return { points: 0, known: true, quarters: Infinity }
  const quarters = cash / -burn
  return { points: quarters < p.runwayFull ? p.weights.runway : quarters < p.runwayPartial ? 8 : 0, known: true, quarters }
}

// Form 4 roles from the bulk file's relationship + title columns.
export function insiderRole(relationship = '', title = '') {
  const t = `${relationship} ${title}`.toLowerCase()
  if (/chief executive|\bceo\b|^president\b|\bpresident and ceo/.test(t)) return 'ceo'
  if (/chief financial|\bcfo\b/.test(t)) return 'cfo'
  if (/officer|chief|\bevp\b|\bsvp\b|vice president|general counsel|secretary|treasurer/.test(t)) return 'officer'
  if (/director/.test(t)) return 'director'
  return 'other'
}
// trades: [{ filed, date, code, role }] for the issuer.
export function insiderSelling(trades, asOf, p = FADE) {
  let buys = 0, best = null
  for (const t of trades ?? []) {
    if (!t.filed || t.filed > asOf || !t.date) continue
    const age = days(t.date, asOf)
    if (age < 0 || age > p.insiderDays) continue
    if (t.code === 'P') buys++
    else if (t.code === 'S') { const rank = t.role === 'ceo' || t.role === 'cfo' ? 2 : t.role === 'officer' ? 1 : 0; if (rank && (!best || rank > best.rank)) best = { rank, role: t.role } }
  }
  if (buys || !best) return { points: 0, buys, sold: !!best }
  return { points: best.rank === 2 ? p.weights.insider : 8, role: best.role, buys }
}

export function trendBreak(bars, i, p = FADE) {
  const c = bars.map((b) => b.c)
  const s50 = sma(c, 50, i), s200 = sma(c, 200, i)
  if (s50 == null || s200 == null || i < p.trendBelowDays) return { points: 0 }
  for (let k = i - p.trendBelowDays + 1; k <= i; k++) { const s = sma(c, 50, k); if (s == null || c[k] >= s) return { points: 0 } }
  return { points: s50 < s200 ? p.weights.trend : 0 }
}

// All six on one bar; `filings` (SEC submissions) drives capital redirect.
export function fadeScore({ bars, i, shorts, trades, fin, filings = null, p = FADE }) {
  const asOf = bars[i].t
  const f = {
    shorts: shortsPressing(shorts, bars, i, p),
    catalyst: failedCatalyst(bars, i, p),
    runway: fin ? runway(fin, asOf, p) : { points: 0, known: false },
    insider: insiderSelling(trades, asOf, p),
    redirect: filings ? capitalRedirect(filings, asOf, p) : { points: 0, known: false },
    trend: trendBreak(bars, i, p),
  }
  const score = Object.values(f).reduce((s, x) => s + x.points, 0)
  return { score, tier: score >= p.tiers.actionable ? 'actionable' : score >= p.tiers.watch ? 'watch' : score >= p.tiers.caution ? 'caution' : 'clear', factors: f }
}

// Outcomes after bar i (null until the horizon is complete).
export function forwardFade(bars, i, p = FADE) {
  const end = i + p.horizon
  if (end >= bars.length) return null
  const c0 = bars[i].c
  let lo = Infinity, hi = 0
  for (let k = i + 1; k <= end; k++) { lo = Math.min(lo, bars[k].l ?? bars[k].c); hi = Math.max(hi, bars[k].h ?? bars[k].c) }
  return { maxFall: lo / c0 - 1, maxRise: hi / c0 - 1, fell: lo / c0 - 1 <= -p.fall, doubled: hi / c0 - 1 >= p.rise, ret: bars[end].c / c0 - 1 }
}

// rows: [{ flagged, fell, doubled, ret }] → rates for the flag vs the base.
export function fadeStats(rows) {
  const med = (xs) => { const v = xs.filter((x) => x != null).sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null }
  const n = rows.length, f = rows.filter((r) => r.flagged)
  const rate = (xs, k) => (xs.length ? xs.filter((r) => r[k]).length / xs.length : null)
  const fellAll = rows.filter((r) => r.fell).length, dblAll = rows.filter((r) => r.doubled).length
  return {
    n, flagged: f.length, baseFell: rate(rows, 'fell'), fellRate: rate(f, 'fell'), baseDoubled: rate(rows, 'doubled'), doubledRate: rate(f, 'doubled'),
    recallFell: fellAll ? f.filter((r) => r.fell).length / fellAll : null, recallDoubled: dblAll ? f.filter((r) => r.doubled).length / dblAll : null,
    medianRet: med(f.map((r) => r.ret)), medianAll: med(rows.map((r) => r.ret)),
  }
}
export const FADE_PASS = Object.freeze({ lift: 2, medianGap: 0.10, minFlagged: 100 })
export function fadeVerdict(s, p = FADE_PASS) {
  if (!s || s.fellRate == null || s.baseFell == null || s.medianRet == null || s.medianAll == null) return 'inconclusive'
  if (s.flagged < p.minFlagged) return 'inconclusive'
  return s.fellRate >= p.lift * s.baseFell && s.doubledRate <= s.baseDoubled && s.medianRet <= s.medianAll - p.medianGap ? 'pass' : 'fail'
}

// ---- financing (SEC submissions: [{ form, date, items }])
export const RAISE_FORMS = Object.freeze({ shelf: ['S-3', 'S-3ASR'], supplement: ['424B5'], raiseItems: ['3.02'] })
// Filings on or before asOf that mark financing capacity or a raise.
export function financingEvents(filings, asOf) {
  const out = { shelves: [], supplements: [], raises: [] }
  for (const f of filings ?? []) {
    if (!f.date || f.date > asOf) continue
    if (RAISE_FORMS.shelf.includes(f.form)) out.shelves.push(f.date)
    if (RAISE_FORMS.supplement.includes(f.form)) { out.supplements.push(f.date); out.raises.push(f.date) }
    if (f.form === '8-K' && (f.items ?? []).some((it) => RAISE_FORMS.raiseItems.includes(it))) out.raises.push(f.date)
  }
  return out
}
// Factor 5: a shelf within 365 days or a supplement within 180 days before asOf.
export function capitalRedirect(filings, asOf, p = FADE) {
  const e = financingEvents(filings, asOf)
  const shelf = e.shelves.some((d) => days(d, asOf) <= 365), atm = e.supplements.some((d) => days(d, asOf) <= 180)
  return { points: shelf || atm ? p.weights.redirect : 0, known: true, shelf, atm }
}
// The first raise filing strictly after asOf, within `horizonDays` calendar days (null if none).
export function raiseAfter(filings, asOf, horizonDays) {
  let first = null
  for (const f of filings ?? []) {
    const isRaise = RAISE_FORMS.supplement.includes(f.form) || (f.form === '8-K' && (f.items ?? []).some((it) => RAISE_FORMS.raiseItems.includes(it)))
    if (!isRaise || !f.date || f.date <= asOf || days(asOf, f.date) > horizonDays) continue
    if (!first || f.date < first) first = f.date
  }
  return first
}
// Rates of an extra yes / no outcome (e.g. raised) for a flag vs the base.
export function outcomeRates(rows, key) {
  const f = rows.filter((r) => r.flagged), all = rows.filter((r) => r[key]).length
  return { base: rows.length ? all / rows.length : null, rate: f.length ? f.filter((r) => r[key]).length / f.length : null, recall: all ? f.filter((r) => r[key]).length / all : null }
}
