// After-tax LEAPS math — pure functions, no I/O.
//
// Tax figures (federal brackets, LTCG thresholds, NIIT, state rates)
// are NOT hardcoded here. They live in public.tax_year_config +
// public.state_tax_rates and are passed in as `federal` / `state`
// config objects. Shapes (same as the DB jsonb columns):
//
//   federal = {
//     tax_year: 2026,
//     ordinary: { single: [[0, 0.10], [12400, 0.12], ...], mfj, mfs, hoh },
//     ltcg:     { single: [[0, 0], [49450, 0.15], [545500, 0.20]], ... },
//     niit:     { rate: 0.038, thresholds: { single, mfj, mfs, hoh } },
//   }
//   state = {
//     state_code: 'GA',
//     ordinary: { single: [[0, 0.0499]], mfj?, mfs?, hoh? },
//     ltcg: null | { single: [[0, 0], [270000, 0.07], ...], ... },
//     ltcg_applies_to: 'income' | 'gain',   // WA taxes the gain itself
//     ltcg_exclusion_pct: 0,                // e.g. 0.5 = half of LTCG excluded
//     stcg: null | { single: [...] },       // MA taxes ST gains at 8.5%, not 5%
//   }
//
// Brackets are [lower_bound, rate] pairs sorted ascending; the first
// bound is always 0. Missing filing statuses on a state fall back to
// `single` (true for flat-rate states; documented per row otherwise).
//
// Every number this module produces is an ESTIMATE. It uses combined
// marginal rates on the whole gain, which is how the Cash Moves spec
// defines the after-tax figures — it is not a tax return.

export const FILING_STATUSES = [
  { value: 'single', label: 'Single' },
  { value: 'mfj', label: 'Married filing jointly' },
  { value: 'mfs', label: 'Married filing separately' },
  { value: 'hoh', label: 'Head of household' },
]

export const DEFAULT_TARGET_PCTS = [0.5, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2]

export const MAX_TAX_RATE = 0.99

// Strip float noise (0.2 + 0.038 + 0.0499 → 0.2879, not 0.28790000000000004).
const r4 = (x) => Math.round(x * 1e4) / 1e4

export function isValidTaxRate(rate) {
  return Number.isFinite(rate) && rate >= 0 && rate <= MAX_TAX_RATE
}

export function isValidBasis(basis) {
  return Number.isFinite(basis) && basis > 0
}

// Rate of the bracket the next dollar above `amount` falls into.
export function marginalRate(brackets, amount) {
  if (!Array.isArray(brackets) || brackets.length === 0) return 0
  let rate = brackets[0][1]
  for (const [bound, r] of brackets) {
    if (amount > bound) rate = r
    else break
  }
  return rate
}

function forStatus(table, filingStatus) {
  if (!table) return null
  return table[filingStatus] ?? table.single ?? null
}

// Combined marginal long-term + short-term rates for a user, with the
// federal / NIIT / state breakdown. `gain` is the projected LEAPS gain:
// it is stacked on top of `income` to pick brackets, so a big gain can
// push the user into a higher bracket or over the NIIT threshold.
export function deriveRates({ federal, state, filingStatus, income, gain = 0 }) {
  const g = Math.max(0, Number(gain) || 0)
  const stacked = Math.max(0, Number(income) || 0) + g

  const fedLt = marginalRate(forStatus(federal?.ltcg, filingStatus), stacked)
  const fedSt = marginalRate(forStatus(federal?.ordinary, filingStatus), stacked)

  const niitThreshold = federal?.niit?.thresholds?.[filingStatus]
  const niit = niitThreshold != null && stacked > niitThreshold ? federal.niit.rate : 0

  const stateOrdinary = state ? marginalRate(forStatus(state.ordinary, filingStatus), stacked) : 0
  let stateLt = stateOrdinary * (1 - (Number(state?.ltcg_exclusion_pct) || 0))
  if (state?.ltcg) {
    const base = state.ltcg_applies_to === 'gain' ? g : stacked
    stateLt = marginalRate(forStatus(state.ltcg, filingStatus), base)
  }

  const stateSt = state?.stcg
    ? marginalRate(forStatus(state.stcg, filingStatus), stacked)
    : stateOrdinary

  return {
    stacked_income: stacked,
    long_term: {
      federal: fedLt, niit, state: r4(stateLt),
      total: r4(fedLt + niit + stateLt),
    },
    short_term: {
      federal: fedSt, niit, state: stateSt,
      total: r4(fedSt + niit + stateSt),
    },
  }
}

// Replace derived totals with CPA-provided rates. Either side may be
// null (keep derived). Invalid overrides are ignored, not clamped.
export function applyRateOverride(rates, override) {
  const lt = override?.long_term
  const st = override?.short_term
  const out = {
    ...rates,
    long_term: { ...rates.long_term },
    short_term: { ...rates.short_term },
  }
  if (lt != null && isValidTaxRate(lt)) out.long_term = { ...out.long_term, total: lt, overridden: true }
  if (st != null && isValidTaxRate(st)) out.short_term = { ...out.short_term, total: st, overridden: true }
  return out
}

// rateForGain(gain) → { long_term: { total }, short_term: { total } }
// Builds it from the user's tax profile so callers don't repeat the
// federal/state/override plumbing.
export function makeRateResolver({ federal, state, filingStatus, income, override }) {
  return (gain) =>
    applyRateOverride(deriveRates({ federal, state, filingStatus, income, gain }), override)
}

// Gross gain needed to keep `afterTaxTarget` after tax. The rate depends
// on the gain (bracket stacking) and the gain depends on the rate, so
// iterate to a fixed point. If it oscillates on a bracket boundary we
// keep the larger gain — the conservative answer.
export function solveRequiredGain(afterTaxTarget, rateAtGain) {
  let gain = afterTaxTarget
  let worst = 0
  for (let i = 0; i < 20; i++) {
    const rate = rateAtGain(gain)
    if (!isValidTaxRate(rate)) return { gain: NaN, rate }
    const next = afterTaxTarget / (1 - rate)
    worst = Math.max(worst, next)
    if (Math.abs(next - gain) < 0.005) return { gain: next, rate }
    gain = next
  }
  return { gain: worst, rate: 1 - afterTaxTarget / worst }
}

// Part 1 — one target row.
//   after_tax_target  = portfolio × target_pct
//   required_gain     = after_tax_target ÷ (1 − tax_rate)
//   required_multiple = (basis + required_gain) ÷ basis
export function targetRow({ portfolio, basis, targetPct, rateForGain }) {
  if (!isValidBasis(basis)) return null
  const afterTax = portfolio * targetPct
  const lt = solveRequiredGain(afterTax, (g) => rateForGain(g).long_term.total)
  const st = solveRequiredGain(afterTax, (g) => rateForGain(g).short_term.total)
  return {
    target_pct: targetPct,
    after_tax_target: afterTax,
    long_term: {
      rate: lt.rate,
      required_gain: lt.gain,
      required_proceeds: basis + lt.gain,
      required_multiple: (basis + lt.gain) / basis,
    },
    short_term: {
      rate: st.rate,
      required_gain: st.gain,
      required_proceeds: basis + st.gain,
      required_multiple: (basis + st.gain) / basis,
    },
  }
}

export function targetTable({ portfolio, allocationPct, targetPcts = DEFAULT_TARGET_PCTS, rateForGain }) {
  const basis = portfolio * allocationPct
  if (!isValidBasis(basis)) return { basis, rows: [] }
  const rows = [...targetPcts]
    .sort((a, b) => b - a)
    .map((targetPct) => targetRow({ portfolio, basis, targetPct, rateForGain }))
  return { basis, rows }
}

// ── Holding period ────────────────────────────────────────────────

// Calendar dates as 'YYYY-MM-DD' strings, computed in UTC so a user's
// timezone never shifts a day.
function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s ?? ''))
  if (!m) return null
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

function fmtYmd(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

const DAY_MS = 86400000

export function todayYmd(now = new Date()) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// Long-term = sold AFTER the 1-year anniversary of purchase, i.e. on
// or after anniversary + 1 day. A Feb 29 purchase anniversaries on
// Feb 28 in a non-leap year, so it goes long-term on Mar 1.
export function holdingPeriod(purchaseDate, asOf) {
  const p = parseYmd(purchaseDate)
  const t = parseYmd(asOf)
  if (p == null || t == null) return null
  const pd = new Date(p)
  const y = pd.getUTCFullYear() + 1
  const mo = pd.getUTCMonth()
  const lastDay = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate()
  const anniversary = Date.UTC(y, mo, Math.min(pd.getUTCDate(), lastDay))
  const longTermStart = anniversary + DAY_MS
  const isLongTerm = t >= longTermStart
  return {
    is_long_term: isLongTerm,
    long_term_date: fmtYmd(longTermStart),
    days_until_long_term: isLongTerm ? 0 : Math.round((longTermStart - t) / DAY_MS),
  }
}

// ── Part 2 — live after-tax value ────────────────────────────────

//   gain = current_value − basis
//   tax  = gain × (LT rate if held > 1 year, else ST rate), only if gain > 0
export function positionAfterTax({ basis, currentValue, purchaseDate, asOf, rateForGain, targetMultiple }) {
  if (!isValidBasis(basis)) return null
  const value = Number(currentValue) || 0
  const gain = value - basis
  const hp = holdingPeriod(purchaseDate, asOf)
  const rates = rateForGain(Math.max(0, gain))
  const ltRate = rates.long_term.total
  const stRate = rates.short_term.total
  const isLongTerm = hp?.is_long_term ?? false
  const rate = isLongTerm ? ltRate : stRate
  const tax = gain > 0 ? gain * rate : 0
  const afterTaxValue = value - tax
  const currentMultiple = value / basis

  let targetProgress = null
  if (targetMultiple != null && targetMultiple > 1) {
    targetProgress = Math.max(0, Math.min(1, (currentMultiple - 1) / (targetMultiple - 1)))
  }

  return {
    basis,
    current_value: value,
    gain,
    current_multiple: currentMultiple,
    is_long_term: isLongTerm,
    long_term_date: hp?.long_term_date ?? null,
    days_until_long_term: hp?.days_until_long_term ?? null,
    tax_rate: rate,
    long_term_rate: ltRate,
    short_term_rate: stRate,
    estimated_tax: tax,
    after_tax_value: afterTaxValue,
    after_tax_gain: afterTaxValue - basis,
    // Only meaningful while short-term and in profit.
    tax_saved_by_waiting: !isLongTerm && gain > 0 ? gain * (stRate - ltRate) : null,
    target_multiple: targetMultiple ?? null,
    target_progress: targetProgress,
  }
}

// Totals across positions. Per-position after-tax values are summed
// as-is (no netting). `netted` is an optional ESTIMATE that offsets
// gains and losses the way Schedule D does (ST vs ST, LT vs LT, then
// across), ignoring the $3k ordinary-loss deduction and carryforwards.
export function portfolioSummary(results, portfolioSize, rateForGain) {
  const rows = results.filter(Boolean)
  const basis = rows.reduce((s, r) => s + r.basis, 0)
  const value = rows.reduce((s, r) => s + r.current_value, 0)
  const afterTaxValue = rows.reduce((s, r) => s + r.after_tax_value, 0)
  const afterTaxGain = afterTaxValue - basis

  let st = 0
  let lt = 0
  for (const r of rows) {
    if (r.is_long_term) lt += r.gain
    else st += r.gain
  }
  if (st < 0 && lt > 0) { const off = Math.min(-st, lt); lt -= off; st += off }
  if (lt < 0 && st > 0) { const off = Math.min(-lt, st); st -= off; lt += off }
  const netGain = Math.max(0, st) + Math.max(0, lt)
  const rates = rateForGain(netGain)
  const nettedTax = Math.max(0, st) * rates.short_term.total + Math.max(0, lt) * rates.long_term.total

  return {
    basis,
    current_value: value,
    after_tax_value: afterTaxValue,
    after_tax_gain: afterTaxGain,
    after_tax_return_pct: portfolioSize > 0 ? afterTaxGain / portfolioSize : null,
    netted: {
      estimated_tax: nettedTax,
      after_tax_value: value - nettedTax,
      after_tax_gain: value - nettedTax - basis,
    },
  }
}
