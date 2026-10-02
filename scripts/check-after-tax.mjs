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
  isValidTaxRate, isValidBasis, exerciseCall, blended1256Rate, suggestInstrumentType, bracketTax,
  exitLadder, allocateContracts, rateAtGainFor, customExitTargets, validateCustomTargets,
  cashAfterTax, cashYieldComparison, realEstateAfterTax, interestTaxRate,
  dividendAfterTax, incomeTaxRate, incomeYieldComparison, growthProjection, runnerAfterTax, annualizedReturn,
  EXIT_PLAYBOOK, allocateWithRunner, playbookTargets, runnerPlan, timeStop, longTermFitsPlan, entryRunwayDays,
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

  // Washington: LTCG tax applies to the gain itself above its deduction,
  // as an EFFECTIVE rate on the whole gain — not 7% on all of it.
  const waSmall = deriveRates({ federal, state: WA, filingStatus: 'single', income: 800000, gain: 100000 })
  const waMid = deriveRates({ federal, state: WA, filingStatus: 'single', income: 800000, gain: 300000 })
  const waBig = deriveRates({ federal, state: WA, filingStatus: 'single', income: 800000, gain: 500000 })
  const waHuge = deriveRates({ federal, state: WA, filingStatus: 'single', income: 800000, gain: 2000000 })
  eq('WA gain under deduction → 0', waSmall.long_term.state, 0)
  eq('WA $300k gain → 7% × 22k / 300k', waMid.long_term.state, 0.0051)
  eq('WA $500k gain → 7% × 222k / 500k', waBig.long_term.state, 0.0311)
  eq('WA $2M gain → (70k + 9.9% × 722k) / 2M', waHuge.long_term.state, 0.0707)
  eq('WA ST state (no income tax)', waBig.short_term.state, 0)
  eq('WA $300k after-tax value uses effective rate', Math.round(positionAfterTax({
    basis: 100000, currentValue: 400000, purchaseDate: '2024-01-01', asOf: '2026-10-02',
    rateForGain: makeRateResolver({ federal, state: WA, filingStatus: 'single', income: 800000 }),
  }).after_tax_value), Math.round(400000 - 300000 * (0.238 + 0.0051)))

  // Progressive state, gain straddling brackets: effective, not marginal.
  const PR = { state_code: 'XX', ordinary: { single: [[0, 0.02], [100000, 0.06]] }, ltcg: null }
  const pr = deriveRates({ federal, state: PR, filingStatus: 'single', income: 50000, gain: 100000 })
  eq('progressive effective on gain slice (50k@2% + 50k@6%)/100k', pr.long_term.state, 0.04)
  eq('progressive no-gain falls back to marginal', deriveRates({ federal, state: PR, filingStatus: 'single', income: 50000 }).long_term.state, 0.02)
  eq('bracketTax', bracketTax([[0, 0.1], [10000, 0.2]], 15000), 2000)
  // Exclusion applied to the effective rate: 44% off a progressive slice.
  const SCp = { ...PR, ltcg_exclusion_pct: 0.44 }
  eq('exclusion on effective rate', deriveRates({ federal, state: SCp, filingStatus: 'single', income: 50000, gain: 100000 }).long_term.state, 0.0224)

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

// ── §1256 index options (60/40, no countdown) ────────────────────
{
  const rateForGain = makeRateResolver({ federal, state: TX, filingStatus: 'single', income: 800000 })
  const blend = 0.6 * 0.238 + 0.4 * 0.408
  eq('1256 blended rate', blended1256Rate(rateForGain(0)), 0.306)
  // Held 10 days or 3 years — same tax.
  for (const purchaseDate of ['2026-09-22', '2023-01-01']) {
    const r = positionAfterTax({ basis: 30000, currentValue: 60000, purchaseDate, asOf: '2026-10-02', rateForGain, instrumentType: 'index_option_1256' })
    eq(`1256 after-tax value (bought ${purchaseDate})`, Math.round(r.after_tax_value), Math.round(60000 - 30000 * blend))
    eq(`1256 character (bought ${purchaseDate})`, r.tax_character, 'section_1256')
    eq(`1256 no countdown (bought ${purchaseDate})`, r.days_until_long_term, null)
    eq(`1256 no tax-saved-by-waiting (bought ${purchaseDate})`, r.tax_saved_by_waiting, null)
    eq(`1256 is_long_term null (bought ${purchaseDate})`, r.is_long_term, null)
  }
  const fixed = makeRateResolver({ federal, state: TX, filingStatus: 'single', income: 0, override: { long_term: 0.238, short_term: 0.408 } })
  const row = targetTable({ portfolio: 100000, allocationPct: 0.3, targetPcts: [0.5], rateForGain: fixed }).rows[0]
  eq('1256 target multiple (50% → 50000 / 0.694 + 30000) / 30000', round2(row.section_1256.required_multiple), 3.40)
  eq('suggest SPX → 1256', suggestInstrumentType('spx'), 'index_option_1256')
  eq('suggest XSP → 1256', suggestInstrumentType('XSP'), 'index_option_1256')
  eq('suggest SPY → equity (ETF options are not 1256)', suggestInstrumentType('SPY'), 'equity_option')

  // Netted estimate splits 1256 gains 60/40.
  const a = positionAfterTax({ basis: 10000, currentValue: 20000, purchaseDate: '2026-09-01', asOf: '2026-10-02', rateForGain, instrumentType: 'index_option_1256' })
  eq('1256 netting', Math.round(portfolioSummary([a], 100000, rateForGain).netted.estimated_tax), Math.round(6000 * 0.238 + 4000 * 0.408))
}

// ── Exercise: premium rolls into stock basis, clock restarts ────
{
  const option = { id: 'opt1', ticker: 'NVDA', instrument_type: 'equity_option', option_type: 'C', strike: 150, contracts: 5, cost_basis: 30000, purchase_date: '2024-01-10' }
  const stock = exerciseCall({ option, exerciseDate: '2026-10-02' })
  eq('exercise → stock', stock.instrument_type, 'stock')
  eq('exercise shares default contracts × 100', stock.shares, 500)
  eq('exercise basis = premium + strike × shares', stock.cost_basis, 30000 + 150 * 500)
  eq('exercise purchase date = exercise date (not option date)', stock.purchase_date, '2026-10-02')
  eq('exercise links back', stock.exercised_from_id, 'opt1')
  // Option held 2+ years, but the stock starts short-term on its own clock.
  const hp = holdingPeriod(stock.purchase_date, '2026-10-03')
  eq('exercised stock starts short-term', hp.is_long_term, false)
  eq('exercised stock LT date = exercise anniversary + 1', hp.long_term_date, '2027-10-03')
  eq('exercise rejects puts', exerciseCall({ option: { ...option, option_type: 'P' }, exerciseDate: '2026-10-02' }), null)
  eq('exercise rejects 1256 (cash-settled)', exerciseCall({ option: { ...option, instrument_type: 'index_option_1256' }, exerciseDate: '2026-10-02' }), null)
  eq('exercise needs strike', exerciseCall({ option: { ...option, strike: null }, exerciseDate: '2026-10-02' }), null)
  eq('exercise share override', exerciseCall({ option, exerciseDate: '2026-10-02', shares: 510 }).shares, 510)
  // Stock bought at $105k and now worth $120k, held short-term → ST rate.
  const rateForGain = makeRateResolver({ federal, state: TX, filingStatus: 'single', income: 800000 })
  const live = positionAfterTax({ basis: stock.cost_basis, currentValue: 120000, purchaseDate: stock.purchase_date, asOf: '2026-12-01', rateForGain, instrumentType: 'stock' })
  eq('exercised stock after-tax (ST)', Math.round(live.after_tax_value), Math.round(120000 - 15000 * 0.408))
}

// ── Holding period ───────────────────────────────────────────────
{
  eq('anniversary day is still short-term', holdingPeriod('2025-10-02', '2026-10-02').is_long_term, false)
  eq('day after anniversary is long-term', holdingPeriod('2025-10-02', '2026-10-03').is_long_term, true)
  eq('days until long-term', holdingPeriod('2026-06-01', '2026-10-02').days_until_long_term, 243)
  // Days until long-term = (anniversary + 1 day) − today.
  eq('days until LT on the anniversary itself = 1', holdingPeriod('2025-10-02', '2026-10-02').days_until_long_term, 1)
  eq('days until LT once long-term = 0', holdingPeriod('2025-10-02', '2026-10-03').days_until_long_term, 0)
  // February 29 purchase: anniversary is Feb 28 in a non-leap year → LT Mar 1.
  eq('Feb 29 purchase: LT date', holdingPeriod('2024-02-29', '2024-03-01').long_term_date, '2025-03-01')
  eq('Feb 29 purchase: Feb 28 2025 still short-term', holdingPeriod('2024-02-29', '2025-02-28').is_long_term, false)
  eq('Feb 29 purchase: 1 day left on Feb 28 2025', holdingPeriod('2024-02-29', '2025-02-28').days_until_long_term, 1)
  eq('Feb 29 purchase: Mar 1 2025 is long-term', holdingPeriod('2024-02-29', '2025-03-01').is_long_term, true)
  eq('Feb 29 purchase: days from purchase day', holdingPeriod('2024-02-29', '2024-02-29').days_until_long_term, 366)
  // Feb 28 purchase whose anniversary year is a leap year → LT Feb 29.
  eq('Feb 28 2027 purchase → LT Feb 29 2028', holdingPeriod('2027-02-28', '2027-03-01').long_term_date, '2028-02-29')
  // Year-end purchase crosses the year boundary cleanly.
  eq('Dec 31 purchase → LT Jan 1 two years on', holdingPeriod('2025-12-31', '2026-06-01').long_term_date, '2027-01-01')
}

// ── Exit ladder (same required cases as the LDP engine) ──────────
{
  const fixed = (rate) => () => rate
  const [lt208] = exitLadder({ basis: 10000, currentValue: 10000, targets: [1], rateAtGain: fixed(0.208) })
  eq('ladder 20.8%: required gain', Math.round(lt208.required_gain), 12626)
  eq('ladder 20.8%: exit value', Math.round(lt208.exit_value), 22626)
  eq('ladder 20.8%: exit multiple', round2(lt208.exit_multiple), 2.26)
  const [lt288] = exitLadder({ basis: 10000, currentValue: 10000, targets: [1], rateAtGain: fixed(0.288) })
  eq('ladder 28.8%: required gain', Math.round(lt288.required_gain), 14045)
  eq('ladder 28.8%: exit value', Math.round(lt288.exit_value), 24045)
  eq('ladder 28.8%: exit multiple', round2(lt288.exit_multiple), 2.40)

  // Default ladder: 1x/2x/3x after-tax gain, equal thirds of 3 contracts.
  const rungs = exitLadder({ basis: 10000, currentValue: 24000, contracts: 3, rateAtGain: fixed(0.238) })
  eq('default ladder rung count', rungs.length, 3)
  eq('default ladder multiples', rungs.map((r) => round2(r.exit_multiple)).join(','), '2.31,3.62,4.94')
  eq('default ladder contracts', rungs.map((r) => r.contracts).join(','), '1,1,1')
  eq('rung 1 hit at 2.4x', rungs[0].hit, true)
  eq('rung 2 not hit at 2.4x', rungs[1].hit, false)
  eq('rung 2 progress', round2(rungs[1].progress), round2(14000 / 26246.72))

  // Contracts unknown → fractions only; allocation matches the engine.
  eq('no contracts → null', exitLadder({ basis: 1, currentValue: 1, rateAtGain: fixed(0.2) })[0].contracts, null)
  eq('allocate 4 → 2,1,1', allocateContracts(4, [1 / 3, 1 / 3, 1 / 3]).join(','), '2,1,1')
  eq('allocate 1 → 1,0,0', allocateContracts(1, [1 / 3, 1 / 3, 1 / 3]).join(','), '1,0,0')
  eq('allocate 10 → 4,3,3', allocateContracts(10, [1 / 3, 1 / 3, 1 / 3]).join(','), '4,3,3')

  // Rate if sold today: short-term exit is higher than long-term; §1256 in between.
  const rateForGain = makeRateResolver({ federal, state: TX, filingStatus: 'single', income: 800000 })
  const exitAt = (ch) => exitLadder({ basis: 30000, currentValue: 30000, targets: [1], rateAtGain: rateAtGainFor(ch, rateForGain) })[0].exit_value
  eq('ST exit > §1256 exit', exitAt('short_term') > exitAt('section_1256'), true)
  eq('§1256 exit > LT exit', exitAt('section_1256') > exitAt('long_term'), true)
  eq('LT exit at 23.8%', Math.round(exitAt('long_term')), Math.round(30000 + 30000 / 0.762))
  eq('invalid basis → no ladder', exitLadder({ basis: 0, currentValue: 1, rateAtGain: fixed(0.2) }).length, 0)
}

// ── Puerto Rico (IRC §933 + Act 60) ──────────────────────────────
{
  const PR = { state_code: 'PR', federal_exempt: true, ltcg_applies_to: 'income', ltcg_exclusion_pct: 0, stcg: null,
    ordinary: { single: [[0, 0], [9000, 0.07], [25000, 0.14], [41500, 0.25], [61500, 0.33]] }, ltcg: { single: [[0, 0.15]] } }
  const pr = deriveRates({ federal, state: PR, filingStatus: 'single', income: 800000, gain: 100000 })
  eq('PR: no federal', pr.long_term.federal + pr.short_term.federal, 0)
  eq('PR: no NIIT', pr.long_term.niit, 0)
  eq('PR: LT at 15%', pr.long_term.total, 0.15)
  eq('PR: ST at top PR bracket', pr.short_term.total, 0.33)
  for (const rate of [0, 0.04]) {
    const a = deriveRates({ federal, state: PR, filingStatus: 'single', income: 800000, gain: 100000, act60Rate: rate })
    eq(`PR Act 60 ${rate}: LT`, a.long_term.total, rate)
    eq(`PR Act 60 ${rate}: ST`, a.short_term.total, rate)
  }
  eq('Act 60 ignored outside PR', deriveRates({ federal, state: TX, filingStatus: 'single', income: 800000, act60Rate: 0 }).long_term.total, 0.238)
  // Live value: $30k → $60k long-term in PR, no decree → 15% on the gain.
  const live = positionAfterTax({ basis: 30000, currentValue: 60000, purchaseDate: '2025-01-15', asOf: '2026-10-02',
    rateForGain: makeRateResolver({ federal, state: PR, filingStatus: 'single', income: 800000 }) })
  eq('PR after-tax value', Math.round(live.after_tax_value), 55500)
}

// ── Target table on a direct basis (sum of positions) ────────────
{
  const flat = makeRateResolver({ federal, state: TX, filingStatus: 'single', income: 0, override: { long_term: 0.2, short_term: 0.4 } })
  const t = targetTable({ basis: 40000, targetPcts: [0.5], rateForGain: flat })
  eq('direct basis kept', t.basis, 40000)
  eq('direct basis after-tax target = basis × pct', t.rows[0].after_tax_target, 20000)
  eq('direct basis LT multiple', t.rows[0].long_term.required_multiple, 1 + 0.5 / 0.8, 1e-9)
}

// ── User-set Exit Targets (% / $) ────────────────────────────────
{
  const flat = (r) => () => r
  // $30k basis, +100% target, sell half at 20% → $30,000 proceeds,
  // $15,000 gain, $3,000 tax, $27,000 kept.
  const [a] = customExitTargets({ basis: 30000, currentValue: 30000, targets: [{ kind: 'pct', value: 1, sell: 0.5 }], rateAtGain: flat(0.2) })
  eq('pct exit value', a.exit_value, 60000)
  eq('pct proceeds', a.proceeds, 30000)
  eq('pct tax', a.estimated_tax, 3000)
  eq('pct after-tax proceeds', a.after_tax_proceeds, 27000)
  eq('pct after-tax gain %', a.after_tax_gain_pct, 0.8, 1e-9)
  eq('pct progress at basis', a.progress, 0)
  // $ target, whole position, sorted ascending regardless of input order.
  const rows = customExitTargets({ basis: 10000, currentValue: 25000, contracts: 4,
    targets: [{ kind: 'usd', value: 40000, sell: 0.5 }, { kind: 'usd', value: 20000, sell: 0.5 }], rateAtGain: flat(0.25) })
  eq('usd sorted', rows.map((r) => r.exit_value).join(','), '20000,40000')
  eq('usd contracts split', rows.map((r) => r.contracts).join(','), '2,2')
  eq('usd first hit', rows[0].hit, true)
  eq('usd second not hit', rows[1].hit, false)
  eq('usd second progress', rows[1].progress, 0.5, 1e-9)
  eq('usd after-tax proceeds', rows[1].after_tax_proceeds, 20000 - 15000 * 0.25)
  // Partial sells hold the rest: 3 contracts, sell 1/3 → 1 contract.
  const [p] = customExitTargets({ basis: 9000, currentValue: 9000, contracts: 3,
    targets: [{ kind: 'pct', value: 0.5, sell: 1 / 3 }], rateAtGain: flat(0.2) })
  eq('partial contracts', p.contracts, 1)
  eq('partial fraction', p.fraction, 1 / 3, 1e-9)
  // Rate is looked up at the realized gain, not the whole-position gain.
  let seen = null
  customExitTargets({ basis: 10000, currentValue: 0, targets: [{ kind: 'pct', value: 1, sell: 0.25 }], rateAtGain: (g) => { seen = g; return 0.2 } })
  eq('rate at realized gain', seen, 2500)
  eq('validate ok', validateCustomTargets([{ kind: 'pct', value: 1, sell: 0.5 }]), null)
  eq('validate sum > 100%', typeof validateCustomTargets([{ kind: 'pct', value: 1, sell: 0.6 }, { kind: 'pct', value: 2, sell: 0.6 }]), 'string')
  eq('validate usd below basis', typeof validateCustomTargets([{ kind: 'usd', value: 5000, sell: 1 }], 10000), 'string')
  eq('validate bad kind', typeof validateCustomTargets([{ kind: 'x', value: 1, sell: 1 }]), 'string')
}

// ── Exit playbook (mirrors ldp/tests/test_ladder.py + test_rules.py) ──
{
  const fr = EXIT_PLAYBOOK.fractions
  // Same contract split as the engine, ties to selling.
  for (const [n, a, r] of [[3, '2,1', 0], [7, '5,1', 1], [10, '7,2', 1], [20, '14,3', 3], [50, '35,8', 7]]) {
    const got = allocateWithRunner(n, fr)
    eq(`playbook split ${n}`, `${got.alloc.join(',')}|${got.runner}`, `${a}|${r}`)
  }
  // 20 contracts, $20,000 cost: +100% sells 14 → $28,000; +200% sells 3 → $9,000.
  const flat = () => 0.238
  const [t1, t2] = customExitTargets({ basis: 20000, currentValue: 20000, contracts: 20, targets: playbookTargets(), rateAtGain: flat })
  eq('T1 exit value', t1.exit_value, 40000)
  eq('T1 contracts', t1.contracts, 14)
  eq('T1 proceeds = cost back + profit', t1.proceeds, 28000)
  eq('T1 after-tax', t1.after_tax_proceeds, 28000 - 14000 * 0.238, 1e-6)
  eq('T2 exit value', t2.exit_value, 60000)
  eq('T2 contracts', t2.contracts, 3)
  // Runner: 3 contracts, peak $3,000/contract → trail stop $2,100/contract.
  const run = runnerPlan({ fractions: fr, contracts: 20, units: 20, peakUnitValue: 3000, currentValue: 20000, trailPct: 0.3 })
  eq('runner contracts', run.contracts, 3)
  eq('runner trail unit', run.trail_unit_value, 2100, 1e-9)
  eq('runner exit value', run.exit_value, 6300, 1e-9)
  const fresh = runnerPlan({ fractions: fr, contracts: 20, units: 20, currentValue: 50000, trailPct: 0.3 })
  eq('runner peak defaults to today', fresh.peak_unit_value, 2500)
  eq('no runner on 3 contracts', runnerPlan({ fractions: fr, contracts: 3, units: 3, currentValue: 1, trailPct: 0.3 }).contracts, 0)
  // Time stop: warn under 270 days, act under 180.
  eq('time stop ok', timeStop('2028-01-21', '2026-10-02').level, 'ok')
  eq('time stop warn', timeStop('2027-06-01', '2026-10-02').level, 'warn')
  eq('time stop act', timeStop('2027-03-01', '2026-10-02').level, 'act')
  eq('time stop act-by date', timeStop('2028-01-21', '2026-10-02').act_by, '2027-07-25')
  // RXRX: long-term Sep 29 2027 lands after the roll window opens (Apr 26 2027).
  eq('LT in roll window → take the gain', longTermFitsPlan('2027-09-29', '2028-01-21'), false)
  eq('LT before roll window → can wait', longTermFitsPlan('2027-03-01', '2028-06-30'), true)
  eq('stock has no time stop', longTermFitsPlan('2027-03-01', null), true)
  eq('entry runway RXRX', entryRunwayDays('2026-09-28', '2028-01-21'), 480)
}

// ── Cash ─────────────────────────────────────────────────────────
{
  // Fixture GA single at $800k: ordinary 37% + 3.8% NIIT + 4.99% GA = 45.79%.
  const gaRates = makeRateResolver({ federal, state: GA, filingStatus: 'single', income: 800000 })
  const c = cashAfterTax({ balance: 100000, apy: 0.04, kind: 'savings', rateForGain: gaRates })
  eq('cash interest', c.interest, 4000)
  eq('cash rate = ordinary stack', c.rate, 0.37 + 0.038 + 0.0499, 1e-9)
  eq('cash after-tax yield', c.after_tax_yield, 0.04 * (1 - 0.4579), 1e-9)
  eq('cash after-tax value = balance', c.after_tax_value, 100000)
  const t = cashAfterTax({ balance: 100000, apy: 0.04, kind: 't_bills', rateForGain: gaRates })
  eq('T-bills skip state tax', t.rate, 0.37 + 0.038, 1e-9)
  // Same 4% pays more after tax as T-bills in a taxing state; a 4.2% savings rate can lose to a 4% T-bill.
  const cmp = cashYieldComparison({ balance: 100000, rateForGain: gaRates,
    options: [{ kind: 'savings', apy: 0.042 }, { kind: 't_bills', apy: 0.04 }] })
  eq('best after-tax first', cmp[0].kind, 't_bills')
  eq('override uses CPA rate', interestTaxRate({ short_term: { total: 0.3, state: 0.05, overridden: true } }, 't_bills'), 0.3)
}

// ── Dividend income ──────────────────────────────────────────────
{
  // Fixture GA single at $800k: LT 20% + 3.8% + 4.99%; ordinary 37% + 3.8% + 4.99%.
  const ga = makeRateResolver({ federal, state: GA, filingStatus: 'single', income: 800000 })
  const q = dividendAfterTax({ value: 100000, yieldPct: 0.03, kind: 'qualified', rateForGain: ga })
  eq('qualified income', q.income, 3000)
  eq('qualified rate = LT stack', q.rate, 0.20 + 0.038 + 0.0499, 1e-9)
  eq('qualified after tax', q.after_tax_income, 3000 * (1 - 0.2879), 1e-6)
  eq('ordinary rate', dividendAfterTax({ value: 1, yieldPct: 0.09, kind: 'ordinary', rateForGain: ga }).rate, 0.37 + 0.038 + 0.0499, 1e-9)
  eq('REIT gets 20% off federal', dividendAfterTax({ value: 1, yieldPct: 0.04, kind: 'reit', rateForGain: ga }).rate, 0.37 * 0.8 + 0.038 + 0.0499, 1e-9)
  eq('muni: state only', dividendAfterTax({ value: 1, yieldPct: 0.035, kind: 'muni', rateForGain: ga }).rate, 0.0499, 1e-9)
  eq('treasury: no state', dividendAfterTax({ value: 1, yieldPct: 0.04, kind: 'treasury', rateForGain: ga }).rate, 0.37 + 0.038, 1e-9)
  eq('override applies to non-qualified', incomeTaxRate({ long_term: { total: 0.2 }, short_term: { total: 0.3, overridden: true } }, 'muni'), 0.3)
  // At a high bracket a 3.5% muni fund beats a 4.2% Treasury fund after tax.
  const cmp = incomeYieldComparison({ balance: 100000, rateForGain: ga,
    options: [{ kind: 'treasury', apy: 0.042 }, { kind: 'muni', apy: 0.035 }] })
  eq('muni first at high bracket', cmp[0].kind, 'muni')
  // Return of capital (e.g. some preferreds): no tax now, taxed at LT rates at sale.
  const roc = dividendAfterTax({ value: 100000, yieldPct: 0.11, kind: 'roc', rateForGain: ga })
  eq('ROC: no tax now', roc.rate, 0)
  eq('ROC: full payout now', roc.after_tax_income, 11000, 1e-6)
  eq('ROC: deferred tax at LT stack', roc.deferred_tax, 11000 * 0.2879, 1e-6)
  eq('ROC: yield after tax at sale', roc.after_tax_yield_at_sale, 0.11 * (1 - 0.2879), 1e-9)
  eq('ROC: override does not tax it now', incomeTaxRate({ long_term: { total: 0.2 }, short_term: { total: 0.3, overridden: true } }, 'roc'), 0)
  eq('non-ROC: nothing deferred', q.deferred_tax, 0)
  const rocCmp = incomeYieldComparison({ balance: 100000, rateForGain: ga, options: [{ kind: 'roc', apy: 0.11 }] })
  eq('ROC compared after tax at sale', rocCmp[0].after_tax_yield, 0.11 * (1 - 0.2879), 1e-9)
}

// ── Contributions (Simulator) ────────────────────────────────────
{
  const flat = () => ({ long_term: { total: 0.2 }, short_term: { total: 0.3, federal: 0.24, niit: 0, state: 0.06 } })
  const last = (rows) => rows[rows.length - 1]
  const c = last(growthProjection({ monthly: 100, years: 1, rateForGain: flat }))
  eq('contrib: 12 x $100', c.value, 1200, 1e-9)
  eq('contrib: no gain, no tax', c.sale_tax, 0)
  eq('contrib: invested', c.invested, 1200, 1e-9)
  const gr = last(growthProjection({ startValue: 10000, years: 1, priceGrowth: 0.1, rateForGain: flat }))
  eq('growth: 10% in a year', gr.value, 11000, 1e-6)
  eq('growth: tax at sale on the gain', gr.sale_tax, 1000 * 0.2, 1e-6)
  const roc = last(growthProjection({ startValue: 10000, years: 1, yieldPct: 0.12, kind: 'roc', reinvest: true, rateForGain: flat }))
  eq('ROC reinvested compounds monthly', roc.value, 10000 * Math.pow(1.01, 12), 1e-6)
  eq('ROC reinvested: basis unchanged', roc.basis, 10000, 1e-6)
  eq('ROC: no tax while held', roc.tax_paid, 0)
  const q = last(growthProjection({ startValue: 10000, years: 1, yieldPct: 0.03, kind: 'qualified', reinvest: false, rateForGain: flat }))
  eq('qualified paid out: $300', q.payouts, 300, 1e-6)
  eq('qualified paid out: taxed at LT', q.tax_paid, 60, 1e-6)
  eq('qualified paid out: kept', q.income_kept, 240, 1e-6)
  eq('qualified paid out: value flat', q.value, 10000, 1e-6)
  const rocCash = last(growthProjection({ startValue: 10000, years: 1, yieldPct: 0.12, kind: 'roc', reinvest: false, rateForGain: flat }))
  eq('ROC paid out lowers basis', rocCash.basis, 8800, 1e-6)
  eq('ROC paid out: gain at sale', rocCash.sale_tax, 1200 * 0.2, 1e-6)
  const floor = last(growthProjection({ startValue: 1000, startBasis: 100, years: 1, yieldPct: 0.12, kind: 'roc', reinvest: false, rateForGain: flat }))
  eq('ROC past zero basis is taxed then', floor.tax_paid, 20 * 0.2, 1e-6)
  eq('ROC basis floors at 0', floor.basis, 0)
  eq('rows: one per year', growthProjection({ monthly: 10, years: 3, rateForGain: flat }).length, 3)
}

// ── Runner after tax ─────────────────────────────────────────────
{
  const r = runnerAfterTax({ runner: { contracts: 7, share: 0.15, exit_value: 882 }, basis: 6000, units: 50, rateAtGain: () => 0.3 })
  eq('runner cost slice', r.cost, 840, 1e-9)
  eq('runner after-tax gain', r.after_tax_gain, 42 * 0.7, 1e-9)
  const loss = runnerAfterTax({ runner: { contracts: null, share: 0.15, exit_value: 5370 }, basis: 38160, units: 372, rateAtGain: () => 0.3 })
  eq('runner loss not taxed', loss.tax, 0)
  eq('runner loss', loss.after_tax_gain, 5370 - 38160 * 0.15, 1e-6)
}

// ── Annualized return ────────────────────────────────────────────
{
  const two = annualizedReturn({ gain: 21, cost: 100, purchaseDate: '2024-10-02', asOf: '2026-10-02' })
  eq('2 years: 21% total ≈ 10%/yr', two.annualized, Math.pow(1.21, 365.25 / 730) - 1, 1e-12)
  eq('2 years: days', two.days, 730)
  eq('under a year: not annualized', annualizedReturn({ gain: 10, cost: 100, purchaseDate: '2026-06-10', asOf: '2026-10-02' }).annualized, null)
  eq('total-loss guard', annualizedReturn({ gain: -100, cost: 100, purchaseDate: '2020-01-01', asOf: '2026-01-01' }).annualized, null)
  eq('loss annualizes negative', annualizedReturn({ gain: -19, cost: 100, purchaseDate: '2024-10-02', asOf: '2026-10-02' }).annualized < 0, true)
}

// ── Real estate ──────────────────────────────────────────────────
{
  const flatRE = (lt, st, fed = 0.37, niit = 0.038, stateR = 0.05) => () => ({
    long_term: { total: lt }, short_term: { total: st, federal: fed, niit, state: stateR },
  })
  // Primary home, single: $800k value, $300k cost, 6% to sell → $752k realized,
  // $452k gain − $250k exclusion = $202k taxed at 25% LT → $50,500. Mortgage $200k.
  const home = realEstateAfterTax({ value: 800000, basis: 300000, mortgage: 200000, primary: true,
    filingStatus: 'single', purchaseDate: '2015-06-01', asOf: '2026-10-02', rateForGain: flatRE(0.25, 0.45) })
  eq('home realized', home.amount_realized, 752000)
  eq('home gain', home.gain, 452000)
  eq('home excluded', home.excluded, 250000)
  eq('home tax', home.estimated_tax, 202000 * 0.25, 1e-6)
  eq('home after-tax equity', home.after_tax_equity, 752000 - 50500 - 200000, 1e-6)
  const mfj = realEstateAfterTax({ value: 800000, basis: 300000, primary: true, filingStatus: 'mfj',
    purchaseDate: '2015-06-01', asOf: '2026-10-02', rateForGain: flatRE(0.25, 0.45) })
  eq('MFJ $500k exclusion', mfj.taxable_gain, 0)
  const noEx = realEstateAfterTax({ value: 800000, basis: 300000, primary: true, exclusionEligible: false,
    purchaseDate: '2015-06-01', asOf: '2026-10-02', rateForGain: flatRE(0.25, 0.45) })
  eq('no exclusion when not eligible', noEx.taxable_gain, 452000)
  // Rental: $500k value, $300k cost, $50k depreciation, 6% costs → $470k realized,
  // $250k adjusted basis, $220k gain: $50k recapture at min(25%, 37%) + 3.8% + 5% = 33.8%,
  // $170k at 28.8% LT.
  const rental = realEstateAfterTax({ value: 500000, basis: 300000, depreciation: 50000, primary: false,
    purchaseDate: '2015-06-01', asOf: '2026-10-02', rateForGain: flatRE(0.288, 0.458) })
  eq('rental gain', rental.gain, 220000)
  eq('rental recapture', rental.recapture_gain, 50000)
  eq('rental recapture rate', rental.recapture_rate, 0.25 + 0.038 + 0.05, 1e-9)
  eq('rental tax', rental.estimated_tax, 50000 * 0.338 + 170000 * 0.288, 1e-6)
  const shortHeld = realEstateAfterTax({ value: 500000, basis: 300000, depreciation: 50000, primary: false,
    purchaseDate: '2026-03-01', asOf: '2026-10-02', rateForGain: flatRE(0.288, 0.458) })
  eq('held under a year → all short-term', shortHeld.estimated_tax, 220000 * 0.458, 1e-6)
  const loss = realEstateAfterTax({ value: 250000, basis: 300000, primary: false,
    purchaseDate: '2015-06-01', asOf: '2026-10-02', rateForGain: flatRE(0.288, 0.458) })
  eq('loss → no tax', loss.estimated_tax, 0)
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
