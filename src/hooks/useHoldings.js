import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import {
  DEFAULT_TARGET_PCTS, makeRateResolver, deriveRates, applyRateOverride, targetRow, positionAfterTax,
  portfolioSummary, todayYmd, rateAtGainFor, EXIT_PLAYBOOK, playbookTargets, runnerPlan, runnerAfterTax,
  DEFAULT_SELLING_COST_PCT, cashAfterTax, realEstateAfterTax, dividendAfterTax, incomeHoldingReturn, customExitTargets,
  accountRates, shelteredPosition, withdrawalRate,
} from '../utils/afterTax'

// The user's holdings with every after-tax figure worked out — shared by
// Positions (/leaps) and Home (/) so the two always show the same
// numbers. Loads leaps_tax_profiles, leaps_positions, the exit plan
// (ldp_risk_profiles) and this year's tax tables; all math is in
// utils/afterTax.js.

export const DEFAULT_PROFILE = {
  portfolio_size: 100000,
  leaps_allocation_pct: 0.3,
  filing_status: 'single',
  annual_income: 0,
  state_code: null,
  target_pcts: DEFAULT_TARGET_PCTS,
  selected_target_pct: 0.5,
  lt_rate_override: null,
  st_rate_override: null,
  pr_act60_rate: null,
}

// Holding families. Quantity holdings (shares, crypto) split whole units
// across targets like contracts; cash and real estate have their own math.
export const QUANTITY_TYPES = new Set(['stock', 'crypto'])
export const INVESTMENT_TYPES = new Set(['equity_option', 'index_option_1256', 'stock', 'crypto'])
export const isQuantity = (t) => QUANTITY_TYPES.has(t)

// Whole units (contracts or shares) to split across targets, or null.
export function wholeUnits(v) {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

export function useHoldings() {
  const { user } = useAuth()
  const [federal, setFederal] = useState(null)
  const [states, setStates] = useState([])
  const [profile, setProfile] = useState(null)
  const [positions, setPositions] = useState(null)
  const [loadError, setLoadError] = useState('')
  // The exit plan lives on the engine's risk profile (service-role
  // written, edited in Settings); default is the LEAPS playbook.
  const [plan, setPlan] = useState(EXIT_PLAYBOOK)
  useEffect(() => {
    if (!user?.id) return
    let cancelled = false
    ;(async () => {
      try {
        const [fed, prof, pos, risk] = await Promise.all([
          supabase.from('tax_year_config').select('*').eq('is_current', true).maybeSingle(),
          supabase.from('leaps_tax_profiles').select('*').eq('user_id', user.id).maybeSingle(),
          supabase.from('leaps_positions').select('*').eq('user_id', user.id)
            .is('closed_at', null).order('purchase_date', { ascending: true }),
          supabase.from('ldp_risk_profiles').select('exit_ladder, rung_fractions, runner_trail_pct').eq('user_id', user.id).maybeSingle(),
        ])
        if (cancelled) return
        if (fed.error || prof.error || pos.error) {
          console.error('[leaps] load failed', fed.error || prof.error || pos.error)
          setLoadError('Could not load your LEAPS data. Reload the page to try again.')
        }
        setFederal(fed.data ?? null)
        setProfile(prof.data ?? null)
        setPositions(pos.data ?? [])
        const targets = (risk.data?.exit_ladder ?? []).map(Number).filter((t) => t > 0)
        if (targets.length) {
          const fr = risk.data?.rung_fractions?.map(Number)
          const trail = Number(risk.data?.runner_trail_pct)
          setPlan({
            ...EXIT_PLAYBOOK,
            targets,
            fractions: fr?.length === targets.length ? fr : targets.map(() => 1 / targets.length),
            runnerTrailPct: trail > 0 && trail < 1 ? trail : EXIT_PLAYBOOK.runnerTrailPct,
          })
        }
        if (fed.data) {
          const st = await supabase.from('state_tax_rates').select('*')
            .eq('tax_year', fed.data.tax_year).order('state_name')
          if (!cancelled) setStates(st.data ?? [])
        }
      } catch (err) {
        console.error('[leaps] load threw', err)
        if (!cancelled) {
          setLoadError('Could not load your LEAPS data. Reload the page to try again.')
          setPositions([])
        }
      }
    })()
    return () => { cancelled = true }
  }, [user?.id])

  const p = profile ?? DEFAULT_PROFILE
  const state = useMemo(() => states.find((s) => s.state_code === p.state_code) ?? null, [states, p.state_code])
  const override = useMemo(
    () => ({ long_term: p.lt_rate_override, short_term: p.st_rate_override }),
    [p.lt_rate_override, p.st_rate_override],
  )
  const ready = !!federal && (!!state || (override.long_term != null && override.short_term != null))
  const act60Rate = p.pr_act60_rate == null ? null : Number(p.pr_act60_rate)

  const rateForGain = useMemo(() => {
    if (!federal) return null
    return makeRateResolver({ federal, state, filingStatus: p.filing_status, income: Number(p.annual_income) || 0, override, act60Rate })
  }, [federal, state, p.filing_status, p.annual_income, override, act60Rate])

  // Each position stands on its own; the portfolio is just their sum.
  // Investments (options, shares, crypto) drive the targets and returns;
  // cash and real estate add to net worth with their own after-tax math.
  const investments = useMemo(() => (positions ?? []).filter((x) => INVESTMENT_TYPES.has(x.instrument_type)), [positions])
  const totalCost = useMemo(
    () => investments.reduce((sum, x) => sum + (Number(x.cost_basis) || 0), 0),
    [investments],
  )
  const selectedPct = Number(p.selected_target_pct)
  const asOf = todayYmd()

  // The exit plan (playbook by default) on one position: pre-tax targets
  // with the after-tax dollars each sale keeps.
  // `rates` = the holding's account rates (retirement accounts differ).
  const ladderFor = useCallback((basis, currentValue, character, contracts, rates = rateForGain) => {
    if (!rateForGain) return []
    return customExitTargets({ basis, currentValue, contracts, targets: playbookTargets(plan),
      rateAtGain: rateAtGainFor(character, rates) })
  }, [rateForGain, plan])

  // User-set % / $ targets on a single position (leaps_positions.exit_targets).
  const customFor = useCallback((basis, currentValue, character, contracts, targets, rates = rateForGain) => {
    if (!rateForGain || !targets?.length) return []
    return customExitTargets({ basis, currentValue, contracts, targets, rateAtGain: rateAtGainFor(character, rates) })
  }, [rateForGain])

  const cashResults = useMemo(() => {
    if (!rateForGain || !positions) return []
    return positions.filter((x) => x.instrument_type === 'cash').map((pos) => {
      const acct = pos.account_type ?? 'taxable'
      const cash = cashAfterTax({ balance: Number(pos.current_value), apy: Number(pos.details?.apy) || 0,
        kind: pos.details?.account_kind ?? 'savings', rateForGain: accountRates(acct, rateForGain) })
      // Cash in a traditional account is taxed when it comes out.
      if (acct === 'traditional') {
        const r = withdrawalRate(rateForGain, cash.balance)
        return { pos, cash: { ...cash, account_type: acct, withdrawal_rate: r, after_tax_value: cash.balance * (1 - r) } }
      }
      return { pos, cash: { ...cash, account_type: acct } }
    })
  }, [positions, rateForGain])

  const realEstateResults = useMemo(() => {
    if (!rateForGain || !positions) return []
    return positions.filter((x) => x.instrument_type === 'real_estate').map((pos) => {
      const d = pos.details ?? {}
      return {
        pos,
        re: realEstateAfterTax({
          value: Number(pos.current_value), basis: Number(pos.cost_basis), mortgage: Number(d.mortgage) || 0,
          sellingCostPct: d.selling_cost_pct ?? DEFAULT_SELLING_COST_PCT, depreciation: Number(d.depreciation) || 0,
          primary: d.kind !== 'rental', exclusionEligible: d.exclusion_eligible !== false,
          filingStatus: p.filing_status, purchaseDate: pos.purchase_date, asOf, rateForGain,
        }),
      }
    })
  }, [positions, rateForGain, p.filing_status, asOf])

  const results = useMemo(() => {
    if (!rateForGain || !positions) return []
    return investments.map((pos) => {
      // Retirement accounts: their own rates, no holding period.
      const acct = pos.account_type ?? 'taxable'
      const rates = accountRates(acct, rateForGain)
      const goalPct = Number(pos.goal_pct) > 0 ? Number(pos.goal_pct) : selectedPct
      const goal = goalRow(Number(pos.cost_basis), goalPct, rates)
      const is1256 = pos.instrument_type === 'index_option_1256'
      const calc = shelteredPosition(positionAfterTax({
        basis: Number(pos.cost_basis),
        currentValue: Number(pos.current_value),
        purchaseDate: pos.purchase_date,
        asOf,
        rateForGain: rates,
        instrumentType: pos.instrument_type,
        targetMultiple: goal ? (is1256 ? goal.section_1256.required_multiple : goal.long_term.required_multiple) : null,
      }), acct, rateForGain)
      // The goal bar shows both multiples: long-term and short-term.
      if (calc && goal) {
        calc.goal_st_multiple = goal.short_term.required_multiple
        calc.goal_pct = goalPct
      }
      return withLadder(pos, calc, rates)
    })

    // The runner's after-tax gain (or loss) if its trail fired today.
    function withRunnerTax(runner, calc, units, rates) {
      if (!runner || runner.exit_value == null) return runner
      const after = runnerAfterTax({ runner, basis: calc.basis, units, rateAtGain: rateAtGainFor(calc.tax_character, rates) })
      return after ? { ...runner, after_tax_gain: after.after_tax_gain } : runner
    }

    // The after-tax return goal (Settings), solved on this position's own cost.
    function goalRow(basis, goalPct, rates) {
      if (!(goalPct > 0)) return null
      return targetRow({ portfolio: basis, basis, targetPct: goalPct, rateForGain: rates })
    }

    function withLadder(pos, calcIn, rates) {
      let calc = calcIn
      if (!calc) return { pos, calc, ladder: [], ladderLongTerm: null, custom: [], customLongTerm: null, runner: null }
      const isStock = isQuantity(pos.instrument_type)
      // Targets split whole contracts — or whole shares / coins.
      const contracts = wholeUnits(isStock ? pos.shares : pos.contracts)
      const units = isStock ? Number(pos.shares) : contracts
      const own = Array.isArray(pos.exit_targets) && pos.exit_targets.length ? pos.exit_targets : null
      const dy = Number(pos.details?.dividend_yield)
      const dividend = pos.instrument_type === 'stock' && dy > 0
        ? dividendAfterTax({ value: calc.current_value, yieldPct: dy, kind: pos.details?.dividend_kind ?? 'qualified', rateForGain: rates })
        : null
      // Payouts since purchase: in the return, and (ROC) off the basis.
      const income = dividend
        ? incomeHoldingReturn({ cost: calc.basis, value: calc.current_value, yieldPct: dy, kind: dividend.kind,
          purchaseDate: pos.purchase_date, asOf, payoutsReceived: pos.details?.payouts_received, rateForGain: rates })
        : null
      if (income && income.kind === 'roc') {
        // The sale is taxed on the lowered basis.
        calc = { ...calc, gain: income.sale_gain, estimated_tax: income.sale_tax, tax_rate: income.sale_rate,
          after_tax_value: income.after_tax_value, after_tax_gain: income.after_tax_value - calc.basis,
          tax_saved_by_waiting: income.tax_saved_by_waiting }
      }
      if (own) {
        return {
          pos,
          calc,
          ladder: [],
          ladderLongTerm: null,
          custom: customFor(calc.basis, calc.current_value, calc.tax_character, contracts, own, rates),
          customLongTerm: calc.tax_character === 'short_term'
            ? customFor(calc.basis, calc.current_value, 'long_term', contracts, own, rates)
            : null,
          // Custom runner: what the targets don't sell, on its own trail.
          runner: Number(pos.runner_trail_pct) > 0
            ? withRunnerTax(runnerPlan({ fractions: own.map((t) => Number(t.sell) || 0), contracts, units,
              peakUnitValue: pos.peak_unit_value, currentValue: calc.current_value, trailPct: Number(pos.runner_trail_pct) }), calc, units, rates)
            : null,
          dividend,
          income,
        }
      }
      return {
        pos,
        calc,
        custom: [],
        customLongTerm: null,
        ladder: ladderFor(calc.basis, calc.current_value, calc.tax_character, contracts, rates),
        // While short-term, show where each rung sits once it goes long-term.
        ladderLongTerm: calc.tax_character === 'short_term'
          ? ladderFor(calc.basis, calc.current_value, 'long_term', contracts, rates)
          : null,
        runner: withRunnerTax(runnerPlan({ fractions: plan.fractions, contracts, units, peakUnitValue: pos.peak_unit_value,
          currentValue: calc.current_value, trailPct: plan.runnerTrailPct }), calc, units, rates),
        dividend,
        income,
      }
    }
  }, [positions, investments, rateForGain, asOf, selectedPct, ladderFor, customFor, plan])

  const summary = useMemo(() => {
    if (!rateForGain || results.length === 0) return null
    const s = portfolioSummary(results.map((r) => r.calc), totalCost, rateForGain)
    // Payouts already received (after their tax) count toward the return.
    const payouts = results.reduce((sum, r) => sum + (r.income?.after_tax_payouts ?? 0), 0)
    if (!(payouts > 0)) return s
    const gain = s.after_tax_gain + payouts
    return { ...s, after_tax_gain: gain, after_tax_return_pct: totalCost > 0 ? gain / totalCost : null, payouts_after_tax: payouts }
  }, [results, totalCost, rateForGain])

  // Breakdown is shown at the user's current unrealized gain — it moves
  // as position values change (a big gain can cross a bracket or NIIT).
  const totalGain = Math.max(0, results.reduce((s, r) => s + (r.calc?.gain ?? 0), 0))
  const breakdown = useMemo(() => {
    if (!federal) return null
    const derived = deriveRates({ federal, state, filingStatus: p.filing_status, income: Number(p.annual_income) || 0, gain: totalGain, act60Rate })
    return applyRateOverride(derived, override)
  }, [federal, state, p.filing_status, p.annual_income, totalGain, override, act60Rate])

  const has1256 = (positions ?? []).some((x) => x.instrument_type === 'index_option_1256')
  const others = {
    income: cashResults.reduce((sum, r) => sum + r.cash.after_tax_interest, 0)
      + results.reduce((sum, r) => sum + (r.dividend?.after_tax_income ?? 0), 0),
    cash: cashResults.reduce((sum, r) => sum + r.cash.after_tax_value, 0),
    realEstate: realEstateResults.reduce((sum, r) => sum + (r.re?.after_tax_equity ?? 0), 0),
    // Before tax: cash balances, and property value less the mortgage.
    cashBefore: cashResults.reduce((sum, r) => sum + r.cash.balance, 0),
    realEstateBefore: realEstateResults.reduce((sum, r) => sum + (r.re?.equity ?? 0), 0),
    cashCount: cashResults.length,
    realEstateCount: realEstateResults.length,
    // Settings → Net worth: cars etc. and debts (not holdings).
    otherAssets: Number(p.other_assets) || 0,
    otherDebts: Number(p.other_debts) || 0,
  }
  // Everything outside investments, after and before tax (debts subtract).
  others.after = others.cash + others.realEstate + others.otherAssets - others.otherDebts
  others.before = others.cashBefore + others.realEstateBefore + others.otherAssets - others.otherDebts
  others.any = others.cashCount > 0 || others.realEstateCount > 0 || others.otherAssets > 0 || others.otherDebts > 0

  return {
    federal, states, profile, setProfile, positions, setPositions, loadError, plan,
    p, state, override, ready, rateForGain, investments, totalCost, selectedPct, asOf,
    ladderFor, customFor, cashResults, realEstateResults, results, summary, breakdown, has1256, others,
  }
}
