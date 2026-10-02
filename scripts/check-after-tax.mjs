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
  exitLadder, allocateContracts, rateAtGainFor,
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
