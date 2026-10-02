import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Landmark, Plus, Pencil, Trash2, Check, X, AlertTriangle, ArrowRightLeft, ChevronDown } from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import {
  FILING_STATUSES, DEFAULT_TARGET_PCTS, makeRateResolver, deriveRates,
  applyRateOverride, targetTable, targetRow, positionAfterTax, portfolioSummary,
  todayYmd, holdingPeriod, suggestInstrumentType, exerciseCall,
  blended1256Rate, rateAtGainFor, EXIT_PLAYBOOK, playbookTargets, runnerPlan, runnerAfterTax, timeStop,
  longTermFitsPlan, entryRunwayDays,
  CASH_KINDS, DEFAULT_SELLING_COST_PCT, cashAfterTax, cashYieldComparison, realEstateAfterTax,
  INCOME_KINDS, dividendAfterTax, incomeYieldComparison,
  customExitTargets, validateCustomTargets, MAX_CUSTOM_TARGETS,
} from '../utils/afterTax'
import NumberInput from '../components/NumberInput'
import Modal from '../components/Modal'

// LEAPS — after-tax targets + live after-tax value.
//
// Pre-tax gains overstate what a trader keeps, so the after-tax value
// is the headline number on every card. Inputs live in
// leaps_tax_profiles (one row per user); tax figures come from
// tax_year_config + state_tax_rates (never hardcoded — updated each
// year); positions from leaps_positions. All math is in
// utils/afterTax.js and covered by `npm run aftertax:check`.

const DEFAULT_PROFILE = {
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

const usd = (n) =>
  Number.isFinite(n) ? `${n < 0 ? '−' : ''}$${Math.round(Math.abs(n)).toLocaleString()}` : '—'
// Per-contract / per-share prices: cents only when they matter (< $100).
const usdUnit = (n) => (!Number.isFinite(n) ? '—'
  : n >= 100 ? usd(n)
    : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const mult = (n) => (Number.isFinite(n) ? `${n.toFixed(2)}x` : '—')
const pct = (n, dp = 1) => (Number.isFinite(n)
  ? `${(n * 100).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}%`
  : '—')
// Gain on cost with its sign: "+15.2%", "−8.0%".
const gainPct = (gain, cost) => {
  if (!(cost > 0) || !Number.isFinite(gain)) return '—'
  const r = gain / cost
  return `${r > 0.00005 ? '+' : r < -0.00005 ? '−' : ''}${pct(Math.abs(r))}`
}
// Rates like 0.2879 read best at 2dp ("28.79%"); trim trailing zeros.
const ratePct = (n) => (Number.isFinite(n) ? `${+(n * 100).toFixed(2)}%` : '—')
const yieldPct = (n) => (Number.isFinite(n) ? `${(n * 100).toFixed(2)}%` : '—')

// Holding families. Quantity holdings (shares, crypto) split whole units
// across targets like contracts; cash and real estate have their own math.
const QUANTITY_TYPES = new Set(['stock', 'crypto'])
const INVESTMENT_TYPES = new Set(['equity_option', 'index_option_1256', 'stock', 'crypto'])
const isQuantity = (t) => QUANTITY_TYPES.has(t)
const unitWord = (t) => (t === 'crypto' ? 'coin' : t === 'stock' ? 'share' : 'contract')
// Crypto counts in its own symbol, "$BTC"; other units take a plural.
const cryptoUnit = (ticker) => (ticker ? `$${ticker}` : 'coin')
const qtyText = (n, unit, digits = 8) => {
  const num = Number(n).toLocaleString('en-US', { maximumFractionDigits: digits })
  return unit.startsWith('$') ? `${num} ${unit}` : `${num} ${unit}${Number(n) === 1 ? '' : 's'}`
}

function num(v) {
  if (v === '' || v == null) return null
  const n = Number(String(v).replace(/[$,%\s]/g, ''))
  return Number.isFinite(n) ? n : null
}

export default function Leaps() {
  const { user } = useAuth()
  const [federal, setFederal] = useState(null)
  const [states, setStates] = useState([])
  const [profile, setProfile] = useState(null)
  const [positions, setPositions] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [searchParams, setSearchParams] = useSearchParams()
  const [adding, setAdding] = useState(searchParams.get('add') === '1')
  // The exit plan lives on the engine's risk profile (service-role
  // written, edited in Settings); default is the LEAPS playbook.
  const [plan, setPlan] = useState(EXIT_PLAYBOOK)
  // Which holdings are expanded (remembered on this device). Collapsed by
  // default; a newly added holding opens so its exit plan shows.
  const [openIds, setOpenIds] = useState(readOpenIds)
  const setOpen = useCallback((next) => {
    setOpenIds(next)
    try { localStorage.setItem(OPEN_KEY, JSON.stringify([...next])) } catch { /* per-visit only */ }
  }, [])
  const toggleOpen = (id) => {
    const next = new Set(openIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setOpen(next)
  }

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
  const ladderFor = useCallback((basis, currentValue, character, contracts) => {
    if (!rateForGain) return []
    return customExitTargets({ basis, currentValue, contracts, targets: playbookTargets(plan),
      rateAtGain: rateAtGainFor(character, rateForGain) })
  }, [rateForGain, plan])

  // User-set % / $ targets on a single position (leaps_positions.exit_targets).
  const customFor = useCallback((basis, currentValue, character, contracts, targets) => {
    if (!rateForGain || !targets?.length) return []
    return customExitTargets({ basis, currentValue, contracts, targets, rateAtGain: rateAtGainFor(character, rateForGain) })
  }, [rateForGain])

  const cashResults = useMemo(() => {
    if (!rateForGain || !positions) return []
    return positions.filter((x) => x.instrument_type === 'cash').map((pos) => ({
      pos,
      cash: cashAfterTax({ balance: Number(pos.current_value), apy: Number(pos.details?.apy) || 0,
        kind: pos.details?.account_kind ?? 'savings', rateForGain }),
    }))
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
      const goalPct = Number(pos.goal_pct) > 0 ? Number(pos.goal_pct) : selectedPct
      const goal = goalRow(Number(pos.cost_basis), goalPct)
      const is1256 = pos.instrument_type === 'index_option_1256'
      const calc = positionAfterTax({
        basis: Number(pos.cost_basis),
        currentValue: Number(pos.current_value),
        purchaseDate: pos.purchase_date,
        asOf,
        rateForGain,
        instrumentType: pos.instrument_type,
        targetMultiple: goal ? (is1256 ? goal.section_1256.required_multiple : goal.long_term.required_multiple) : null,
      })
      // The goal bar shows both multiples: long-term and short-term.
      if (calc && goal) {
        calc.goal_st_multiple = goal.short_term.required_multiple
        calc.goal_pct = goalPct
      }
      return withLadder(pos, calc)
    })

    // The runner's after-tax gain (or loss) if its trail fired today.
    function withRunnerTax(runner, calc, units) {
      if (!runner || runner.exit_value == null) return runner
      const after = runnerAfterTax({ runner, basis: calc.basis, units, rateAtGain: rateAtGainFor(calc.tax_character, rateForGain) })
      return after ? { ...runner, after_tax_gain: after.after_tax_gain } : runner
    }

    // The after-tax return goal (Settings), solved on this position's own cost.
    function goalRow(basis, goalPct) {
      if (!(goalPct > 0)) return null
      return targetRow({ portfolio: basis, basis, targetPct: goalPct, rateForGain })
    }

    function withLadder(pos, calc) {
      if (!calc) return { pos, calc, ladder: [], ladderLongTerm: null, custom: [], customLongTerm: null, runner: null }
      const isStock = isQuantity(pos.instrument_type)
      // Targets split whole contracts — or whole shares / coins.
      const contracts = wholeUnits(isStock ? pos.shares : pos.contracts)
      const units = isStock ? Number(pos.shares) : contracts
      const own = Array.isArray(pos.exit_targets) && pos.exit_targets.length ? pos.exit_targets : null
      const dy = Number(pos.details?.dividend_yield)
      const dividend = pos.instrument_type === 'stock' && dy > 0
        ? dividendAfterTax({ value: calc.current_value, yieldPct: dy, kind: pos.details?.dividend_kind ?? 'qualified', rateForGain })
        : null
      if (own) {
        return {
          pos,
          calc,
          ladder: [],
          ladderLongTerm: null,
          custom: customFor(calc.basis, calc.current_value, calc.tax_character, contracts, own),
          customLongTerm: calc.tax_character === 'short_term'
            ? customFor(calc.basis, calc.current_value, 'long_term', contracts, own)
            : null,
          runner: null,
          dividend,
        }
      }
      return {
        pos,
        calc,
        custom: [],
        customLongTerm: null,
        ladder: ladderFor(calc.basis, calc.current_value, calc.tax_character, contracts),
        // While short-term, show where each rung sits once it goes long-term.
        ladderLongTerm: calc.tax_character === 'short_term'
          ? ladderFor(calc.basis, calc.current_value, 'long_term', contracts)
          : null,
        runner: withRunnerTax(runnerPlan({ fractions: plan.fractions, contracts, units, peakUnitValue: pos.peak_unit_value,
          currentValue: calc.current_value, trailPct: plan.runnerTrailPct }), calc, units),
        dividend,
      }
    }
  }, [positions, investments, rateForGain, asOf, selectedPct, ladderFor, customFor, plan])

  const summary = useMemo(() => {
    if (!rateForGain || results.length === 0) return null
    return portfolioSummary(results.map((r) => r.calc), totalCost, rateForGain)
  }, [results, totalCost, rateForGain])

  // Breakdown is shown at the user's current unrealized gain — it moves
  // as position values change (a big gain can cross a bracket or NIIT).
  const totalGain = Math.max(0, results.reduce((s, r) => s + (r.calc?.gain ?? 0), 0))
  const breakdown = useMemo(() => {
    if (!federal) return null
    const derived = deriveRates({ federal, state, filingStatus: p.filing_status, income: Number(p.annual_income) || 0, gain: totalGain, act60Rate })
    return applyRateOverride(derived, override)
  }, [federal, state, p.filing_status, p.annual_income, totalGain, override, act60Rate])

  const saveProfile = useCallback(async (next) => {
    const row = { ...DEFAULT_PROFILE, ...profile, ...next, user_id: user.id }
    delete row.created_at
    delete row.updated_at
    const { data, error } = await supabase.from('leaps_tax_profiles').upsert(row).select().single()
    if (error) return error.message
    setProfile(data)
    return null
  }, [profile, user?.id])

  async function savePosition(row, id) {
    // Track the highest value per contract (or share) — the runner's
    // trail is measured from it.
    const units = isQuantity(row.instrument_type) ? Number(row.shares) : Number(row.contracts)
    if (units > 0) {
      const prev = id ? Number(positions.find((x) => x.id === id)?.peak_unit_value) || 0 : 0
      row = { ...row, peak_unit_value: Math.max(prev, Number(row.current_value) / units) }
    }
    const q = id
      ? supabase.from('leaps_positions').update(row).eq('id', id).eq('user_id', user.id)
      : supabase.from('leaps_positions').insert({ ...row, user_id: user.id })
    const { data, error } = await q.select().single()
    if (error) return error.message
    setPositions((cur) => (id ? cur.map((x) => (x.id === id ? data : x)) : [...cur, data]))
    if (!id && data?.id) setOpen(new Set([...openIds, data.id]))
    return null
  }

  // Atomic server-side: closes the call, opens the stock row with
  // basis = premium + strike × shares and a fresh holding clock.
  async function exercisePosition(pos, { exerciseDate, shares, currentValue }) {
    const { data, error } = await supabase.rpc('exercise_leaps_position', {
      p_option_id: pos.id,
      p_exercise_date: exerciseDate,
      p_current_value: currentValue,
      p_shares: shares,
    })
    if (error) return error.message
    setPositions((cur) => [...cur.filter((x) => x.id !== pos.id), data])
    return null
  }

  function dropAddParam() {
    if (searchParams.has('add')) {
      searchParams.delete('add')
      setSearchParams(searchParams, { replace: true })
    }
  }

  const has1256 = (positions ?? []).some((x) => x.instrument_type === 'index_option_1256')
  const allIds = [...results, ...cashResults, ...realEstateResults].map((r) => r.pos.id)
  const allOpen = allIds.length > 0 && allIds.every((id) => openIds.has(id))
  const others = {
    income: cashResults.reduce((sum, r) => sum + r.cash.after_tax_interest, 0)
      + results.reduce((sum, r) => sum + (r.dividend?.after_tax_income ?? 0), 0),
    cash: cashResults.reduce((sum, r) => sum + r.cash.after_tax_value, 0),
    realEstate: realEstateResults.reduce((sum, r) => sum + (r.re?.after_tax_equity ?? 0), 0),
    cashCount: cashResults.length,
    realEstateCount: realEstateResults.length,
  }

  async function deletePosition(id) {
    if (!window.confirm('Remove this position from tracking?')) return
    const { error } = await supabase.from('leaps_positions').delete().eq('id', id).eq('user_id', user.id)
    if (!error) setPositions((cur) => cur.filter((x) => x.id !== id))
  }

  return (
    <RatesContext.Provider value={{ rateForGain, defaultGoal: selectedPct > 0 ? selectedPct : null }}>
    <div className="px-4 py-4 pb-24 max-w-2xl mx-auto">
      <header className="mb-5">
        <div className="flex items-center gap-2 mb-1">
          <Landmark size={16} className="text-amber-400" />
          <h1 className="text-lg font-semibold">Positions</h1>
          <span className="flex-1" />
          {federal && (
            <span className="text-[10px] uppercase tracking-wider px-2 py-1 rounded-md border border-border text-subtle whitespace-nowrap">
              {federal.tax_year} tax
            </span>
          )}
        </div>
      </header>

      {loadError && <Banner tone="rose">{loadError}</Banner>}
      {federal === null && positions !== null && !loadError && (
        <Banner tone="amber">Tax figures for the current year haven't been loaded yet.</Banner>
      )}

      {positions === null ? (
        <div className="text-xs text-muted py-8 text-center">Loading…</div>
      ) : (
        <>
          <TaxSummaryCard profile={p} hasProfile={!!profile} states={states}
            rates={breakdown && ready ? { rates: breakdown, state, taxYear: federal.tax_year, show1256: has1256 } : null} />

          {!ready && profile && (
            <Banner tone="amber">Pick your residency in Settings (or enter both CPA rates) to see after-tax figures.</Banner>
          )}

          {ready && (summary || others.cashCount > 0 || others.realEstateCount > 0) && (
            <PortfolioTotals summary={summary} count={results.length} others={others} />
          )}


          {ready && (
            <section className="mb-6">
              <div className="flex items-center gap-2 mb-3">
                <h2 className="text-lg font-semibold flex-1">Holdings</h2>
                {allIds.length > 1 && (
                  <button type="button"
                    onClick={() => setOpen(allOpen ? new Set() : new Set(allIds))}
                    className="min-h-[44px] px-3 rounded-lg text-sm text-subtle hover:text-fg transition">
                    {allOpen ? 'Collapse all' : 'Expand all'}
                  </button>
                )}
                {!adding && (
                  <button
                    type="button"
                    onClick={() => setAdding(true)}
                    aria-label="Add a holding"
                    className="min-h-[44px] px-4 inline-flex items-center gap-1.5 rounded-lg bg-amber-400/10 border border-amber-400/40 text-amber-300 text-sm font-semibold hover:bg-amber-400/20 transition"
                  >
                    Add <Plus size={15} strokeWidth={2.5} />
                  </button>
                )}
              </div>

              {adding && (
                <PositionForm
                  preview={(f, own) => previewTargets(f, own, ladderFor, customFor)}
                  onCancel={() => { setAdding(false); dropAddParam() }}
                  allowAddAnother
                  onSave={async (row, { keepOpen } = {}) => {
                    const err = await savePosition(row)
                    if (!err && !keepOpen) { setAdding(false); dropAddParam() }
                    return err
                  }}
                />
              )}

              {allIds.length === 0 && !adding && (
                <div className="text-sm text-muted py-8 px-6 text-center border border-dashed border-border rounded-2xl">
                  No holdings yet. Tap Add + to enter options, shares, crypto, cash or real estate.
                </div>
              )}

              {results.map(({ pos, calc, ladder, ladderLongTerm, custom, customLongTerm, runner, dividend }) => (
                <PositionCard
                  key={pos.id}
                  pos={pos}
                  calc={calc}
                  ladder={ladder}
                  ladderLongTerm={ladderLongTerm}
                  custom={custom}
                  customLongTerm={customLongTerm}
                  runner={runner}
                  dividend={dividend}
                  plan={plan}
                  open={openIds.has(pos.id)}
                  onToggle={() => toggleOpen(pos.id)}
                  previewFor={(f, own) => previewTargets(f, own, ladderFor, customFor)}
                  selectedTargetPct={Number(p.selected_target_pct)}
                  onSave={(row) => savePosition(row, pos.id)}
                  onExercise={(args) => exercisePosition(pos, args)}
                  onDelete={() => deletePosition(pos.id)}
                />
              ))}

              {cashResults.map(({ pos, cash }) => (
                <CashCard key={pos.id} pos={pos} cash={cash}
                  open={openIds.has(pos.id)} onToggle={() => toggleOpen(pos.id)}
                  onSave={(row) => savePosition(row, pos.id)} onDelete={() => deletePosition(pos.id)} />
              ))}

              {realEstateResults.map(({ pos, re }) => (
                <RealEstateCard key={pos.id} pos={pos} re={re}
                  open={openIds.has(pos.id)} onToggle={() => toggleOpen(pos.id)}
                  onSave={(row) => savePosition(row, pos.id)} onDelete={() => deletePosition(pos.id)} />
              ))}


            </section>
          )}

          <div className="flex items-center gap-2 text-xs text-muted">
            <span>All tax figures are estimates, not tax advice. Consult a tax professional before acting on them.</span>
          </div>
        </>
      )}
    </div>
    </RatesContext.Provider>
  )
}

// The user's rate resolver and default after-tax goal, for the holding
// editor (yield comparisons, the goal + its targets table).
const RatesContext = createContext({ rateForGain: null, defaultGoal: null })

const OPEN_KEY = 'cm:holdings-open'
function readOpenIds() {
  try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]')) } catch { return new Set() }
}

const CARD = 'bg-card border border-border rounded-2xl p-5 mb-5'

// ── Profile ───────────────────────────────────────────────────────

// Read-only: the tax profile and goals are edited in /settings.
function TaxSummaryCard({ profile, hasProfile, states, rates }) {
  const [ratesOpen, setRatesOpen] = useState(false)
  if (!hasProfile) {
    return (
      <div className="bg-card border border-amber-500/40 rounded-xl p-4 mb-4 flex items-start gap-3">
        <AlertTriangle size={14} className="text-amber-400 shrink-0 mt-0.5" />
        <div className="flex-1 text-xs text-subtle leading-relaxed">
          Add your tax details in Settings so after-tax values and Exit Targets reflect your situation.
        </div>
        <Link to="/settings#tax"
          className="shrink-0 min-h-[44px] px-3 inline-flex items-center rounded bg-amber-400/10 border border-amber-400/40 text-amber-300 text-xs font-semibold hover:bg-amber-400/20 transition">
          Add tax details
        </Link>
      </div>
    )
  }
  const status = FILING_STATUSES.find((x) => x.value === profile.filing_status)?.label
  const stateName = states.find((x) => x.state_code === profile.state_code)?.state_name ?? profile.state_code ?? '—'
  return (
    <div className={CARD}>
      <h2 className="text-sm font-semibold mb-3">Tax profile</h2>
      <div className="grid grid-cols-2 gap-x-4 gap-y-4">
        <Stat label="Filing status" value={status} text />
        <Stat label="Income before gains" value={usd(Number(profile.annual_income))} />
        <Stat label="Residency" value={stateName} text />
        {rates && (
          <div className="min-w-0">
            <div className="text-xs text-muted truncate mb-1">Estimated tax rate</div>
            <button type="button" onClick={() => setRatesOpen(true)}
              className="block -my-[11px] py-[11px] text-sm text-amber-300 underline underline-offset-4 decoration-amber-400/50 hover:text-amber-200">
              View rates
            </button>
          </div>
        )}
      </div>
      {rates && (
        <Modal open={ratesOpen} onClose={() => setRatesOpen(false)} ariaLabel="Estimated tax rate" size="lg">
          <RateBreakdown {...rates} onClose={() => setRatesOpen(false)} />
        </Modal>
      )}
    </div>
  )
}

// ── Rate breakdown ────────────────────────────────────────────────

function RateBreakdown({ rates, state, taxYear, show1256, onClose }) {
  const rows = [
    ['Long-term (held > 1 yr)', rates.long_term],
    ['Short-term', rates.short_term],
  ]
  const blend = blended1256Rate(rates)
  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <h2 className="text-base font-semibold">Estimated tax rate</h2>
        <span className="flex-1" />
        <span className="text-xs text-muted">{taxYear}</span>
        <button type="button" onClick={onClose} aria-label="Close"
          className="-mr-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded text-subtle hover:text-fg">
          <X size={16} />
        </button>
      </div>
      <div className="space-y-4">
        {rows.map(([label, r]) => (
          <div key={label}>
            <div className="flex items-baseline gap-2 text-sm">
              <span className="text-subtle flex-1">{label}</span>
              <span className="font-mono-tab text-fg font-semibold">{ratePct(r.total)}</span>
            </div>
            <div className="mt-1 text-xs text-muted font-mono-tab">
              {r.overridden
                ? 'CPA-provided rate (override)'
                : `${ratePct(r.federal)} federal + ${ratePct(r.niit)} NIIT + ${ratePct(r.state)} ${state?.state_code ?? 'state'} = ${ratePct(r.total)}`}
            </div>
          </div>
        ))}
        {show1256 && (
          <div>
            <div className="flex items-baseline gap-2 text-sm">
              <span className="text-subtle flex-1">Index options (§1256)</span>
              <span className="font-mono-tab text-fg font-semibold">{ratePct(blend)}</span>
            </div>
            <div className="mt-1 text-xs text-muted font-mono-tab">
              60% × {ratePct(rates.long_term.total)} + 40% × {ratePct(rates.short_term.total)} = {ratePct(blend)} · any holding period
            </div>
          </div>
        )}
      </div>
      {state?.confidence === 'low' && (
        <p className="mt-4 text-xs text-amber-200/90">
          These residency figures are flagged for review — consider entering a CPA rate in Settings.
        </p>
      )}
    </div>
  )
}

// ── Positions ─────────────────────────────────────────────────────

const inputCls = 'w-full min-h-[44px] bg-bg border border-border rounded-lg px-3 py-2 text-sm text-fg font-mono-tab placeholder:text-muted focus:outline-none focus:border-amber-400/60 focus:ring-1 focus:ring-amber-400/30 transition-colors'
// iOS renders empty date inputs short and centered — pin height + alignment.
const dateCls = `${inputCls} appearance-none text-left [&::-webkit-date-and-time-value]:text-left [&::-webkit-calendar-picker-indicator]:opacity-60`

// Form rows hold what the user typed: % values and sell shares as
// percents ("100" = +100%), $ values as dollars. A $ target can be typed
// per share / coin ('each', premium per share for options) or as the
// whole position ('usd'); both save as the whole-position value.
// `priceUnits` = shares, coins, or contracts × 100.
// A per-unit price from a division: cents above $1,000, exact below.
const perUnitStr = (x) => String(+x.toFixed(x >= 1000 ? 2 : PRICE_DECIMALS))
const targetToRow = (t, priceUnits = null) => {
  const sell = String(+(Number(t.sell) * 100).toFixed(2))
  if (t.kind === 'pct') return { kind: 'pct', value: String(+(Number(t.value) * 100).toFixed(2)), sell }
  if (priceUnits > 0) return { kind: 'each', value: perUnitStr(Number(t.value) / priceUnits), sell }
  return { kind: 'usd', value: String(t.value), sell }
}
const rowToTarget = (r, priceUnits = null) => {
  const v = num(r.value) ?? NaN
  const sell = (num(r.sell) ?? NaN) / 100
  if (r.kind === 'pct') return { kind: 'pct', value: v / 100, sell }
  if (r.kind === 'each') return { kind: 'usd', value: priceUnits > 0 ? exact(v * priceUnits) : NaN, sell }
  return { kind: 'usd', value: v, sell }
}
const DEFAULT_OWN_ROWS = [
  { kind: 'pct', value: '100', sell: '50' },
  { kind: 'pct', value: '200', sell: '50' },
]

const OPTION_MULTIPLIER = 100
// Prices are kept exactly as typed (up to PRICE_DECIMALS places — option
// premiums and average costs often run past the cent). `exact` only strips
// binary float noise (0.1 × 300 = 30.000000000000004), never real digits.
const PRICE_DECIMALS = 6
const exact = (x) => +Number(x).toFixed(PRICE_DECIMALS)
// Shows every saved digit (at least cents) so the summary matches what's stored.
const usdExact = (n) => (Number.isFinite(n)
  ? `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: PRICE_DECIMALS })}`
  : '—')

function emptyForm(initial) {
  const own = Array.isArray(initial?.exit_targets) && initial.exit_targets.length > 0
  const str = (v) => (v == null ? '' : String(v))
  const d = initial?.details ?? {}
  const t = initial?.instrument_type
  return {
    // Shares paying an income (a yield, or return of capital) open as Income.
    asset: t === 'stock' ? (Number(d.dividend_yield) > 0 || d.dividend_kind === 'roc' ? 'income' : 'shares') : t === 'crypto' ? 'crypto' : t === 'cash' ? 'cash'
      : t === 'real_estate' ? 'real_estate' : 'option',
    ticker: initial?.ticker ?? '',
    name: initial?.name ?? '',
    // Income (shares with a yield)
    div_yield: d.dividend_yield != null ? String(+(Number(d.dividend_yield) * 100).toFixed(4)) : '',
    div_kind: d.dividend_kind ?? 'qualified',
    // After-tax goal for this holding ('' = account default)
    goal: initial?.goal_pct != null ? String(+(Number(initial.goal_pct) * 100).toFixed(2)) : '',
    // Cash
    balance: t === 'cash' ? str(initial?.current_value) : '',
    apy: d.apy != null ? String(+(Number(d.apy) * 100).toFixed(4)) : '',
    account_kind: d.account_kind ?? 'savings',
    // Real estate
    re_kind: d.kind ?? 'primary',
    purchase_price: d.purchase_price != null ? String(d.purchase_price) : (t === 'real_estate' ? str(initial?.cost_basis) : ''),
    improvements: d.improvements != null ? String(d.improvements) : '',
    re_value: t === 'real_estate' ? str(initial?.current_value) : '',
    mortgage: d.mortgage != null ? String(d.mortgage) : '',
    selling_cost_pct: String(+((d.selling_cost_pct ?? DEFAULT_SELLING_COST_PCT) * 100).toFixed(2)),
    depreciation: d.depreciation != null ? String(d.depreciation) : '',
    exclusion_eligible: d.exclusion_eligible ?? true,
    shares: str(initial?.shares),
    option_type: initial?.option_type ?? 'C',
    strike: str(initial?.strike),
    expiration: initial?.expiration ?? '',
    contracts: str(initial?.contracts),
    // New positions are priced the way brokers quote them (per share);
    // saved ones come back as the stored totals.
    price_mode: initial ? 'total' : 'per_share',
    cost_basis: str(initial?.cost_basis),
    current_value: str(initial?.current_value),
    cost_each: '',
    price_each: '',
    purchase_date: initial?.purchase_date ?? '',
    own_targets: own,
    targets: own ? initial.exit_targets.map((t) => targetToRow(t, priceUnitsOf(initial))) : DEFAULT_OWN_ROWS,
  }
}

// A saved row's price units: shares / coins, or contracts × 100.
function priceUnitsOf(pos) {
  if (!pos) return null
  if (isQuantity(pos.instrument_type)) return Number(pos.shares) || null
  const c = Number(pos.contracts)
  return c > 0 ? c * OPTION_MULTIPLIER : null
}

// Units the per-share prices multiply by: shares, or contracts × 100.
function unitsOf(f) {
  if (f.asset === 'shares' || f.asset === 'income' || f.asset === 'crypto') return num(f.shares)
  const c = num(f.contracts)
  return c > 0 ? c * OPTION_MULTIPLIER : null
}

function totalsOf(f) {
  if (f.price_mode === 'total') return { basis: num(f.cost_basis), value: num(f.current_value) }
  const units = unitsOf(f)
  const each = num(f.cost_each)
  const now = num(f.price_each)
  return {
    basis: units > 0 && each != null ? exact(each * units) : null,
    value: units > 0 && now != null ? exact(now * units) : null,
  }
}

function PositionForm({ initial, onSave, onCancel, preview, allowAddAnother }) {
  const { defaultGoal } = useContext(RatesContext)
  const [f, setF] = useState(() => emptyForm(initial))
  const [error, setError] = useState('')
  const [savedNote, setSavedNote] = useState('')
  const [saving, setSaving] = useState(false)
  const setV = (k) => (v) => { setError(''); setF((x) => ({ ...x, [k]: v })) }
  const setTicker = (e) => {
    const v = e.target.value.toUpperCase().replace(/[^A-Z0-9.]/g, '')
    setError('')
    setF((x) => ({ ...x, ticker: v }))
  }
  const isCrypto = f.asset === 'crypto'
  const isCash = f.asset === 'cash'
  const isRE = f.asset === 'real_estate'
  // Income = shares bought for their yield (dividend stocks, preferreds,
  // income ETFs); saved as stock with the yield in details.
  const isIncome = f.asset === 'income'
  // "Shares" below means any quantity holding (shares, income or coins).
  const isShares = f.asset === 'shares' || isIncome || isCrypto
  // Return-of-capital income holdings (STRC-style preferreds) sit near
  // par, so the LEAPS exit plan doesn't apply to them.
  const rocIncome = isIncome && f.div_kind === 'roc'
  const qtyWord = isCrypto ? 'coin' : 'share'
  // Index options (SPX, XSP, NDX, RUT, VIX …) are §1256 contracts —
  // detected from the ticker, never asked.
  const instrumentType = isCash ? 'cash' : isRE ? 'real_estate' : isCrypto ? 'crypto'
    : f.asset === 'shares' || isIncome ? 'stock' : suggestInstrumentType(f.ticker)
  const is1256 = instrumentType === 'index_option_1256'
  const runwayDays = entryRunwayDays(f.purchase_date, f.expiration)
  const shortRunway = runwayDays != null && runwayDays > 0 && runwayDays < EXIT_PLAYBOOK.minEntryDays
  const { basis, value } = totalsOf(f)

  // Switching price entry carries the numbers across so nothing is lost.
  function setPriceMode(mode) {
    setF((x) => {
      if (x.price_mode === mode) return x
      const units = unitsOf(x)
      if (mode === 'total') {
        const t = totalsOf(x)
        return { ...x, price_mode: mode, cost_basis: t.basis != null ? String(exact(t.basis)) : x.cost_basis, current_value: t.value != null ? String(exact(t.value)) : x.current_value }
      }
      const per = (v) => (units > 0 && num(v) != null ? String(exact(num(v) / units)) : '')
      return { ...x, price_mode: mode, cost_each: per(x.cost_basis) || x.cost_each, price_each: per(x.current_value) || x.price_each }
    })
  }

  async function finish(row, keepOpen, label) {
    setSaving(true)
    const err = await onSave(row, { keepOpen })
    setSaving(false)
    setError(err ?? '')
    if (!err && keepOpen) {
      setSavedNote(`${label} saved — add the next one.`)
      setF((x) => ({ ...emptyForm(null), asset: x.asset, price_mode: x.price_mode }))
    }
  }

  async function submitCash(keepOpen) {
    const balance = num(f.balance)
    const apy = num(f.apy)
    if (!f.name.trim()) return setError('Name this account (e.g. "Ally savings").')
    if (!(balance > 0)) return setError('Enter the balance.')
    if (apy != null && (apy < 0 || apy > 50)) return setError('Enter the yield as a % between 0 and 50.')
    return finish({
      ticker: null, name: f.name.trim(), instrument_type: 'cash', option_type: null, strike: null,
      expiration: null, contracts: null, shares: null,
      cost_basis: exact(balance), current_value: exact(balance), value_as_of: new Date().toISOString(),
      purchase_date: initial?.purchase_date ?? todayYmd(), exit_targets: null,
      details: { apy: apy == null ? 0 : exact(apy / 100), account_kind: f.account_kind },
    }, keepOpen, f.name.trim())
  }

  async function submitRealEstate(keepOpen) {
    const price = num(f.purchase_price)
    const improvements = num(f.improvements) ?? 0
    const value = num(f.re_value)
    const mortgage = num(f.mortgage) ?? 0
    const selling = num(f.selling_cost_pct)
    const dep = num(f.depreciation) ?? 0
    if (!f.name.trim()) return setError('Name this property (e.g. "Home").')
    if (!f.purchase_date) return setError('Enter the purchase date.')
    if (f.purchase_date > todayYmd()) return setError('Purchase date can’t be in the future.')
    if (!(price > 0)) return setError('Enter the purchase price.')
    if (value == null || value < 0) return setError('Enter what the property is worth today.')
    if (selling == null || selling < 0 || selling > 20) return setError('Selling costs should be between 0% and 20%.')
    return finish({
      ticker: null, name: f.name.trim(), instrument_type: 'real_estate', option_type: null, strike: null,
      expiration: null, contracts: null, shares: null,
      cost_basis: exact(price + improvements), current_value: exact(value), value_as_of: new Date().toISOString(),
      purchase_date: f.purchase_date, exit_targets: null,
      details: {
        kind: f.re_kind, purchase_price: price, improvements, mortgage,
        selling_cost_pct: exact(selling / 100),
        depreciation: f.re_kind === 'rental' ? dep : 0,
        exclusion_eligible: f.re_kind === 'primary' ? !!f.exclusion_eligible : false,
      },
    }, keepOpen, f.name.trim())
  }

  async function submit({ keepOpen = false } = {}) {
    if (isCash) return submitCash(keepOpen)
    if (isRE) return submitRealEstate(keepOpen)
    if (!/^[A-Z0-9.]{1,12}$/.test(f.ticker)) return setError(isCrypto ? 'Enter the coin (e.g. BTC).' : 'Enter a ticker.')
    if (isShares && !(num(f.shares) > 0)) return setError(`Enter how many ${qtyWord}s you own.`)
    if (!isShares && f.price_mode === 'per_share' && !(num(f.contracts) > 0)) return setError('Enter how many contracts you own.')
    if (!isShares && f.contracts !== '' && !Number.isInteger(num(f.contracts))) return setError('Contracts must be a whole number.')
    if (!f.purchase_date) return setError('Enter the purchase date.')
    if (f.purchase_date > todayYmd()) return setError('Purchase date can’t be in the future.')
    if (!isShares && !f.expiration) return setError('Enter the expiration date.')
    if (!isShares && f.expiration <= f.purchase_date) return setError('Expiration must be after the purchase date.')
    if (!(basis > 0)) return setError(f.price_mode === 'per_share' ? `Enter what you paid per ${isShares ? qtyWord : 'share'}.` : 'Total cost must be greater than $0.')
    if (value == null || value < 0) return setError(f.price_mode === 'per_share' ? `Enter the current price per ${isShares ? qtyWord : 'share'}.` : 'Enter the current value (0 or more).')
    let exitTargets = null
    if (f.own_targets && !rocIncome) {
      exitTargets = f.targets.map((r) => rowToTarget(r, unitsOf(f)))
      const bad = validateCustomTargets(exitTargets, basis)
      if (bad) return setError(bad)
    }
    const divYield = num(f.div_yield)
    if (isIncome && !(divYield > 0 && divYield <= 50)) {
      return setError('Enter the yield as a % between 0 and 50.')
    }
    const goal = num(f.goal)
    if (goal != null && !(goal > 0 && goal <= 1000)) return setError('Enter the after-tax goal as a % above 0 (or leave it blank).')
    return finish({
      ticker: f.ticker,
      name: null,
      details: isIncome
        ? { dividend_yield: exact(divYield / 100), dividend_kind: f.div_kind }
        : null,
      // Left at the default (and never set) → NULL, so it keeps following Settings.
      goal_pct: rocIncome || !(goal > 0) || (initial?.goal_pct == null && defaultGoal != null && Math.abs(goal / 100 - defaultGoal) < 1e-9)
        ? null : exact(goal / 100),
      instrument_type: instrumentType,
      option_type: isShares ? null : f.option_type,
      strike: isShares ? null : num(f.strike),
      expiration: isShares ? null : f.expiration,
      contracts: isShares ? null : num(f.contracts),
      shares: isShares ? num(f.shares) : null,
      cost_basis: exact(basis),
      current_value: exact(value),
      value_as_of: new Date().toISOString(),
      purchase_date: f.purchase_date,
      exit_targets: exitTargets,
    }, keepOpen, f.ticker)
  }

  const setRow = (i, k, v) => {
    setError('')
    setF((x) => ({
      ...x,
      targets: x.targets.map((r, j) => {
        if (j !== i) return r
        // Switching $ each ⇄ $ total carries the number across.
        const u = unitsOf(x)
        const val = num(r.value)
        if (k === 'kind' && u > 0 && val != null) {
          if (r.kind === 'each' && v === 'usd') return { ...r, kind: v, value: String(exact(val * u)) }
          if (r.kind === 'usd' && v === 'each') return { ...r, kind: v, value: perUnitStr(val / u) }
        }
        return { ...r, [k]: v }
      }),
    }))
  }
  const addRow = () => setF((x) => {
    const used = x.targets.reduce((sum, r) => sum + (num(r.sell) ?? 0), 0)
    const last = x.targets[x.targets.length - 1]
    const next = last?.kind === 'usd' || last?.kind === 'each'
      ? { kind: last.kind, value: '', sell: '' }
      : { kind: 'pct', value: last ? String((num(last.value) ?? 0) + 100) : '100', sell: '' }
    next.sell = String(Math.max(0, +(100 - used).toFixed(2)) || '')
    return { ...x, targets: [...x.targets, next] }
  })
  const removeRow = (i) => setF((x) => ({ ...x, targets: x.targets.filter((_, j) => j !== i) }))
  const previewRows = preview
    ? preview({ ...f, instrument_type: instrumentType, cost_basis: basis, current_value: value ?? basis },
      f.own_targets ? f.targets.map((r) => rowToTarget(r, unitsOf(f))) : null)
    : null
  const perShare = f.price_mode === 'per_share'
  const gainPct = basis > 0 && value != null ? value / basis - 1 : null

  return (
    <div className="bg-card border border-amber-400/40 rounded-2xl p-5 mb-4">
      <div className="flex items-center mb-4">
        <h3 className="text-base font-semibold flex-1">{initial ? `Edit ${initial.ticker ?? initial.name}` : 'Add a holding'}</h3>
        <button type="button" onClick={onCancel} aria-label="Close"
          className="-mr-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded text-subtle hover:text-fg">
          <X size={16} />
        </button>
      </div>

      <Segmented
        label="What do you own?"
        value={f.asset}
        onChange={(v) => { setError(''); setF((x) => ({ ...x, asset: v })) }}
        columns={3}
        options={[
          { value: 'option', label: 'Options' }, { value: 'shares', label: 'Shares' }, { value: 'income', label: 'Income' },
          { value: 'crypto', label: 'Crypto' }, { value: 'cash', label: 'Cash' }, { value: 'real_estate', label: 'Real Estate' },
        ]}
      />

      {isCash && (
        <FormSection title="Cash account">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name" wide>
              <input value={f.name} onChange={(e) => setV('name')(e.target.value)} maxLength={60} placeholder="Ally savings" className={inputCls} />
            </Field>
            <Field label="Account type" wide>
              <select value={f.account_kind} onChange={(e) => setV('account_kind')(e.target.value)} className={inputCls}>
                {CASH_KINDS.map((k) => <option key={k.value} value={k.value}>{k.long}</option>)}
              </select>
            </Field>
            <Field label="Balance">
              <Affix prefix="$"><NumberInput value={f.balance} onChange={setV('balance')} placeholder="25,000" className={clsx(inputCls, 'pl-7')} /></Affix>
            </Field>
            <Field label="Yield (APY)" hint="optional">
              <Affix suffix="%"><NumberInput decimals={4} value={f.apy} onChange={setV('apy')} placeholder="4.00" className={clsx(inputCls, 'pr-8')} /></Affix>
            </Field>
          </div>
        </FormSection>
      )}

      {isCash && <YieldCompare group="cash" amount={num(f.balance)} />}

      {isRE && (
        <FormSection title="Property">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name" wide>
              <input value={f.name} onChange={(e) => setV('name')(e.target.value)} maxLength={60} placeholder="Home" className={inputCls} />
            </Field>
            <Field label="Type" wide>
              <Segmented compact value={f.re_kind} onChange={setV('re_kind')}
                options={[{ value: 'primary', label: 'Primary home' }, { value: 'rental', label: 'Rental' }]} />
            </Field>
            <Field label="Purchase date">
              <input type="date" value={f.purchase_date} max={todayYmd()} onChange={(e) => setV('purchase_date')(e.target.value)} className={dateCls} />
            </Field>
            <Field label="Purchase price">
              <Affix prefix="$"><NumberInput value={f.purchase_price} onChange={setV('purchase_price')} placeholder="400,000" className={clsx(inputCls, 'pl-7')} /></Affix>
            </Field>
            <Field label="Improvements" hint="optional">
              <Affix prefix="$"><NumberInput value={f.improvements} onChange={setV('improvements')} placeholder="0" className={clsx(inputCls, 'pl-7')} /></Affix>
            </Field>
            <Field label="Current Value">
              <Affix prefix="$"><NumberInput value={f.re_value} onChange={setV('re_value')} placeholder="550,000" className={clsx(inputCls, 'pl-7')} /></Affix>
            </Field>
            <Field label="Mortgage owed" hint="optional">
              <Affix prefix="$"><NumberInput value={f.mortgage} onChange={setV('mortgage')} placeholder="0" className={clsx(inputCls, 'pl-7')} /></Affix>
            </Field>
            <Field label="Selling costs">
              <Affix suffix="%"><NumberInput value={f.selling_cost_pct} onChange={setV('selling_cost_pct')} placeholder="6" className={clsx(inputCls, 'pr-8')} /></Affix>
            </Field>
            {f.re_kind === 'rental' && (
              <Field label="Depreciation taken" hint="optional" wide>
                <Affix prefix="$"><NumberInput value={f.depreciation} onChange={setV('depreciation')} placeholder="0" className={clsx(inputCls, 'pl-7')} /></Affix>
              </Field>
            )}
          </div>
          {f.re_kind === 'primary' && (
            <label className="mt-4 flex items-start gap-3 min-h-[44px] cursor-pointer">
              <span className="relative mt-0.5 h-5 w-5 shrink-0">
                <input type="checkbox" checked={!!f.exclusion_eligible}
                  onChange={(e) => setV('exclusion_eligible')(e.target.checked)}
                  className="peer appearance-none h-5 w-5 rounded-md border border-border bg-bg checked:bg-amber-400 checked:border-amber-400 transition cursor-pointer" />
                <Check size={14} strokeWidth={3} className="pointer-events-none absolute inset-0 m-auto text-bg opacity-0 peer-checked:opacity-100" />
              </span>
              <span className="text-sm text-fg">I've lived here 2 of the last 5 years</span>
            </label>
          )}
        </FormSection>
      )}

      {!isCash && !isRE && (<>

      <FormSection title={isCrypto ? 'Crypto' : isIncome ? 'Income' : isShares ? 'Shares' : 'Contract'}>
        <div className="grid grid-cols-2 gap-3">
          <Field label={isCrypto ? 'Coin' : 'Ticker'}>
            <input value={f.ticker} onChange={setTicker} maxLength={12} placeholder={isCrypto ? 'BTC' : isIncome ? 'SCHD' : isShares ? 'AAPL' : 'XLK'}
              autoCapitalize="characters" autoComplete="off" spellCheck={false} className={inputCls} />
          </Field>
          {isShares ? (
            <Field label={isCrypto ? 'Quantity' : 'Shares'}>
              <NumberInput decimals={isCrypto ? 8 : 4} value={f.shares} onChange={setV('shares')} placeholder={isCrypto ? '0.5' : '100'} className={inputCls} />
            </Field>
          ) : (
            <Field label="Type">
              <Segmented compact value={f.option_type} onChange={setV('option_type')}
                options={[{ value: 'C', label: 'Call' }, { value: 'P', label: 'Put' }]} />
            </Field>
          )}
          {!isShares && (
            <>
              <Field label="Contracts">
                <NumberInput decimals={0} value={f.contracts} onChange={setV('contracts')} placeholder="1" className={inputCls} />
              </Field>
              <Field label="Strike" hint="optional">
                <Affix prefix="$">
                  <NumberInput decimals={PRICE_DECIMALS} value={f.strike} onChange={setV('strike')} placeholder="250" className={clsx(inputCls, 'pl-7')} />
                </Affix>
              </Field>
              <Field label="Expiration">
                <input type="date" value={f.expiration} min={f.purchase_date || undefined} onChange={(e) => setV('expiration')(e.target.value)} className={dateCls} />
              </Field>
            </>
          )}
          <Field label="Purchase date" wide={isShares}>
            <input type="date" value={f.purchase_date} max={todayYmd()} onChange={(e) => setV('purchase_date')(e.target.value)} className={dateCls} />
          </Field>
        </div>
        {isIncome && (
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label="Income type" wide>
              <select value={f.div_kind} onChange={(e) => setV('div_kind')(e.target.value)} className={inputCls}>
                {INCOME_KINDS.map((k) => <option key={k.value} value={k.value}>{k.long}</option>)}
              </select>
            </Field>
            <Field label="Yield" wide>
              <Affix suffix="%"><NumberInput decimals={4} value={f.div_yield} onChange={setV('div_yield')} placeholder={f.div_kind === 'roc' ? '11' : '3.5'} className={clsx(inputCls, 'pr-8')} /></Affix>
            </Field>
          </div>
        )}
        {!isShares && shortRunway && (
          <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5 text-xs text-amber-200">
            Only {Math.round(runwayDays / 30.4)} months to expiry at purchase. Buy with 18–24+ months so the
            1-year tax date and your 6-month time stop don't land on top of each other.
          </div>
        )}
        {!isShares && (
          is1256 && (
            <div className="mt-4 flex items-center gap-2 rounded-lg border border-sky-500/30 bg-sky-500/5 px-3 py-2.5">
              <span className="flex-1 text-sm text-sky-200">Index option · §1256 60/40 tax</span>
            </div>
          )
        )}
      </FormSection>

      <FormSection title="Cost & value" aside={
        <Segmented compact value={f.price_mode} onChange={setPriceMode}
          options={[{ value: 'per_share', label: isCrypto ? 'Per coin' : 'Per share' }, { value: 'total', label: 'Total' }]} />
      }>
        <div className="grid grid-cols-2 gap-3">
          {perShare ? (
            <>
              <Field label={isShares ? `Paid per ${qtyWord}` : 'Premium paid'}>
                <Affix prefix="$"><NumberInput decimals={PRICE_DECIMALS} value={f.cost_each} onChange={setV('cost_each')} placeholder={isCrypto ? '60,000.00' : isShares ? '180.00' : '12.50'} className={clsx(inputCls, 'pl-7')} /></Affix>
              </Field>
              <Field label={isShares ? 'Price now' : 'Premium now'}>
                <Affix prefix="$"><NumberInput decimals={PRICE_DECIMALS} value={f.price_each} onChange={setV('price_each')} placeholder={isCrypto ? '65,000.00' : isShares ? '210.00' : '18.00'} className={clsx(inputCls, 'pl-7')} /></Affix>
              </Field>
            </>
          ) : (
            <>
              <Field label="Total cost">
                <Affix prefix="$"><NumberInput decimals={PRICE_DECIMALS} value={f.cost_basis} onChange={setV('cost_basis')} placeholder="10,000" className={clsx(inputCls, 'pl-7')} /></Affix>
              </Field>
              <Field label="Current Value">
                <Affix prefix="$"><NumberInput decimals={PRICE_DECIMALS} value={f.current_value} onChange={setV('current_value')} placeholder="12,500" className={clsx(inputCls, 'pl-7')} /></Affix>
              </Field>
            </>
          )}
        </div>
        {(basis > 0 || value != null) && (
          <div className="mt-4 grid grid-cols-3 gap-3 rounded-xl bg-bg/40 border border-hairline px-4 py-3">
            <Stat label="Total cost" value={usdExact(basis)} />
            <Stat label="Current Value" value={usdExact(value)} />
            <div className="min-w-0 text-right">
              <div className="text-xs text-muted mb-1">Gain</div>
              <div className={clsx('font-mono-tab text-sm truncate', gainPct == null ? 'text-fg' : gainPct >= 0 ? 'text-green-400' : 'text-rose-300')}>
                {gainPct == null ? '—' : `${gainPct >= 0 ? '+' : ''}${pct(gainPct)}`}
              </div>
            </div>
          </div>
        )}
      </FormSection>

      {!rocIncome && <GoalSection goal={f.goal} onGoal={setV('goal')} basis={basis} is1256={is1256} />}

      {isIncome && <YieldCompare group="income" amount={value} />}

      {!rocIncome && (
      <FormSection title="Exit Targets">
        <TargetsEditor
          own={f.own_targets}
          rows={f.targets}
          contracts={isShares ? null : (Number.parseInt(f.contracts, 10) || null)}
          eachLabel={isCrypto ? `per ${cryptoUnit(f.ticker)}` : 'per share'}
          onOwn={(v) => setF((x) => ({ ...x, own_targets: v }))}
          onRow={setRow}
          onAdd={addRow}
          onRemove={removeRow}
        />
        {previewRows && previewRows.length > 0 && <CustomTargetsPreview rows={previewRows} isStock={isShares ? (isCrypto ? cryptoUnit(f.ticker) : qtyWord) : false} units={isShares ? num(f.shares) : num(f.contracts)} />}
      </FormSection>
      )}
      </>)}

      {error && (
        <div role="alert" className="mt-4 rounded-lg border border-rose-500/40 bg-rose-500/5 px-3 py-2 text-xs text-rose-200">{error}</div>
      )}
      {!error && savedNote && (
        <div role="status" className="mt-4 rounded-lg border border-green-500/30 bg-green-500/5 px-3 py-2 text-xs text-green-300">{savedNote}</div>
      )}

      <div className="mt-4 space-y-2">
        <button type="button" disabled={saving} onClick={() => submit()}
          className="tap-spring w-full min-h-[48px] rounded-lg bg-amber-400 hover:bg-amber-300 text-bg text-sm font-semibold transition disabled:opacity-50">
          {saving ? 'Saving…' : initial ? 'Save changes' : 'Save holding'}
        </button>
        <div className={clsx('grid gap-2', allowAddAnother ? 'grid-cols-[2fr_3fr]' : 'grid-cols-1')}>
          <button type="button" onClick={onCancel}
            className="min-h-[44px] rounded-lg border border-border text-sm text-subtle hover:text-fg transition">
            {savedNote ? 'Done' : 'Cancel'}
          </button>
          {allowAddAnother && (
            <button type="button" disabled={saving} onClick={() => submit({ keepOpen: true })}
              className="min-h-[44px] px-3 rounded-lg border border-amber-400/40 text-amber-300 text-sm font-semibold whitespace-nowrap hover:bg-amber-400/10 transition disabled:opacity-50">
              Save &amp; add another
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function FormSection({ title, info, aside, children }) {
  return (
    <section className="mt-6 pt-5 border-t border-hairline">
      <div className="flex items-center gap-3 mb-4 min-h-[28px]">
        <h4 className="text-xs uppercase tracking-wider text-subtle font-semibold whitespace-nowrap">{title}</h4>
        {info}
        <span className="flex-1" />
        {aside}
      </div>
      {children}
    </section>
  )
}

function Segmented({ label, value, onChange, options, compact, columns }) {
  return (
    <div>
      {label && <div className="text-[11px] text-subtle mb-1.5">{label}</div>}
      <div role="radiogroup" aria-label={label}
        className={clsx('grid rounded-lg border border-border bg-bg p-0.5', compact ? 'gap-0.5' : 'gap-1')}
        style={{ gridTemplateColumns: `repeat(${columns ?? options.length}, minmax(0, 1fr))` }}>
        {options.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={value === o.value}
            onClick={() => onChange(o.value)}
            className={clsx('rounded-md font-semibold transition whitespace-nowrap',
              compact ? 'min-h-[40px] px-2.5 text-xs' : 'min-h-[44px] px-3 text-sm',
              value === o.value ? 'bg-amber-400/15 text-amber-300 ring-1 ring-amber-400/40' : 'text-subtle hover:text-fg')}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function Affix({ prefix, suffix, children }) {
  return (
    <div className="relative">
      {prefix && <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted text-sm">{prefix}</span>}
      {children}
      {suffix && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted text-sm">{suffix}</span>}
    </div>
  )
}

const shortDate = (ymd, withYear = true) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd ?? ''))
  if (!m) return ''
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(withYear && { year: 'numeric' }), timeZone: 'UTC' })
}

// Two lines under the position name:
//   "$5 Call • Exp Jan 21, 2028"        (options only)
//   "Bought Sep 28, 2026"               (+ "· value Sep 28" when the
//                                         stored value isn't from today)
function positionMeta(pos) {
  const contract = []
  // Title is "RXRX • 50 contracts"; this line is "$5 Call • Exp Jan 21, 2028".
  if (!isQuantity(pos.instrument_type)) {
    contract.push([pos.strike && `$${Number(pos.strike).toLocaleString('en-US', { maximumFractionDigits: 2 })}`,
      pos.option_type === 'P' ? 'Put' : 'Call'].filter(Boolean).join(' '))
    if (pos.expiration) contract.push(`Exp ${shortDate(pos.expiration)}`)
  }
  const held = [`${pos.exercised_from_id ? 'Exercised' : 'Bought'} ${shortDate(pos.purchase_date)}`]
  if (pos.value_as_of) {
    const asOf = todayYmd(new Date(pos.value_as_of))
    if (asOf !== todayYmd()) held.push(`value ${shortDate(asOf, asOf.slice(0, 4) !== todayYmd().slice(0, 4))}`)
  }
  return [contract.join(' • '), held.join(' · ')].filter(Boolean)
}

function PositionCard({ pos, calc, ladder, ladderLongTerm, custom, customLongTerm, runner, dividend, plan, previewFor, selectedTargetPct, onSave, onDelete, onExercise, open, onToggle }) {
  const [editing, setEditing] = useState(false)
  const [exercising, setExercising] = useState(false)
  const [showTaxDetail, setShowTaxDetail] = useState(false)
  // Return-of-capital income (STRC-style preferreds): no exit plan.
  const noExitPlan = pos.instrument_type === 'stock' && pos.details?.dividend_kind === 'roc'
  if (editing) {
    return (
      <PositionForm
        initial={pos}
        preview={previewFor}
        onCancel={() => setEditing(false)}
        onSave={async (row) => {
          const err = await onSave(row)
          if (!err) setEditing(false)
          return err
        }}
      />
    )
  }
  if (!calc) return null
  const is1256 = calc.tax_character === 'section_1256'
  const isStock = isQuantity(pos.instrument_type)
  const unit = pos.instrument_type === 'crypto' ? cryptoUnit(pos.ticker) : unitWord(pos.instrument_type)
  const qty = Number(pos.shares)
  const label = isStock
    ? `${pos.ticker} • ${qtyText(qty, unit)}`
    : [pos.ticker,
      Number(pos.contracts) > 0 && `${Number(pos.contracts).toLocaleString('en-US')} contract${Number(pos.contracts) === 1 ? '' : 's'}`,
    ].filter(Boolean).join(' • ')
  const canExercise = exerciseCall({ option: pos, exerciseDate: todayYmd() }) != null
  const stop = isStock ? null : timeStop(pos.expiration, todayYmd(), plan)
  const ltFits = longTermFitsPlan(calc.long_term_date, isStock ? null : pos.expiration, plan)
  const up = calc.gain >= 0
  return (
    <div className="bg-card border border-border rounded-2xl mb-4">
      {/* Header — always visible; tap to expand or collapse. */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={`holding-${pos.id}`}
        className="w-full text-left flex items-start gap-3 p-5 rounded-2xl hover:bg-card-hover/40 transition"
      >
        <div className="flex-1 min-w-0">
          <div className="text-base font-semibold break-words">{label}</div>
          {positionMeta(pos).map((line) => (
            <div key={line} className="text-xs text-muted mt-0.5">{line}</div>
          ))}
          <span
            className={clsx(
              'inline-block mt-2 text-[10px] uppercase tracking-wider px-2 py-1 rounded-md border font-semibold',
              is1256
                ? 'bg-sky-500/15 text-sky-300 border-sky-500/40'
                : calc.is_long_term
                  ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                  : 'bg-amber-500/15 text-amber-300 border-amber-500/40',
            )}
          >
            {is1256 ? '§1256 · 60/40' : calc.is_long_term ? 'Long-term' : 'Short-term'}
          </span>
        </div>
        <div className="shrink-0 flex items-start gap-2">
          {!open && (
            <div className="text-right">
              <div className={clsx('text-base font-semibold font-mono-tab', up ? 'text-green-400' : 'text-rose-300')}>
                {usd(calc.after_tax_value)}
              </div>
              <div className="text-xs text-muted mt-0.5">{gainPct(calc.after_tax_gain, calc.basis)} after tax</div>
              {stop && stop.level !== 'ok' && (
                <div className={clsx('text-xs mt-1 font-semibold', stop.level === 'act' ? 'text-rose-300' : 'text-amber-300')}>
                  {stop.level === 'act' ? 'Time stop' : 'Roll window'}
                </div>
              )}
            </div>
          )}
          <ChevronDown size={18} className={clsx('mt-1 text-muted transition-transform', open && 'rotate-180')} aria-hidden />
        </div>
      </button>

      {open && (
      <div id={`holding-${pos.id}`} className="px-5 pb-5">
      {pos.notes && <div className="text-xs text-subtle -mt-2 mb-4">{pos.notes}</div>}

      <div className="mb-4">
        <div className="text-[10px] uppercase tracking-wider text-muted mb-1">After-tax value if sold today</div>
        {/* Tap the value to reveal the gain / tax breakdown. */}
        <button
          type="button"
          onClick={() => setShowTaxDetail((v) => !v)}
          aria-expanded={showTaxDetail}
          aria-label={`After-tax value ${usd(calc.after_tax_value)}. ${showTaxDetail ? 'Hide' : 'Show'} tax details`}
          className="min-h-[44px] inline-flex items-center gap-1.5 -ml-1 px-1 rounded hover:bg-card-hover transition"
        >
          <span className={clsx('text-2xl font-semibold font-mono-tab', up ? 'text-green-400' : 'text-rose-300')}>
            {usd(calc.after_tax_value)}
          </span>
          <ChevronDown size={14} className={clsx('text-muted transition-transform', showTaxDetail && 'rotate-180')} />
        </button>
        <div className="text-sm text-subtle">
          <span className={calc.after_tax_gain < 0 ? 'text-rose-300' : 'text-green-400'}>{gainPct(calc.after_tax_gain, calc.basis)}</span> after tax
          {' · '}<span className={calc.gain < 0 ? 'text-rose-300' : 'text-amber-300'}>{gainPct(calc.gain, calc.basis)}</span> before tax
        </div>
        {showTaxDetail && (
          <div className="mt-1 text-xs text-muted font-mono-tab">
            {calc.gain > 0
              ? `${usd(calc.after_tax_gain)} after-tax gain · est. tax ${usd(calc.estimated_tax)} at ${ratePct(calc.tax_rate)}`
              : 'Loss — no tax on sale'}
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3 mb-4 py-3 border-y border-hairline">
        <Stat label="Current Value" value={usd(calc.current_value)} />
        <Stat label="Cost" value={usd(calc.basis)} />
        <Stat label="Multiple" value={mult(calc.current_multiple)} />
      </div>

      {dividend && dividend.kind === 'roc' && (
        <div className="grid grid-cols-3 gap-3 mb-4 pb-3 border-b border-hairline">
          <Stat label="Payouts / yr" value={usd(dividend.income)} />
          <Stat label="Tax now" value={usd(0)} />
          <Stat label="Tax at sale / yr" value={usd(dividend.deferred_tax)} />
        </div>
      )}
      {dividend && dividend.kind !== 'roc' && (
        <div className="grid grid-cols-3 gap-3 mb-4 pb-3 border-b border-hairline">
          <Stat label="Dividends / yr" value={usd(dividend.income)} />
          <Stat label="After tax / yr" value={usd(dividend.after_tax_income)} />
          <Stat label="After-tax yield" value={yieldPct(dividend.after_tax_yield)} />
        </div>
      )}

      <TimeStopBanner stop={stop} positionId={pos.id} />

      {!noExitPlan && calc.tax_saved_by_waiting != null && (ltFits ? (
        <Notice id={`${pos.id}:tax-wait:${calc.long_term_date}`} tone="green"
          title={`Long-term on ${shortDate(calc.long_term_date)} saves about ${usd(calc.tax_saved_by_waiting)}`}>
          {calc.days_until_long_term} days away and before your roll window, so it's worth waiting for if a target hits close to it.
        </Notice>
      ) : (
        <Notice id={`${pos.id}:tax-take:${calc.long_term_date}`} tone="neutral" title="Take gains when a target hits">
          Long-term ({shortDate(calc.long_term_date)}) lands after your roll window opens
          {stop ? ` on ${shortDate(stop.window_opens)}` : ''}, so taxes come after the plan.
        </Notice>
      ))}

      {!noExitPlan && (
        <CustomExitTargets
          rows={custom?.length > 0 ? custom : ladder}
          runner={custom?.length > 0 ? null : runner}
          isStock={unit}
          units={isStock ? Number(pos.shares) : Number(pos.contracts)} />
      )}

      {!noExitPlan && calc.target_progress != null && (
        <div className="mb-4">
          <div className="flex text-xs text-muted mb-1.5">
            <span className="flex-1">{pct(calc.goal_pct ?? selectedTargetPct, 0)} after-tax goal</span>
            <span className="font-mono-tab">now {mult(calc.current_multiple)}</span>
          </div>
          <div className="h-1.5 rounded bg-faint overflow-hidden">
            <div className="h-full bg-amber-400" style={{ width: `${calc.target_progress * 100}%` }} />
          </div>
          <div className="mt-1.5 text-xs text-muted">
            Needs <span className="font-mono-tab text-fg">{mult(calc.target_multiple)}</span> {is1256 ? '(§1256 60/40)' : 'long-term'}
            {!is1256 && calc.goal_st_multiple != null && <> · <span className="font-mono-tab text-fg">{mult(calc.goal_st_multiple)}</span> short-term</>}
          </div>
        </div>
      )}

      {exercising && (
        <ExerciseForm pos={pos} onCancel={() => setExercising(false)} onExercise={async (args) => {
          const err = await onExercise(args)
          if (!err) setExercising(false)
          return err
        }} />
      )}

      <div className="flex gap-2 justify-end">
        {canExercise && !exercising && (
          <button type="button" onClick={() => setExercising(true)}
            className="min-h-[44px] px-3 flex items-center gap-1.5 rounded border border-border text-xs text-subtle hover:text-fg hover:border-amber-400/40 transition">
            <ArrowRightLeft size={14} /> Exercise
          </button>
        )}
        <button type="button" onClick={() => setEditing(true)} aria-label="Edit position"
          className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded border border-border text-subtle hover:text-fg hover:border-amber-400/40 transition">
          <Pencil size={14} />
        </button>
        <button type="button" onClick={onDelete} aria-label="Remove position"
          className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded border border-border text-subtle hover:text-rose-300 hover:border-rose-400/40 transition">
          <Trash2 size={14} />
        </button>
      </div>
      </div>
      )}
    </div>
  )
}

// ── Cash + real estate holdings ──────────────────────────────────

// Collapsible card frame shared by cash and real estate (same header as
// PositionCard: title, meta lines, badge, and the value when collapsed).
function HoldingShell({ pos, open, onToggle, title, meta, badge, value, valueLabel, valueUp = true, editing, form, onEdit, onDelete, children }) {
  if (editing) return form
  return (
    <div className="bg-card border border-border rounded-2xl mb-4">
      <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={`holding-${pos.id}`}
        className="w-full text-left flex items-start gap-3 p-5 rounded-2xl hover:bg-card-hover/40 transition">
        <div className="flex-1 min-w-0">
          <div className="text-base font-semibold break-words">{title}</div>
          {meta.filter(Boolean).map((line) => <div key={line} className="text-xs text-muted mt-0.5">{line}</div>)}
          <span className="inline-block mt-2 text-[10px] uppercase tracking-wider px-2 py-1 rounded-md border font-semibold bg-bg/40 text-subtle border-border">
            {badge}
          </span>
        </div>
        <div className="shrink-0 flex items-start gap-2">
          {!open && (
            <div className="text-right">
              <div className={clsx('text-base font-semibold font-mono-tab', valueUp ? 'text-green-400' : 'text-rose-300')}>{value}</div>
              <div className="text-xs text-muted mt-0.5">{valueLabel}</div>
            </div>
          )}
          <ChevronDown size={18} className={clsx('mt-1 text-muted transition-transform', open && 'rotate-180')} aria-hidden />
        </div>
      </button>
      {open && (
        <div id={`holding-${pos.id}`} className="px-5 pb-5">
          {children}
          <div className="flex gap-2 justify-end mt-4">
            <button type="button" onClick={onEdit} aria-label="Edit holding"
              className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded border border-border text-subtle hover:text-fg hover:border-amber-400/40 transition">
              <Pencil size={14} />
            </button>
            <button type="button" onClick={onDelete} aria-label="Remove holding"
              className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded border border-border text-subtle hover:text-rose-300 hover:border-rose-400/40 transition">
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

const cashKindLabel = (k) => CASH_KINDS.find((x) => x.value === k)?.label ?? 'Cash'

function CashCard({ pos, cash, open, onToggle, onSave, onDelete }) {
  const [editing, setEditing] = useState(false)
  const kind = pos.details?.account_kind ?? 'savings'
  return (
    <HoldingShell
      pos={pos} open={open} onToggle={onToggle} editing={editing} onEdit={() => setEditing(true)} onDelete={onDelete}
      form={<PositionForm initial={pos} onCancel={() => setEditing(false)}
        onSave={async (row) => { const err = await onSave(row); if (!err) setEditing(false); return err }} />}
      title={`${pos.name} • ${cashKindLabel(kind)}`}
      meta={[cash.apy > 0 ? `${ratePct(cash.apy)} APY` : 'No yield entered']}
      badge="Cash"
      value={usd(cash.balance)} valueLabel="balance"
    >
      <div className="mb-4">
        <div className="text-[10px] uppercase tracking-wider text-muted mb-1">Balance</div>
        <div className="text-2xl font-semibold font-mono-tab text-green-400">{usd(cash.balance)}</div>
      </div>
      <div className="grid grid-cols-3 gap-3 py-3 border-y border-hairline">
        <Stat label="Interest / yr" value={usd(cash.interest)} />
        <Stat label="After tax / yr" value={usd(cash.after_tax_interest)} />
        <Stat label="After-tax yield" value={yieldPct(cash.after_tax_yield)} />
      </div>
      <p className="mt-3 text-xs text-muted">
        Interest is taxed as ordinary income ({ratePct(cash.rate)}){kind === 't_bills' ? ' — T-bills skip state tax' : ''}.
      </p>
    </HoldingShell>
  )
}

function RealEstateCard({ pos, re, open, onToggle, onSave, onDelete }) {
  const [editing, setEditing] = useState(false)
  if (!re) return null
  const rental = pos.details?.kind === 'rental'
  const reAfterTaxGain = re.amount_realized - re.estimated_tax - re.basis
  return (
    <HoldingShell
      pos={pos} open={open} onToggle={onToggle} editing={editing} onEdit={() => setEditing(true)} onDelete={onDelete}
      form={<PositionForm initial={pos} onCancel={() => setEditing(false)}
        onSave={async (row) => { const err = await onSave(row); if (!err) setEditing(false); return err }} />}
      title={open ? `${pos.name} • ${rental ? 'Rental' : 'Primary home'}` : pos.name}
      meta={[`Bought ${shortDate(pos.purchase_date)}`]}
      badge={re.is_long_term ? 'Long-term' : 'Short-term'}
      value={usd(re.after_tax_equity)} valueLabel={`${gainPct(reAfterTaxGain, re.basis)} after tax`} valueUp={reAfterTaxGain >= 0}
    >
      <div className="mb-4">
        <div className="text-[10px] uppercase tracking-wider text-muted mb-1">After-tax equity if sold today</div>
        <div className={clsx('text-2xl font-semibold font-mono-tab', re.after_tax_equity >= 0 ? 'text-green-400' : 'text-rose-300')}>
          {usd(re.after_tax_equity)}
        </div>
        <div className="mt-1 text-sm text-subtle">
          <span className={reAfterTaxGain >= 0 ? 'text-green-400' : 'text-rose-300'}>{gainPct(reAfterTaxGain, re.basis)}</span> after tax
          {' · '}<span className={re.value < re.basis ? 'text-rose-300' : 'text-amber-300'}>{gainPct(re.value - re.basis, re.basis)}</span> before tax
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3 py-3 border-y border-hairline">
        <Stat label="Current Value" value={usd(re.value)} />
        <Stat label="Mortgage" value={usd(re.mortgage)} />
        <Stat label="Equity" value={usd(re.equity)} />
      </div>
      <ol className="mt-4 space-y-2 text-sm">
        <SaleRow label="Selling costs" value={`−${usd(re.selling_costs)}`} />
        <SaleRow label="Gain" value={usd(Math.max(0, re.gain))} />
        {re.excluded > 0 && <SaleRow label="Home-sale exclusion" value={`−${usd(re.excluded)}`} />}
        {re.recapture_gain > 0 && <SaleRow label={`Depreciation recapture at ${ratePct(re.recapture_rate)}`} value={usd(re.recapture_gain)} />}
        <SaleRow label="Estimated tax" value={re.estimated_tax > 0 ? `−${usd(re.estimated_tax)}` : usd(0)} strong />
      </ol>
      {!rental && re.exclusion === 0 && (
        <p className="mt-3 text-xs text-muted">No home-sale exclusion: you haven't lived here 2 of the last 5 years.</p>
      )}
    </HoldingShell>
  )
}

function SaleRow({ label, value, strong }) {
  return (
    <li className="flex items-baseline gap-3">
      <span className={clsx('flex-1', strong ? 'text-fg' : 'text-subtle')}>{label}</span>
      <span className={clsx('font-mono-tab', strong ? 'text-fg font-semibold' : 'text-fg')}>{value}</span>
    </li>
  )
}

// Where idle cash earns the most AFTER TAX for this user. Categories only
// (no named products). Rates are what the user types — prefilled with
// example rates and remembered on this device. Cash keeps its principal;
// income investments pay more but their prices can move.
const YIELD_OPTIONS = [
  { kind: 'savings', label: 'High-yield savings', example: 4.0 },
  { kind: 'money_market', label: 'Money market', example: 4.1 },
  { kind: 't_bills', label: 'T-bills', example: 4.0 },
  { kind: 'cd', label: '1-year CD', example: 4.1 },
]
const INCOME_OPTIONS = [
  { key: 'div_qualified', kind: 'qualified', label: 'Dividend ETF', example: 3.0 },
  { key: 'div_reit', kind: 'reit', label: 'REIT ETF', example: 4.0 },
  { key: 'div_covered_call', kind: 'ordinary', label: 'Covered-call ETF', example: 9.0 },
  { key: 'div_muni', kind: 'muni', label: 'Muni fund', example: 3.5 },
  { key: 'div_treasury', kind: 'treasury', label: 'Treasury fund', example: 4.2 },
  { key: 'div_btc_preferred', kind: 'roc', label: 'BTC preferred', example: 11.0 },
]
const YIELD_KEY = 'cm:cash-yield-apys'

function exampleApys() {
  return Object.fromEntries([
    ...YIELD_OPTIONS.map((o) => [o.kind, String(o.example)]),
    ...INCOME_OPTIONS.map((o) => [o.key, String(o.example)]),
  ])
}

function YieldRows({ rows, apys, setApy, best }) {
  return (
    <ol className="space-y-2">
      {rows.map((r) => (
        <li key={r.key ?? r.kind} className="grid grid-cols-[minmax(0,1fr)_5.5rem_4.5rem] gap-x-3 items-center">
          <div className="min-w-0">
            <div className="text-sm text-fg truncate">{r.label}</div>
            <div className="text-xs text-muted">{usd(r.after_tax_interest)}/yr{r.kind === 'roc' ? ' · after tax at sale' : ''}{r === best ? ' · best' : ''}</div>
          </div>
          <Affix suffix="%">
            <NumberInput decimals={3} value={apys[r.key ?? r.kind]} onChange={(v) => setApy(r.key ?? r.kind, v)}
              aria-label={`${r.label} rate`} className={clsx(inputCls, 'pr-7')} />
          </Affix>
          <div className={clsx('text-sm font-mono-tab text-right', r === best ? 'text-green-400 font-semibold' : 'text-fg')}>
            {yieldPct(r.after_tax_yield)}
          </div>
        </li>
      ))}
    </ol>
  )
}

// This holding's after-tax return goal, with the full targets table a tap
// away (solved on the cost entered above). Blank = the Settings default.
function GoalSection({ goal, onGoal, basis, is1256 }) {
  const { rateForGain, defaultGoal } = useContext(RatesContext)
  const [showAll, setShowAll] = useState(false)
  // An empty field shows the default goal (Settings), so there's always a number.
  const defaultStr = defaultGoal ? String(+(defaultGoal * 100).toFixed(2)) : ''
  // Fill once when the editor opens (and on blur, below) — not while typing,
  // so the field can be cleared to type a new number.
  useEffect(() => {
    if (goal === '' && defaultStr) onGoal(defaultStr)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultStr])
  const g = num(goal)
  const active = g > 0 ? g / 100 : defaultGoal
  const table = rateForGain && basis > 0
    ? targetTable({ basis, targetPcts: [...new Set([...DEFAULT_TARGET_PCTS, ...(active ? [active] : [])])], rateForGain })
    : null
  const row = table?.rows.find((r) => Math.abs(r.target_pct - active) < 1e-9)
  return (
    <FormSection title="After-tax goal">
      <Field wide label="Goal for this holding">
        <Affix suffix="%"><NumberInput decimals={2} value={goal} onChange={onGoal}
          onBlur={() => { if (goal === '' && defaultStr) onGoal(defaultStr) }}
          placeholder={defaultGoal ? String(+(defaultGoal * 100).toFixed(2)) : '50'} className={clsx(inputCls, 'pr-8')} /></Affix>
      </Field>
      {row && (
        <div className="mt-2 text-xs text-muted space-y-0.5">
          <div><span className="font-mono-tab text-green-400">+{usd(row.after_tax_target)}</span> after taxes</div>
          <div>Needs <span className="font-mono-tab text-fg">{mult(is1256 ? row.section_1256.required_multiple : row.long_term.required_multiple)}</span> {is1256 ? '(§1256 60/40)' : 'long-term'}</div>
          {!is1256 && <div>Needs <span className="font-mono-tab text-fg">{mult(row.short_term.required_multiple)}</span> short-term</div>}
        </div>
      )}
      {table && (
        <>
          <button type="button" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}
            className="mt-2 min-h-[44px] inline-flex items-center gap-1 text-sm text-amber-300 hover:text-amber-200">
            {showAll ? 'Hide targets' : 'Show all targets'}
            <ChevronDown size={14} className={clsx('transition-transform', showAll && 'rotate-180')} />
          </button>
          {showAll && (
            <table className="w-full text-sm mt-1">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-muted">
                  <th className="text-left font-medium pb-2">Target</th>
                  <th className="text-right font-medium pb-2">After tax</th>
                  {is1256
                    ? <th className="text-right font-medium pb-2">§1256</th>
                    : <><th className="text-right font-medium pb-2">Long-term</th><th className="text-right font-medium pb-2">Short-term</th></>}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((r) => (
                  <tr key={r.target_pct} onClick={() => onGoal(String(+(r.target_pct * 100).toFixed(2)))}
                    className={clsx('cursor-pointer border-t border-hairline',
                      Math.abs(r.target_pct - active) < 1e-9 ? 'text-amber-300 bg-amber-400/5' : 'hover:bg-card-hover')}>
                    <td className="py-3 font-mono-tab">{pct(r.target_pct, 0)}</td>
                    <td className="py-3 text-right font-mono-tab">{usd(r.after_tax_target)}</td>
                    {is1256
                      ? <td className="py-3 text-right font-mono-tab font-semibold">{mult(r.section_1256.required_multiple)}</td>
                      : <>
                          <td className="py-3 text-right font-mono-tab font-semibold">{mult(r.long_term.required_multiple)}</td>
                          <td className="py-3 text-right font-mono-tab">{mult(r.short_term.required_multiple)}</td>
                        </>}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </FormSection>
  )
}

// Inside the cash / income editor: what this amount would keep after
// tax in each category, at rates the user enters (saved on the device).
function YieldCompare({ group, amount }) {
  const { rateForGain } = useContext(RatesContext)
  const [apys, setApys] = useState(() => {
    try { return { ...exampleApys(), ...JSON.parse(localStorage.getItem(YIELD_KEY) ?? '{}') } }
    catch { return exampleApys() }
  })
  if (!rateForGain) return null
  const setApy = (key, v) => {
    const next = { ...apys, [key]: v }
    setApys(next)
    try { localStorage.setItem(YIELD_KEY, JSON.stringify(next)) } catch { /* per-visit only */ }
  }
  const balance = Math.max(0, Number(amount) || 0)
  const cash = group === 'cash'
  const rows = cash
    ? cashYieldComparison({ balance, rateForGain, options: YIELD_OPTIONS.map((o) => ({ ...o, apy: (num(apys[o.kind]) ?? 0) / 100 })) })
    : incomeYieldComparison({ balance, rateForGain, options: INCOME_OPTIONS.map((o) => ({ ...o, apy: (num(apys[o.key]) ?? 0) / 100 })) })
  return (
    <FormSection title="Compare after tax">
      <p className="text-xs text-muted mb-3">
        {balance > 0 ? `On ${usd(balance)}. ` : ''}Example rates — enter what you're offered.
      </p>
      <div className="grid grid-cols-[minmax(0,1fr)_5.5rem_4.5rem] gap-x-3 text-[10px] uppercase tracking-wider text-muted mb-2">
        <span>{cash ? 'Principal stays put' : 'Prices can move'}</span><span>{cash ? 'Rate' : 'Yield'}</span><span className="text-right">After tax</span>
      </div>
      <YieldRows rows={rows} apys={apys} setApy={setApy} best={rows[0]} />
      <p className="mt-3 text-xs text-muted">
        {cash
          ? 'T-bills skip state tax. Not a recommendation.'
          : "Treasury funds skip state tax; muni funds skip federal tax; qualified dividends get long-term rates; return of capital is taxed when you sell. Not a recommendation."}
      </p>
    </FormSection>
  )
}

// ── After-tax exit ladder ─────────────────────────────────────────

const CHARACTER_LABEL = {
  long_term: 'long-term rate',
  short_term: 'short-term rate',
  section_1256: '§1256 60/40 rate',
}


function TimeStopBanner({ stop, positionId }) {
  if (!stop || stop.level === 'ok') return null
  const months = Math.max(0, Math.floor(stop.dte / 30.4))
  const act = stop.level === 'act'
  // A dismissed "act now" comes back the next day; the roll-window
  // warning stays dismissed until it escalates.
  const id = act ? `${positionId}:time-stop:${todayYmd()}` : `${positionId}:roll-window:${stop.act_by}`
  return act ? (
    <Notice id={id} tone="red" title="Time stop: exit or roll now">
      {stop.dte} days left. Theta speeds up from here, so don't hold into the last months hoping for a move.
      If the thesis is intact, roll to a new LEAPS.
    </Notice>
  ) : (
    <Notice id={id} tone="amber" title={`Roll window · ${months} months left`}>
      Plan to exit or roll by {shortDate(stop.act_by)}, 6 months before expiry.
    </Notice>
  )
}

// One style for every card notice: a bold title and body at the same
// size, and an X that dismisses it (remembered on this device).
const NOTICE_TONE = {
  green: 'border-emerald-500/30 bg-emerald-500/5 text-emerald-100',
  amber: 'border-amber-500/40 bg-amber-500/5 text-amber-100',
  red: 'border-rose-500/40 bg-rose-500/5 text-rose-100',
  neutral: 'border-border bg-bg/40 text-fg',
}

function dismissKey(id) {
  return `cm:notice-dismissed:${id}`
}

function Notice({ id, tone = 'neutral', title, children }) {
  const [hidden, setHidden] = useState(() => {
    try { return localStorage.getItem(dismissKey(id)) === '1' } catch { return false }
  })
  if (hidden) return null
  function dismiss() {
    setHidden(true)
    try { localStorage.setItem(dismissKey(id), '1') } catch { /* storage blocked — hide for this visit only */ }
  }
  return (
    <div role="status" className={clsx('rounded-xl border pl-4 pr-1.5 pt-1.5 pb-3.5 mb-4', NOTICE_TONE[tone])}>
      {/* Small X on the title row, top right; the body runs full width. */}
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0 pt-2 text-sm font-semibold">{title}</div>
        <button type="button" onClick={dismiss} aria-label="Dismiss"
          className="shrink-0 min-h-[44px] min-w-[44px] -mb-2 flex items-start justify-end pt-3 pr-2 rounded-lg opacity-60 hover:opacity-100 transition">
          <X size={12} />
        </button>
      </div>
      <div className="pr-3 text-sm mt-1 opacity-75">{children}</div>
    </div>
  )
}

function TargetsPanel({ title, subtitle, info, children, footer }) {
  return (
    <div className="mb-4 rounded-xl border border-border bg-bg/40 p-4">
      <div className="flex items-center gap-2 mb-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        {info}
      </div>
      <p className="text-xs text-muted mb-4">{subtitle}</p>
      <ol className="space-y-4">{children}</ol>
      {footer}
    </div>
  )
}

function RungProgress({ hit, progress }) {
  if (hit) return <span className="text-xs text-green-400 font-semibold">Target reached</span>
  if (progress == null) return null
  return (
    <div className="h-1.5 rounded-full bg-faint overflow-hidden" aria-label={`${Math.round(progress * 100)}% of the way`}>
      <div className="h-full rounded-full bg-amber-400" style={{ width: `${progress * 100}%` }} />
    </div>
  )
}



// Live preview while the user is typing a position in the form:
// the account ladder, or the user's own % / $ targets when set.
function previewTargets(f, own, ladderFor, customFor) {
  const basis = num(f.cost_basis)
  if (!(basis > 0) || !f.purchase_date) return []
  const value = num(f.current_value) ?? basis
  const character = f.instrument_type === 'index_option_1256'
    ? 'section_1256'
    : (holdingPeriod(f.purchase_date, todayYmd())?.is_long_term ? 'long_term' : 'short_term')
  const contracts = wholeUnits(isQuantity(f.instrument_type) ? num(f.shares) : num(f.contracts))
  if (own) {
    const usable = own.filter((t) => Number.isFinite(t.value) && t.value > 0 && Number.isFinite(t.sell) && t.sell > 0)
    return customFor(basis, value, character, contracts, usable)
  }
  return ladderFor(basis, value, character, contracts)
}

// ── User-set Exit Targets (% or $) ───────────────────────────────

function TargetsEditor({ own, rows, contracts, eachLabel = 'per share', onOwn, onRow, onAdd, onRemove }) {
  const sold = rows.reduce((sum, r) => sum + (num(r.sell) ?? 0), 0)
  const over = sold > 100.0001
  return (
    <div>
      <Segmented value={own ? 'own' : 'default'} onChange={(v) => onOwn(v === 'own')}
        options={[{ value: 'default', label: 'Default' }, { value: 'own', label: 'Custom' }]} />
      {!own ? (
        <p className="mt-3 text-xs text-muted">
          Uses your exit plan from <Link to="/settings#exit-targets" className="text-amber-300 underline underline-offset-2">Settings</Link>.
        </p>
      ) : (
        <>
          <ol className="mt-3 space-y-2">
            {rows.map((r, i) => {
              const sellN = num(r.sell)
              const lots = contracts && sellN > 0 ? Math.round((contracts * sellN) / 100) : null
              return (
                <li key={i} className="rounded-lg border border-border bg-bg/40 p-3">
                  <div className="flex items-center mb-2">
                    <span className="flex-1 text-[11px] font-semibold text-subtle">Target {i + 1}</span>
                    <button type="button" onClick={() => onRemove(i)} disabled={rows.length <= 1}
                      aria-label={`Remove target ${i + 1}`}
                      className="-my-2 -mr-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded text-subtle hover:text-rose-300 disabled:opacity-30 disabled:hover:text-subtle">
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <Segmented compact value={r.kind} onChange={(k) => onRow(i, 'kind', k)}
                    options={[{ value: 'pct', label: '% gain' }, { value: 'each', label: `$ ${eachLabel}` }, { value: 'usd', label: '$ total' }]} />
                  <div className="mt-2">
                    <Affix prefix={r.kind === 'pct' ? '+' : '$'} suffix={r.kind === 'pct' ? '%' : null}>
                      <NumberInput value={r.value} onChange={(v) => onRow(i, 'value', v)}
                        decimals={r.kind === 'each' ? PRICE_DECIMALS : 2}
                        aria-label={r.kind === 'pct' ? `Target ${i + 1} gain percent` : r.kind === 'each' ? `Target ${i + 1} price ${eachLabel}` : `Target ${i + 1} position value`}
                        placeholder={r.kind === 'pct' ? '100' : r.kind === 'each' ? '250' : '60,000'}
                        className={clsx(inputCls, 'pl-7', r.kind === 'pct' && 'pr-8')} />
                    </Affix>
                  </div>
                  <div className="mt-2 grid grid-cols-[6rem_minmax(0,1fr)] gap-2 items-center">
                    <Affix suffix="%">
                      <NumberInput value={r.sell} onChange={(v) => onRow(i, 'sell', v)}
                        aria-label={`Target ${i + 1} share to sell`} placeholder="50"
                        className={clsx(inputCls, 'pr-8')} />
                    </Affix>
                    <span className="text-xs text-subtle truncate">
                      sold{lots != null && <span className="text-muted"> · {lots} of {contracts} contract{contracts === 1 ? '' : 's'}</span>}
                    </span>
                  </div>
                </li>
              )
            })}
          </ol>
          <div className="flex items-center gap-2 mt-2">
            <span className={clsx('flex-1 text-[11px]', over ? 'text-rose-300' : 'text-muted')}>
              {over ? `${+sold.toFixed(2)}% sold — more than the whole position` : `${+sold.toFixed(2)}% sold${sold < 99.9999 ? ` · ${+(100 - sold).toFixed(2)}% held` : ''}`}
            </span>
            {rows.length < MAX_CUSTOM_TARGETS && (
              <button type="button" onClick={onAdd}
                className="min-h-[44px] px-3 rounded-lg border border-border text-xs text-subtle hover:text-fg hover:border-amber-400/40 transition">
                <Plus size={12} className="inline -mt-0.5" /> Add target
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// "−35 contracts" / "−1,050 shares" (what the sale takes off) — always a count, never a
// fraction. Fractional share holdings get a share count to 2 dp.
// `isStock` is true for shares, or the unit itself ('$BTC' for crypto).
// Fractional shares to 2 dp; crypto keeps up to 8 (0.1625 $BTC, not 0.16).
const roundUnits = (n, unit) => +Number(n).toFixed(unit.startsWith('$') ? 8 : 2)

const soldLabel = (r, isStock, units = null) => {
  const unit = typeof isStock === 'string' ? isStock : isStock ? 'share' : 'contract'
  if (r.contracts == null) {
    const n = units > 0 ? roundUnits(units * r.fraction, unit) : null
    return n == null ? `−${pct(r.fraction, 0)}` : `−${qtyText(n, unit)}`
  }
  if (r.contracts === 0) return `nothing to sell (too few ${unit.startsWith('$') ? unit : `${unit}s`})`
  return `−${qtyText(r.contracts, unit)}`
}

// Whole units (contracts or shares) to split across targets, or null.
function wholeUnits(v) {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

// Exit Targets in the original card format:
//   100% gain • 2x                          $12,000
//   Target 1 · sell 35 contracts
//   [progress strip]
// The right value is what the whole position must be worth for that
// target to sell. Targets are gains on the option (the playbook), so the
// price is the same short- or long-term.
const multShort = (n) => (!Number.isFinite(n) ? '—' : Number.isInteger(+n.toFixed(2)) ? `${+n.toFixed(2)}x` : `${n.toFixed(2)}x`)
// Every target reads "N% gain • Nx"; the position value sits on the right
// (a $ target's value is what the user typed).
const gainLabel = (r) => `${pct(r.gain_pct, r.gain_pct >= 1 || Number.isInteger(+(r.gain_pct * 100).toFixed(4)) ? 0 : 1)} gain • ${multShort(r.exit_multiple)}`

function CustomTargetsPreview({ rows, isStock, units }) {
  if (!rows?.length) return null
  return (
    <div className="mt-4 rounded-xl border border-border bg-bg/40 p-4">
      <div className="text-[10px] uppercase tracking-wider text-muted mb-3">Sell when the position is worth</div>
      <ol className="space-y-3">
        {rows.map((r, i) => (
          <li key={r.index} className="flex items-baseline gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-sm text-fg whitespace-nowrap">{gainLabel(r)}</div>
              <div className={clsx('text-xs mt-0.5', r.contracts === 0 ? 'text-muted' : 'text-amber-300')}>{soldLabel(r, isStock, units)}</div>
            </div>
            <div className="text-sm font-mono-tab text-fg font-semibold shrink-0">{usd(r.exit_value)}</div>
          </li>
        ))}
      </ol>
    </div>
  )
}

function CustomExitTargets({ title = 'Exit Targets', rows, runner, isStock, units }) {
  if (!rows?.length) return null
  const unit = typeof isStock === 'string' ? isStock : isStock ? 'share' : 'contract'
  // Price per share / coin at each target (options: premium per share).
  const priceUnits = units > 0 ? (isStock ? units : units * OPTION_MULTIPLIER) : null
  const perUnit = unit.startsWith('$') ? unit : 'share'
  // Custom targets may sell less than all of it: show what's kept.
  const soldShare = rows.reduce((a, r) => a + (r.fraction || 0), 0)
  const heldShare = !runner && soldShare < 1 - 1e-9 ? 1 - soldShare : 0
  const heldLabel = units > 0 ? qtyText(roundUnits(units * heldShare, unit), unit) : pct(heldShare, 0)
  return (
    <TargetsPanel
      title={title}
      subtitle="Sell when the position is worth"
      footer={heldShare > 0 ? (
        <div className="mt-4 pt-4 border-t border-hairline flex items-baseline gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-sm text-fg">Kept</div>
            <div className="text-xs mt-0.5 text-subtle">{heldLabel} not in a target</div>
          </div>
          <div className="text-xs text-muted shrink-0">{pct(heldShare, 0)} of position</div>
        </div>
      ) : runner && runner.contracts !== 0 ? (
        <div className="mt-4 pt-4 border-t border-hairline">
          <div className="flex items-baseline gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-sm text-fg">Runner · {pct(runner.trail_pct, 0)} trail</div>
              <div className="text-xs mt-0.5 text-amber-300">
                {runner.contracts != null
                  ? `−${qtyText(runner.contracts, unit)}`
                  : units > 0 ? `−${qtyText(roundUnits(units * runner.share, unit), unit)}` : `−${pct(runner.share, 0)}`}
              </div>
              {runner.after_tax_gain != null && (
                <div className="text-xs text-muted mt-0.5">
                  {runner.after_tax_gain >= 0
                    ? <><span className="font-mono-tab text-green-400">+{usd(runner.after_tax_gain)}</span> after taxes</>
                    : <><span className="font-mono-tab text-rose-300">−{usd(Math.abs(runner.after_tax_gain))}</span> loss at today's trail</>}
                </div>
              )}
            </div>
            <div className="text-right shrink-0">
              <div className="text-sm font-mono-tab font-semibold text-fg">{usd(runner.exit_value)}</div>
              <div className="text-xs text-muted mt-0.5">sell if trigger fires</div>
            </div>
          </div>
        </div>
      ) : null}
    >
      {rows.map((r, i) => (
        <li key={r.index}>
          <div className="flex items-baseline gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-sm text-fg whitespace-nowrap">{gainLabel(r)}</div>
              <div className={clsx('text-xs mt-0.5', r.contracts === 0 ? 'text-muted' : 'text-amber-300')}>{soldLabel(r, isStock, units)}</div>
              {r.after_tax_gain > 0 && (
                <div className="text-xs text-muted mt-0.5"><span className="font-mono-tab text-green-400">+{usd(r.after_tax_gain)}</span> after taxes</div>
              )}
            </div>
            <div className="text-right shrink-0">
              <div className={clsx('text-sm font-mono-tab font-semibold', r.hit ? 'text-green-400' : 'text-fg')}>{usd(r.exit_value)}</div>
              {priceUnits && <div className="text-xs text-muted mt-0.5 font-mono-tab">{usdUnit(r.exit_value / priceUnits)} / {perUnit}</div>}
            </div>
          </div>
          <div className="mt-2"><RungProgress hit={r.hit} progress={r.progress} /></div>
        </li>
      ))}
    </TargetsPanel>
  )
}

function ExerciseForm({ pos, onExercise, onCancel }) {
  const [date, setDate] = useState(todayYmd())
  const [shares, setShares] = useState(String(Number(pos.contracts) * 100))
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const preview = exerciseCall({ option: pos, exerciseDate: date, shares: num(shares) })

  async function submit() {
    const v = num(value)
    if (!preview) return setError('Check the exercise date and share count.')
    if (date < pos.purchase_date || date > todayYmd()) return setError('Exercise date must be between the purchase date and today.')
    if (v == null || v < 0) return setError('Enter the current value of the shares.')
    const err = await onExercise({ exerciseDate: date, shares: preview.shares, currentValue: v })
    setError(err ?? '')
  }

  return (
    <div className="rounded-xl border border-amber-400/40 p-4 mb-4">
      <div className="flex items-center gap-2 mb-4">
        <h3 className="text-sm font-semibold">Exercise into stock</h3>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Exercise date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={dateCls} /></Field>
        <Field label="Shares received"><NumberInput decimals={4} value={shares} onChange={setShares} className={inputCls} /></Field>
        <Field label="Value of the shares now" wide><Affix prefix="$"><NumberInput decimals={PRICE_DECIMALS} value={value} onChange={setValue} className={clsx(inputCls, 'pl-7')} /></Affix></Field>
      </div>
      {preview && (
        <div className="mt-3 text-[10px] text-subtle font-mono-tab">
          New basis {usd(Number(pos.cost_basis))} premium + {usd(Number(pos.strike) * preview.shares)} strike = {usd(preview.cost_basis)}
          {' · '}long-term from {holdingStart(date)}
        </div>
      )}
      {error && <div className="mt-2 text-xs text-rose-300">{error}</div>}
      <div className="mt-3 flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className="min-h-[44px] px-4 rounded border border-border text-sm text-subtle hover:text-fg">Cancel</button>
        <button type="button" onClick={submit} className="min-h-[44px] px-4 rounded bg-amber-400/10 border border-amber-400/40 text-amber-300 text-sm font-semibold hover:bg-amber-400/20 transition">
          Exercise
        </button>
      </div>
    </div>
  )
}

function holdingStart(date) {
  return holdingPeriod(date, date)?.long_term_date ?? '—'
}

// The portfolio is the sum of the open positions — nothing else.
// The portfolio is the sum of the holdings. With cash or real estate it
// leads with after-tax net worth and breaks it down by type; the cost /
// gain / return stats cover investments only (options, shares, crypto).
function PortfolioTotals({ summary, count, others }) {
  const hasOthers = others && (others.cashCount > 0 || others.realEstateCount > 0)
  const invested = summary?.after_tax_value ?? 0
  const total = invested + (others?.cash ?? 0) + (others?.realEstate ?? 0)
  const up = hasOthers ? total >= 0 : (summary?.after_tax_gain ?? 0) >= 0
  const holdings = count + (others?.cashCount ?? 0) + (others?.realEstateCount ?? 0)
  return (
    <section className="bg-card border border-amber-400/30 rounded-2xl p-5 mb-5">
      <div className="flex items-center gap-2 mb-4">
        <h2 className="text-sm font-semibold">Portfolio</h2>
        <span className="flex-1" />
        <span className="text-xs text-muted">{holdings} holding{holdings === 1 ? '' : 's'}</span>
      </div>
      <div className="text-[10px] uppercase tracking-wider text-muted mb-1">
        {hasOthers ? 'After-tax net worth' : 'After-tax value if all sold today'}
      </div>
      <div className={clsx('text-3xl font-semibold font-mono-tab mb-5', up ? 'text-green-400' : 'text-rose-300')}>
        {usd(hasOthers ? total : invested)}
      </div>
      {hasOthers && (
        <div className="grid grid-cols-3 gap-3 pt-4 border-t border-hairline mb-4">
          <Stat label="Investments" value={usd(invested)} />
          <Stat label="Cash" value={usd(others.cash)} />
          <Stat label="Real Estate" value={usd(others.realEstate)} />
        </div>
      )}
      {others?.income > 0 && (
        <div className="flex items-baseline gap-3 pt-4 border-t border-hairline mb-4">
          <span className="flex-1 text-sm text-subtle">Income after tax</span>
          <span className="text-sm font-mono-tab text-green-400 font-semibold">{usd(others.income)}/yr</span>
        </div>
      )}
      {summary && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-4 pt-4 border-t border-hairline">
          <Stat label={hasOthers ? 'Investments cost' : 'Total cost'} value={usd(summary.basis)} />
          <Stat label="Current Value" value={usd(summary.current_value)} />
          <Stat label="After-tax gain" value={usd(summary.after_tax_gain)} />
          <Stat label="After-tax return" value={pct(summary.after_tax_return_pct)} />
        </div>
      )}
    </section>
  )
}

// ── Bits ──────────────────────────────────────────────────────────

// `text` = a word value (Single, Georgia) — sans, not the number font.
function Stat({ label, value, strong, text }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted truncate mb-1">{label}</div>
      <div className={clsx('text-sm truncate', !text && 'font-mono-tab', strong ? 'text-fg font-semibold' : 'text-fg')}>{value ?? '—'}</div>
    </div>
  )
}

function Field({ label, hint, wide, children }) {
  return (
    <label className={clsx('block min-w-0', wide && 'col-span-2')}>
      <span className="flex items-baseline gap-1.5 text-[11px] text-subtle mb-1.5">
        {label}
        {hint && <span className="text-[10px] text-muted">{hint}</span>}
      </span>
      {children}
    </label>
  )
}

function Banner({ tone, children }) {
  return (
    <div className={clsx(
      'rounded-xl border px-4 py-3 mb-4 flex items-start gap-2 text-xs',
      tone === 'rose' ? 'border-rose-500/40 bg-rose-500/5 text-rose-200' : 'border-amber-500/40 bg-amber-500/5 text-amber-200',
    )}>
      <AlertTriangle size={14} className="shrink-0 mt-0.5" />
      <div>{children}</div>
    </div>
  )
}
