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
//     federal_exempt: false,                // PR: gains excluded from federal tax + NIIT
//   }
//
// Brackets are [lower_bound, rate] pairs sorted ascending; the first
// bound is always 0. Missing filing statuses on a state fall back to
// `single` (true for flat-rate states; documented per row otherwise).
//
// Instrument types (leaps_positions.instrument_type):
//   equity_option     — options on stocks/ETFs (SPY, QQQ, NVDA …). Normal
//                       holding-period rules: > 1 year = long-term.
//   index_option_1256 — broad-based index options (SPX, XSP, NDX, RUT …).
//                       IRC §1256: 60% long-term / 40% short-term no matter
//                       how long they're held, so there is no countdown.
//   stock             — shares, including stock acquired by exercising a
//                       call. Exercise rolls the call premium into the
//                       stock's basis and the clock restarts.
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

export const INSTRUMENT_TYPES = [
  { value: 'equity_option', label: 'Stock / ETF option' },
  { value: 'index_option_1256', label: 'Index option (§1256, 60/40)' },
  { value: 'stock', label: 'Stock' },
]

// §1256 split.
export const SECTION_1256_LT_SHARE = 0.6

// Broad-based index option roots that are §1256 contracts. ETF options
// on the same indexes (SPY, QQQ, IWM, DIA) are NOT — they're equity
// options with normal holding-period rules. Used only to pre-select the
// instrument type in the form; the user's choice is what's stored.
export const SECTION_1256_ROOTS = new Set([
  'SPX', 'SPXW', 'XSP', 'NDX', 'NDXP', 'XND', 'RUT', 'RUTW', 'MRUT',
  'VIX', 'VIXW', 'DJX', 'OEX', 'XEO',
])

export function suggestInstrumentType(ticker) {
  return SECTION_1256_ROOTS.has(String(ticker ?? '').toUpperCase()) ? 'index_option_1256' : 'equity_option'
}

// 60% × long-term rate + 40% × short-term rate.
export function blended1256Rate(rates) {
  return r4(SECTION_1256_LT_SHARE * rates.long_term.total + (1 - SECTION_1256_LT_SHARE) * rates.short_term.total)
}

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

// Total tax a bracket schedule charges on `amount`.
export function bracketTax(brackets, amount) {
  if (!Array.isArray(brackets) || brackets.length === 0 || !(amount > 0)) return 0
  let tax = 0
  for (let i = 0; i < brackets.length; i++) {
    const [lo, rate] = brackets[i]
    const hi = i + 1 < brackets.length ? brackets[i + 1][0] : Infinity
    if (amount <= lo) break
    tax += (Math.min(amount, hi) - lo) * rate
  }
  return tax
}

// Effective rate a schedule charges on the gain slice. With no gain
// (the breakdown before any position is up) fall back to the marginal
// rate the first dollar of gain would pay.
//   base 'income': gain stacked on income → (T(income+gain) − T(income)) / gain
//   base 'gain':   schedule applies to the gain alone (WA) → T(gain) / gain
function effectiveOnGain(brackets, income, gain, appliesTo) {
  const floor = appliesTo === 'gain' ? 0 : income
  if (!(gain > 0)) return marginalRate(brackets, floor)
  return (bracketTax(brackets, floor + gain) - bracketTax(brackets, floor)) / gain
}

function forStatus(table, filingStatus) {
  if (!table) return null
  return table[filingStatus] ?? table.single ?? null
}

// Combined long-term + short-term rates for a user, with the federal /
// NIIT / state breakdown. `gain` is the projected LEAPS gain: it is
// stacked on top of `income` to pick brackets, so a big gain can push
// the user into a higher bracket or over the NIIT threshold.
//
// Federal + NIIT are MARGINAL (per the spec). The state component is the
// EFFECTIVE rate on the gain: partial LTCG exclusions (SC 44%, ND 40%,
// AR 50% …) and Washington's gain-only tax above its deduction can't be
// expressed as one flat number — a $300k WA gain pays 7% on only the
// $22k above $278k (≈0.5% effective), not 7% on all of it.
export function deriveRates({ federal, state, filingStatus, income, gain = 0, act60Rate = null }) {
  const g = Math.max(0, Number(gain) || 0)
  const stacked = Math.max(0, Number(income) || 0) + g

  const fedLt = marginalRate(forStatus(federal?.ltcg, filingStatus), stacked)
  const fedSt = marginalRate(forStatus(federal?.ordinary, filingStatus), stacked)

  const niitThreshold = federal?.niit?.thresholds?.[filingStatus]
  const niit = niitThreshold != null && stacked > niitThreshold ? federal.niit.rate : 0

  const inc = stacked - g
  let stateLt = 0
  let stateSt = 0
  if (state) {
    const ordinary = forStatus(state.ordinary, filingStatus)
    stateLt = state.ltcg
      ? effectiveOnGain(forStatus(state.ltcg, filingStatus), inc, g, state.ltcg_applies_to)
      : effectiveOnGain(ordinary, inc, g, 'income') * (1 - (Number(state.ltcg_exclusion_pct) || 0))
    stateSt = effectiveOnGain(state.stcg ? forStatus(state.stcg, filingStatus) : ordinary, inc, g, 'income')
  }

  // Bona fide Puerto Rico resident (IRC §933): gains on post-move
  // appreciation are PR-source and excluded from federal tax + NIIT.
  // An Act 60 decree replaces PR's own tax with the decree rate.
  if (state?.federal_exempt) {
    if (act60Rate != null && isValidTaxRate(act60Rate)) {
      stateLt = act60Rate
      stateSt = act60Rate
    }
    return {
      stacked_income: stacked,
      federal_exempt: true,
      long_term: { federal: 0, niit: 0, state: r4(stateLt), total: r4(stateLt) },
      short_term: { federal: 0, niit: 0, state: r4(stateSt), total: r4(stateSt) },
    }
  }

  return {
    stacked_income: stacked,
    long_term: {
      federal: fedLt, niit, state: r4(stateLt),
      total: r4(fedLt + niit + stateLt),
    },
    short_term: {
      federal: fedSt, niit, state: r4(stateSt),
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
export function makeRateResolver({ federal, state, filingStatus, income, override, act60Rate = null }) {
  return (gain) =>
    applyRateOverride(deriveRates({ federal, state, filingStatus, income, gain, act60Rate }), override)
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
  const ix = solveRequiredGain(afterTax, (g) => blended1256Rate(rateForGain(g)))
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
    section_1256: {
      rate: ix.rate,
      required_gain: ix.gain,
      required_proceeds: basis + ix.gain,
      required_multiple: (basis + ix.gain) / basis,
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
//   tax  = gain × rate, only if gain > 0, where rate is
//          long-term   if sold today would be held > 1 year,
//          short-term  otherwise,
//          60% LT + 40% ST for §1256 index options (any holding period).
export function positionAfterTax({
  basis, currentValue, purchaseDate, asOf, rateForGain, targetMultiple,
  instrumentType = 'equity_option',
}) {
  if (!isValidBasis(basis)) return null
  const value = Number(currentValue) || 0
  const gain = value - basis
  const is1256 = instrumentType === 'index_option_1256'
  const hp = is1256 ? null : holdingPeriod(purchaseDate, asOf)
  const rates = rateForGain(Math.max(0, gain))
  const ltRate = rates.long_term.total
  const stRate = rates.short_term.total
  const isLongTerm = is1256 ? null : (hp?.is_long_term ?? false)
  const rate = is1256 ? blended1256Rate(rates) : isLongTerm ? ltRate : stRate
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
    instrument_type: instrumentType,
    tax_character: is1256 ? 'section_1256' : isLongTerm ? 'long_term' : 'short_term',
    is_long_term: isLongTerm,
    // No countdown for §1256 — waiting never changes the 60/40 split.
    long_term_date: hp?.long_term_date ?? null,
    days_until_long_term: hp?.days_until_long_term ?? null,
    tax_rate: rate,
    long_term_rate: ltRate,
    short_term_rate: stRate,
    estimated_tax: tax,
    after_tax_value: afterTaxValue,
    after_tax_gain: afterTaxValue - basis,
    // Only meaningful while short-term (non-§1256) and in profit.
    tax_saved_by_waiting: isLongTerm === false && gain > 0 ? gain * (stRate - ltRate) : null,
    target_multiple: targetMultiple ?? null,
    target_progress: targetProgress,
  }
}

// ── Per-position after-tax exit ladder ───────────────────────────
//
// Mirrors the LDP engine's ladder (ldp/ladder.py). Each rung is an
// after-tax GAIN target as a multiple of the position's basis
// (1.0 = double after tax):
//   after_tax_gain_target = basis × target
//   rate                  = rate that applies if sold today
//   required_gain         = after_tax_gain_target ÷ (1 − rate)
//   exit_value            = basis + required_gain
//   exit_multiple         = exit_value ÷ basis
// Each rung sells its share of the position (default equal thirds),
// split into whole contracts by largest remainder so the rungs always
// add up to the full position. The engine re-solves these daily with
// its own (incremental) tax math, so figures here can differ slightly
// for gains that straddle a bracket.

export const DEFAULT_EXIT_LADDER = [1, 2, 3]

export function equalFractions(n) {
  return Array.from({ length: n }, () => 1 / n)
}

export function allocateContracts(total, fractions) {
  const raw = fractions.map((f) => total * f)
  const base = raw.map((x) => Math.floor(x + 1e-9))
  let left = total - base.reduce((a, b) => a + b, 0)
  const order = raw.map((x, i) => [x - base[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1])
  for (const [, i] of order) {
    if (left <= 0) break
    base[i] += 1
    left -= 1
  }
  return base
}

// The rate function for a position's tax character if sold today.
export function rateAtGainFor(character, rateForGain) {
  if (character === 'section_1256') return (g) => blended1256Rate(rateForGain(g))
  if (character === 'long_term') return (g) => rateForGain(g).long_term.total
  return (g) => rateForGain(g).short_term.total
}

export function exitLadder({
  basis, currentValue, contracts = null, targets = DEFAULT_EXIT_LADDER, fractions = null, rateAtGain,
}) {
  if (!isValidBasis(basis) || !targets?.length) return []
  const fr = fractions && fractions.length === targets.length ? fractions : equalFractions(targets.length)
  const alloc = Number.isInteger(contracts) && contracts > 0 ? allocateContracts(contracts, fr) : null
  const value = Number(currentValue) || 0
  return targets.map((target, i) => {
    const afterTaxGainTarget = basis * target
    const { gain, rate } = solveRequiredGain(afterTaxGainTarget, rateAtGain)
    const exitValue = basis + gain
    return {
      index: i,
      target,
      fraction: fr[i],
      contracts: alloc ? alloc[i] : null,
      after_tax_gain_target: afterTaxGainTarget,
      rate,
      required_gain: gain,
      exit_value: exitValue,
      exit_multiple: exitValue / basis,
      hit: value >= exitValue - 0.005,
      progress: Math.max(0, Math.min(1, (value - basis) / gain)),
    }
  })
}

// Exercising a long call: the premium paid rolls into the stock's cost
// basis, and the stock gets its own holding clock starting the day after
// exercise (the option's purchase date does NOT carry forward). The
// returned row is a new `stock` position; the option row is closed with
// close_reason='exercised'. Mirrored by public.exercise_leaps_position()
// in SQL, which performs the write atomically — keep the two in sync.
//   stock basis = option premium (cost_basis) + strike × shares
export function exerciseCall({ option, exerciseDate, shares }) {
  const strike = Number(option?.strike)
  const n = shares != null ? Number(shares) : Number(option?.contracts) * 100
  if (option?.instrument_type !== 'equity_option' || option?.option_type !== 'C') return null
  if (!(strike > 0) || !(n > 0) || !isValidBasis(Number(option?.cost_basis))) return null
  if (parseYmd(exerciseDate) == null) return null
  return {
    ticker: option.ticker,
    instrument_type: 'stock',
    option_type: null,
    shares: n,
    cost_basis: Number(option.cost_basis) + strike * n,
    purchase_date: exerciseDate,
    exercised_from_id: option.id ?? null,
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
    if (r.tax_character === 'section_1256') {
      lt += r.gain * SECTION_1256_LT_SHARE
      st += r.gain * (1 - SECTION_1256_LT_SHARE)
    } else if (r.is_long_term) lt += r.gain
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
