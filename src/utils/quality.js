// Cash-flow quality for leaders (owner, 2026-10-19: "the engine needs to
// recommend leaders because they should be strong cash flowing companies" →
// "We need ETFs and oil too"). Pure: reads a company's SEC XBRL
// "companyfacts" JSON (data.sec.gov/api/xbrl/companyfacts/CIK##########.json)
// and judges it only on annual reports filed on or before the given date — no
// hindsight. Funds (ETFs, commodity pools like USO) have no company cash flow:
// isFund() exempts them and they're judged on price alone. npm run quality:check.

export const QUALITY = Object.freeze({
  fcfMarginMin: 0.05,   // free cash flow ≥ 5% of revenue
  netDebtYearsMax: 3,   // (debt − cash) ≤ 3 years of free cash flow
  shareGrowthMax: 0.05, // diluted shares up no more than 5% in a year
})

// Oil producers, refiners, services and pipelines (owner, 2026-10-20: "Looser
// oil rule, test first"; fixed before the test): refiners run thin margins,
// producers carry more debt through the cycle, and oil deals are often paid in
// shares (COP–Marathon) — so a lower margin bar, more debt room and a dilution
// cap that only catches real share printing.
export const QUALITY_OIL = Object.freeze({ fcfMarginMin: 0.02, netDebtYearsMax: 5, shareGrowthMax: 0.15 })
export const OIL_GROUPS = new Set(['Oil', 'Refiners', 'Oil services', 'Pipelines'])
export const qualityParams = (group) => (OIL_GROUPS.has(group) ? QUALITY_OIL : QUALITY)

// Index, sector, commodity and thematic funds in the app's ticker list.
export const FUNDS = new Set([
  'SPY', 'QQQ', 'IWM', 'DIA', 'GLD', 'SLV', 'TLT', 'USO', 'SMH', 'DRAM',
  'XLK', 'XLF', 'XLV', 'XLE', 'XLI', 'XLY', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLC',
])
export const isFund = (symbol, label = '') => FUNDS.has(String(symbol).toUpperCase()) || /\b(ETF|ETN|Fund|Trust)\b/.test(label)

const TAGS = {
  ocf: ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
  capex: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets', 'PaymentsForCapitalImprovements'],
  revenue: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueNet'],
  debtTotal: ['LongTermDebt'],
  debtNoncurrent: ['LongTermDebtNoncurrent'],
  debtCurrent: ['LongTermDebtCurrent'],
  cash: ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'],
  shares: ['WeightedAverageNumberOfDilutedSharesOutstanding'],
}
const DAY = 86400e3
const isAnnualForm = (f) => /^10-K/.test(f ?? '')

// Every fact across the tags, each marked with its tag's priority (0 = first).
// Companies switch tags over the years (Revenues → RevenueFromContract…), so
// taking only the first tag that has any facts can read a stale year.
function factsFor(facts, tags, unit) {
  const g = facts?.facts?.['us-gaap'] ?? {}
  return tags.flatMap((t, rank) => (g[t]?.units?.[unit] ?? []).map((f) => ({ ...f, rank })))
}

// Annual (≈ 1-year duration) values from 10-Ks filed by asOf, keyed by period end.
function annualSeries(facts, tags, unit, asOf) {
  const out = new Map()
  for (const f of factsFor(facts, tags, unit)) {
    if (!isAnnualForm(f.form) || !f.start || !f.end || f.filed > asOf) continue
    const days = (Date.parse(f.end) - Date.parse(f.start)) / DAY
    if (days < 330 || days > 400) continue
    const prev = out.get(f.end)
    if (!prev || f.rank < prev.rank || (f.rank === prev.rank && f.filed > prev.filed)) out.set(f.end, { end: f.end, val: f.val, filed: f.filed, rank: f.rank })
  }
  return [...out.values()].sort((a, b) => a.end.localeCompare(b.end))
}
// The point-in-time value at (or just before) a period end, from filings by asOf.
function instantAt(facts, tags, unit, end, asOf) {
  let best = null
  for (const f of factsFor(facts, tags, unit)) {
    if (f.start || !f.end || f.filed > asOf || f.end > end) continue
    if (!best || f.end > best.end || (f.end === best.end && (f.rank < best.rank || (f.rank === best.rank && f.filed > best.filed)))) best = f
  }
  return best ? best.val : null
}

// → { known, pass, fcf, revenue, fcfMargin, netDebt, netDebtYears, shareGrowth,
//     misses: [...], end } from the latest annual report filed by asOf.
export function qualityAt(facts, asOf, p = QUALITY) {
  const ocfS = annualSeries(facts, TAGS.ocf, 'USD', asOf)
  const revS = annualSeries(facts, TAGS.revenue, 'USD', asOf)
  if (!ocfS.length || !revS.length) return { known: false, pass: false, misses: ['no data'], why: !ocfS.length ? 'no annual operating cash flow' : 'no annual revenue under the known tags' }
  const ocf = ocfS[ocfS.length - 1]
  const end = ocf.end
  // Revenue for the same fiscal year (period ends within a week), never an older one.
  const rev = revS.find((r) => Math.abs(Date.parse(r.end) - Date.parse(end)) <= 7 * DAY)
  if (!rev) return { known: false, pass: false, misses: ['no data'], why: `no revenue for the year ending ${end} (latest revenue ${revS[revS.length - 1].end})` }
  const capex = annualSeries(facts, TAGS.capex, 'USD', asOf).find((r) => Math.abs(Date.parse(r.end) - Date.parse(end)) <= 7 * DAY)?.val ?? 0
  const fcf = ocf.val - Math.abs(capex)
  // Total long-term debt when reported, else the non-current + current parts.
  const debt = instantAt(facts, TAGS.debtTotal, 'USD', end, asOf)
    ?? ((instantAt(facts, TAGS.debtNoncurrent, 'USD', end, asOf) ?? 0) + (instantAt(facts, TAGS.debtCurrent, 'USD', end, asOf) ?? 0))
  const cash = instantAt(facts, TAGS.cash, 'USD', end, asOf) ?? 0
  const netDebt = debt - cash
  const sh = annualSeries(facts, TAGS.shares, 'shares', asOf)
  const shNow = sh.find((r) => r.end === end) ?? sh[sh.length - 1]
  const shPrev = shNow && sh.filter((r) => r.end < shNow.end).pop()
  const shareGrowth = shNow && shPrev && shPrev.val > 0 ? shNow.val / shPrev.val - 1 : null
  const fcfMargin = rev?.val > 0 ? fcf / rev.val : null
  const misses = []
  if (!(fcf > 0)) misses.push('fcf')
  if (!(fcfMargin != null && fcfMargin >= p.fcfMarginMin)) misses.push('margin')
  if (fcf > 0 && netDebt > p.netDebtYearsMax * fcf) misses.push('debt')
  if (shareGrowth != null && shareGrowth > p.shareGrowthMax) misses.push('dilution')
  return { known: true, pass: misses.length === 0, end, fcf, revenue: rev?.val ?? null, fcfMargin, netDebt, netDebtYears: fcf > 0 ? netDebt / fcf : null, shareGrowth, misses }
}

// Quality only changes when a new 10-K lands, so the nightly job computes it
// once per filing date → [{ from, ...qualityAt }] oldest first (the leader
// record judges each join on the report on file that day).
export function qualitySteps(facts, p = QUALITY) {
  const filed = new Set()
  for (const f of factsFor(facts, TAGS.ocf, 'USD')) if (isAnnualForm(f.form) && f.filed) filed.add(f.filed)
  return [...filed].sort().map((d) => ({ from: d, ...qualityAt(facts, d, p) }))
}
// The step in force on a date (null before the first annual report).
export function qualityOn(steps, date) {
  let hit = null
  for (const s of steps ?? []) { if (s.from <= date) hit = s; else break }
  return hit
}
