#!/usr/bin/env node
// After-tax LEAPS regression runner.
//
// Exercises src/utils/afterTax.js against the required cases from the
// After-Tax LEAPS spec: rate derivation, the 7-row target table, live
// after-tax value, holding period, and input validation. Exits non-zero
// on any mismatch.
//
// The federal/state config below is a FIXTURE shaped like the
// tax_year_config / state_tax_rates rows — only the parts the cases
// touch need to be realistic (top brackets, NIIT thresholds).
//
// Run via `npm run aftertax:check`.

import {
  deriveRates, applyRateOverride, makeRateResolver, targetTable,
  positionAfterTax, holdingPeriod, portfolioSummary, marginalRate,
  isValidTaxRate, isValidBasis,
} from '../src/utils/afterTax.js'

const federal = {
  tax_year: 2026,
  ordinary: {
    single: [[0, 0.10], [12400, 0.12], [50400, 0.22], [105700, 0.24], [201775, 0.32], [256225, 0.35], [640600, 0.37]],
  },
  ltcg: { single: [[0, 0], [49450, 0.15], [545500, 0.20]] },
  niit: { rate: 0.038, thresholds: { single: 200000, hoh: 200000, mfj: 250000, mfs: 125000 } },
}
const GA = { state_code: 'GA', ordinary: { single: [[0, 0.0499]] }, ltcg: null }
const TX = { state_code: 'TX', ordinary: { single: [[0, 0]] }, ltcg: null }
const WA = {
  state_code: 'WA', ordinary: { single: [[0, 0]] },
  ltcg: { single: [[0, 0], [278000, 0.07], [1278000, 0.099]] }, ltcg_applies_to: 'gain',
}

let passed = 0
const failures = []
function eq(name, actual, expected, tol = 0) {
  const ok = typeof expected === 'number'
    ? Math.abs(actual - expected) <= tol
    : actual === expected
  if (ok) passed++
  else failures.push(`${name}: expected ${expected}, got ${actual}`)
}
const round2 = (x) => Math.round(x * 100) / 100

// ── Rate derivation ───────────────────────────────────────────────
{
  const ga = deriveRates({ federal, state: GA, filingStatus: 'single', income: 800000 })
  eq('GA long-term total', ga.long_term.total, 0.2879)
  eq('GA short-term total', ga.short_term.total, 0.4579)
  eq('GA LT breakdown federal', ga.long_term.federal, 0.20)
  eq('GA LT breakdown niit', ga.long_term.niit, 0.038)
  eq('GA LT breakdown state', ga.long_term.state, 0.0499)

  const tx = deriveRates({ federal, state: TX, filingStatus: 'single', income: 800000 })
  eq('no-tax state long-term', tx.long_term.total, 0.238)
  eq('no-tax state short-term', tx.short_term.total, 0.408)

  // Gain stacking: $190k income alone is under NIIT + 15% LTCG; a $400k
  // gain pushes stacked income to $590k → 20% LTCG + NIIT.
  const before = deriveRates({ federal, state: TX, filingStatus: 'single', income: 190000, gain: 0 })
  const after = deriveRates({ federal, state: TX, filingStatus: 'single', income: 190000, gain: 400000 })
  eq('stacking: LT before', before.long_term.total, 0.15)
  eq('stacking: LT after', after.long_term.total, 0.238)

  // MFS NIIT threshold is $125k (not inflation-adjusted).
  const mfs = deriveRates({ federal, state: TX, filingStatus: 'mfs', income: 130000 })
  eq('mfs NIIT at $130k', mfs.long_term.niit, 0.038)

  // Washington: LTCG tax applies to the gain itself above its deduction.
  const waSmall = deriveRates({ federal, state: WA, filingStatus: 'single', income: 800000, gain: 100000 })
  const waBig = deriveRates({ federal, state: WA, filingStatus: 'single', income: 800000, gain: 500000 })
  eq('WA small gain state LT', waSmall.long_term.state, 0)
  eq('WA big gain state LT', waBig.long_term.state, 0.07)
  eq('WA ST state (no income tax)', waBig.short_term.state, 0)

  // Massachusetts: LT at the 5% ordinary rate, ST at 8.5%.
  const MA = { state_code: 'MA', ordinary: { single: [[0, 0.05], [1107750, 0.09]] }, ltcg: null, stcg: { single: [[0, 0.085], [1107750, 0.125]] } }
  const ma = deriveRates({ federal, state: MA, filingStatus: 'single', income: 300000 })
  eq('MA LT state', ma.long_term.state, 0.05)
  eq('MA ST state', ma.short_term.state, 0.085)

  // Partial LTCG exclusion (SC excludes 44%): 5.21% × 0.56.
  const SC = { state_code: 'SC', ordinary: { single: [[0, 0.0199], [30000, 0.0521]] }, ltcg: null, ltcg_exclusion_pct: 0.44 }
  eq('SC LT state after 44% exclusion', deriveRates({ federal, state: SC, filingStatus: 'single', income: 300000 }).long_term.state, 0.0292)

  eq('marginal at exact bound stays lower', marginalRate(federal.ordinary.single, 12400), 0.10)

  const ov = applyRateOverride(ga, { long_term: 0.25, short_term: 1.5 })
  eq('override LT applied', ov.long_term.total, 0.25)
  eq('override ST invalid ignored', ov.short_term.total, 0.4579)
}

// ── Target table (portfolio $100k, basis $30k, 23.8% / 40.8%) ────
{
  const expected = [
    [0.50, 50000, 3.19, 3.82],
    [0.45, 45000, 2.97, 3.53],
    [0.40, 40000, 2.75, 3.25],
    [0.35, 35000, 2.53, 2.97],
    [0.30, 30000, 2.31, 2.69],
    [0.25, 25000, 2.09, 2.41],
    [0.20, 20000, 1.87, 2.13],
  ]
  // Fixed rates via override …
  const fixed = makeRateResolver({ federal, state: TX, filingStatus: 'single', income: 0, override: { long_term: 0.238, short_term: 0.408 } })
  // … and the same rates derived from a top-bracket no-tax-state filer.
  const derived = makeRateResolver({ federal, state: TX, filingStatus: 'single', income: 800000 })
  for (const [label, rateForGain] of [['override', fixed], ['derived', derived]]) {
    const { basis, rows } = targetTable({ portfolio: 100000, allocationPct: 0.30, rateForGain })
    eq(`${label} basis`, basis, 30000, 1e-6)
    eq(`${label} row count`, rows.length, 7)
    rows.forEach((row, i) => {
      const [pct, dollars, ltM, stM] = expected[i]
      eq(`${label} ${pct * 100}% target pct`, row.target_pct, pct)
      eq(`${label} ${pct * 100}% after-tax $`, Math.round(row.after_tax_target), dollars)
      eq(`${label} ${pct * 100}% LT multiple`, round2(row.long_term.required_multiple), ltM)
      eq(`${label} ${pct * 100}% ST multiple`, round2(row.short_term.required_multiple), stM)
    })
  }
}

// ── Live after-tax value ─────────────────────────────────────────
{
  const rateForGain = makeRateResolver({ federal, state: TX, filingStatus: 'single', income: 800000 })
  const lt = positionAfterTax({ basis: 30000, currentValue: 60000, purchaseDate: '2025-01-15', asOf: '2026-10-02', rateForGain })
  eq('LT after-tax value', Math.round(lt.after_tax_value), 52860)
  eq('LT after-tax gain', Math.round(lt.after_tax_gain), 22860)
  eq('LT is long-term', lt.is_long_term, true)
  eq('LT no tax-saved-by-waiting', lt.tax_saved_by_waiting, null)
  eq('LT multiple', lt.current_multiple, 2)

  const st = positionAfterTax({ basis: 30000, currentValue: 60000, purchaseDate: '2026-06-01', asOf: '2026-10-02', rateForGain })
  eq('ST after-tax value', Math.round(st.after_tax_value), 47760)
  eq('ST after-tax gain', Math.round(st.after_tax_gain), 17760)
  eq('ST is short-term', st.is_long_term, false)
  eq('ST tax saved by waiting', Math.round(st.tax_saved_by_waiting), 5100)

  const loss = positionAfterTax({ basis: 30000, currentValue: 20000, purchaseDate: '2026-06-01', asOf: '2026-10-02', rateForGain })
  eq('loss after-tax value', loss.after_tax_value, 20000)
  eq('loss no tax-saved-by-waiting', loss.tax_saved_by_waiting, null)

  const prog = positionAfterTax({ basis: 30000, currentValue: 60000, purchaseDate: '2025-01-15', asOf: '2026-10-02', rateForGain, targetMultiple: 3 })
  eq('target progress 2x of 3x', prog.target_progress, 0.5)

  eq('invalid basis rejected', positionAfterTax({ basis: 0, currentValue: 1, purchaseDate: '2026-01-01', asOf: '2026-10-02', rateForGain }), null)

  // Per-position sums vs netted estimate: a $30k LT gain + $10k ST loss.
  const a = positionAfterTax({ basis: 30000, currentValue: 60000, purchaseDate: '2025-01-15', asOf: '2026-10-02', rateForGain })
  const b = positionAfterTax({ basis: 30000, currentValue: 20000, purchaseDate: '2026-06-01', asOf: '2026-10-02', rateForGain })
  const sum = portfolioSummary([a, b], 100000, rateForGain)
  eq('portfolio after-tax value (no netting)', Math.round(sum.after_tax_value), 72860)
  eq('portfolio after-tax gain', Math.round(sum.after_tax_gain), 12860)
  eq('portfolio after-tax return %', round2(sum.after_tax_return_pct * 100), 12.86)
  eq('netted estimate tax ($20k net LT × 23.8%)', Math.round(sum.netted.estimated_tax), 4760)
}

// ── Holding period ───────────────────────────────────────────────
{
  eq('anniversary day is still short-term', holdingPeriod('2025-10-02', '2026-10-02').is_long_term, false)
  eq('day after anniversary is long-term', holdingPeriod('2025-10-02', '2026-10-03').is_long_term, true)
  eq('days until long-term', holdingPeriod('2026-06-01', '2026-10-02').days_until_long_term, 243)
  eq('leap-day purchase goes LT Mar 1', holdingPeriod('2024-02-29', '2025-03-01').long_term_date, '2025-03-01')
}

// ── Validation ───────────────────────────────────────────────────
{
  eq('rate 0 valid', isValidTaxRate(0), true)
  eq('rate 0.99 valid', isValidTaxRate(0.99), true)
  eq('rate 1 invalid', isValidTaxRate(1), false)
  eq('rate negative invalid', isValidTaxRate(-0.01), false)
  eq('basis 0 invalid', isValidBasis(0), false)
}

console.log(`after-tax checks: ${passed} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
