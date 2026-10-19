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

// Every fact for the first tag (in order) that has any, unit USD or shares.
function factsFor(facts, tags, unit) {
  const g = facts?.facts?.['us-gaap'] ?? {}
  for (const t of tags) {
    const u = g[t]?.units?.[unit]
    if (u?.length) return u
  }
  return []
}

// Annual (≈ 1-year duration) values from 10-Ks filed by asOf, keyed by period end.
function annualSeries(facts, tags, unit, asOf) {
  const out = new Map()
  for (const f of factsFor(facts, tags, unit)) {
    if (!isAnnualForm(f.form) || !f.start || !f.end || f.filed > asOf) continue
    const days = (Date.parse(f.end) - Date.parse(f.start)) / DAY
    if (days < 330 || days > 400) continue
    const prev = out.get(f.end)
    if (!prev || f.filed > prev.filed) out.set(f.end, { end: f.end, val: f.val, filed: f.filed })
  }
  return [...out.values()].sort((a, b) => a.end.localeCompare(b.end))
}
// The point-in-time value at (or just before) a period end, from filings by asOf.
function instantAt(facts, tags, unit, end, asOf) {
  let best = null
  for (const f of factsFor(facts, tags, unit)) {
    if (f.start || !f.end || f.filed > asOf || f.end > end) continue
    if (!best || f.end > best.end || (f.end === best.end && f.filed > best.filed)) best = f
  }
  return best ? best.val : null
}

// → { known, pass, fcf, revenue, fcfMargin, netDebt, netDebtYears, shareGrowth,
//     misses: [...], end } from the latest annual report filed by asOf.
export function qualityAt(facts, asOf, p = QUALITY) {
  const ocfS = annualSeries(facts, TAGS.ocf, 'USD', asOf)
  const revS = annualSeries(facts, TAGS.revenue, 'USD', asOf)
  if (!ocfS.length || !revS.length) return { known: false, pass: false, misses: ['no data'] }
  const ocf = ocfS[ocfS.length - 1]
  const end = ocf.end
  const rev = revS.find((r) => r.end === end) ?? revS[revS.length - 1]
  const capex = annualSeries(facts, TAGS.capex, 'USD', asOf).find((r) => r.end === end)?.val ?? 0
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
