import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Landmark, Plus, Pencil, Trash2, Check, X, AlertTriangle, Info, ArrowRightLeft, ShieldCheck, ChevronDown } from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import {
  FILING_STATUSES, DEFAULT_TARGET_PCTS, makeRateResolver, deriveRates,
  applyRateOverride, targetTable, positionAfterTax, portfolioSummary,
  todayYmd, holdingPeriod, suggestInstrumentType, exerciseCall,
  blended1256Rate, exitLadder, rateAtGainFor, DEFAULT_EXIT_LADDER,
  customExitTargets, validateCustomTargets, MAX_CUSTOM_TARGETS,
} from '../utils/afterTax'
import NumberInput from '../components/NumberInput'

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
const mult = (n) => (Number.isFinite(n) ? `${n.toFixed(2)}x` : '—')
const pct = (n, dp = 1) => (Number.isFinite(n)
  ? `${(n * 100).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}%`
  : '—')
// Rates like 0.2879 read best at 2dp ("28.79%"); trim trailing zeros.
const ratePct = (n) => (Number.isFinite(n) ? `${+(n * 100).toFixed(2)}%` : '—')

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
  // Exit-ladder settings live on the engine's risk profile (service-role
  // written); fall back to the default 1x/2x/3x after-tax ladder.
  const [ladderCfg, setLadderCfg] = useState({ targets: DEFAULT_EXIT_LADDER, fractions: null })

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
          supabase.from('ldp_risk_profiles').select('exit_ladder, rung_fractions').eq('user_id', user.id).maybeSingle(),
        ])
        if (cancelled) return
        if (fed.error || prof.error || pos.error) {
          console.error('[leaps] load failed', fed.error || prof.error || pos.error)
          setLoadError('Could not load your LEAPS data. Reload the page to try again.')
        }
        setFederal(fed.data ?? null)
        setProfile(prof.data ?? null)
        setPositions(pos.data ?? [])
        const ladder = (risk.data?.exit_ladder ?? []).map(Number).filter((t) => t > 0)
        if (ladder.length) {
          const fr = risk.data?.rung_fractions?.map(Number)
          setLadderCfg({ targets: ladder, fractions: fr?.length === ladder.length ? fr : null })
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

  const portfolio = Number(p.portfolio_size) || 0
  const table = useMemo(() => {
    if (!rateForGain) return null
    return targetTable({
      portfolio,
      allocationPct: Number(p.leaps_allocation_pct) || 0,
      targetPcts: (p.target_pcts ?? DEFAULT_TARGET_PCTS).map(Number),
      rateForGain,
    })
  }, [rateForGain, portfolio, p.leaps_allocation_pct, p.target_pcts])

  const selectedRow = table?.rows.find((r) => r.target_pct === Number(p.selected_target_pct)) ?? null
  const asOf = todayYmd()

  const ladderFor = useCallback((basis, currentValue, character, contracts) => {
    if (!rateForGain) return []
    return exitLadder({
      basis, currentValue, contracts, targets: ladderCfg.targets, fractions: ladderCfg.fractions,
      rateAtGain: rateAtGainFor(character, rateForGain),
    })
  }, [rateForGain, ladderCfg])

  // User-set % / $ targets on a single position (leaps_positions.exit_targets).
  const customFor = useCallback((basis, currentValue, character, contracts, targets) => {
    if (!rateForGain || !targets?.length) return []
    return customExitTargets({ basis, currentValue, contracts, targets, rateAtGain: rateAtGainFor(character, rateForGain) })
  }, [rateForGain])

  const results = useMemo(() => {
    if (!rateForGain || !positions) return []
    return positions.map((pos) => withLadder(pos, positionAfterTax({
        basis: Number(pos.cost_basis),
        currentValue: Number(pos.current_value),
        purchaseDate: pos.purchase_date,
        asOf,
        rateForGain,
        instrumentType: pos.instrument_type,
        targetMultiple: pos.instrument_type === 'index_option_1256'
          ? selectedRow?.section_1256.required_multiple
          : selectedRow?.long_term.required_multiple,
      })))

    function withLadder(pos, calc) {
      if (!calc) return { pos, calc, ladder: [], ladderLongTerm: null, custom: [], customLongTerm: null }
      const contracts = pos.instrument_type === 'stock' ? null : (Number(pos.contracts) || null)
      const own = Array.isArray(pos.exit_targets) && pos.exit_targets.length ? pos.exit_targets : null
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
      }
    }
  }, [positions, rateForGain, asOf, selectedRow, ladderFor, customFor])

  const summary = useMemo(() => {
    if (!rateForGain || results.length === 0) return null
    return portfolioSummary(results.map((r) => r.calc), portfolio, rateForGain)
  }, [results, portfolio, rateForGain])

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

  async function selectTarget(targetPct) {
    setProfile((cur) => ({ ...(cur ?? DEFAULT_PROFILE), selected_target_pct: targetPct }))
    if (profile) await saveProfile({ selected_target_pct: targetPct })
  }

  async function savePosition(row, id) {
    const q = id
      ? supabase.from('leaps_positions').update(row).eq('id', id).eq('user_id', user.id)
      : supabase.from('leaps_positions').insert({ ...row, user_id: user.id })
    const { data, error } = await q.select().single()
    if (error) return error.message
    setPositions((cur) => (id ? cur.map((x) => (x.id === id ? data : x)) : [...cur, data]))
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

  async function deletePosition(id) {
    if (!window.confirm('Remove this position from tracking?')) return
    const { error } = await supabase.from('leaps_positions').delete().eq('id', id).eq('user_id', user.id)
    if (!error) setPositions((cur) => cur.filter((x) => x.id !== id))
  }

  return (
    <div className="px-4 py-4 pb-24 max-w-2xl mx-auto">
      <header className="mb-4">
        <div className="flex items-center gap-2 mb-1">
          <Landmark size={16} className="text-amber-400" />
          <h1 className="text-lg font-semibold flex-1">LEAPS · After-Tax</h1>
          {federal && (
            <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border border-border text-subtle">
              {federal.tax_year} tax figures
            </span>
          )}
        </div>
        <p className="text-xs text-subtle leading-relaxed">
          What your LEAPS are worth after tax, and the multiple you need to
          hit each after-tax goal. Pre-tax gains overstate what you keep.
        </p>
      </header>

      {loadError && <Banner tone="rose">{loadError}</Banner>}
      <RiskProfileCard userId={user?.id} />
      {federal === null && positions !== null && !loadError && (
        <Banner tone="amber">Tax figures for the current year haven't been loaded yet.</Banner>
      )}

      {positions === null ? (
        <div className="text-xs text-muted py-8 text-center">Loading…</div>
      ) : (
        <>
          <TaxSummaryCard profile={p} hasProfile={!!profile} states={states} />

          {breakdown && ready && <RateBreakdown rates={breakdown} state={state} taxYear={federal.tax_year} show1256={has1256} />}

          {!ready && profile && (
            <Banner tone="amber">Pick your residency in Settings (or enter both CPA rates) to see after-tax figures.</Banner>
          )}

          {ready && table && (
            <TargetTable table={table} selected={Number(p.selected_target_pct)} onSelect={selectTarget} show1256={has1256} />
          )}

          {ready && (
            <section className="mb-5">
              <div className="flex items-center gap-2 mb-2">
                <h2 className="text-sm font-semibold flex-1">Positions</h2>
                {!adding && (
                  <button
                    type="button"
                    onClick={() => setAdding(true)}
                    className="min-h-[44px] px-3 rounded bg-amber-400/10 border border-amber-400/40 text-amber-300 text-sm font-semibold hover:bg-amber-400/20 transition"
                  >
                    <Plus size={14} className="inline -mt-0.5" /> Add LEAPS
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

              {results.length === 0 && !adding && (
                <div className="text-xs text-muted py-6 px-4 text-center border border-dashed border-border rounded-xl">
                  No LEAPS tracked yet. Add a position to generate its exit targets.
                </div>
              )}

              {results.map(({ pos, calc, ladder, ladderLongTerm, custom, customLongTerm }) => (
                <PositionCard
                  key={pos.id}
                  pos={pos}
                  calc={calc}
                  ladder={ladder}
                  ladderLongTerm={ladderLongTerm}
                  custom={custom}
                  customLongTerm={customLongTerm}
                  previewFor={(f, own) => previewTargets(f, own, ladderFor, customFor)}
                  selectedTargetPct={Number(p.selected_target_pct)}
                  onSave={(row) => savePosition(row, pos.id)}
                  onExercise={(args) => exercisePosition(pos, args)}
                  onDelete={() => deletePosition(pos.id)}
                />
              ))}

              {summary && <PortfolioTotals summary={summary} count={results.length} />}
            </section>
          )}

          <p className="text-[10px] text-muted leading-relaxed">
            All tax figures are estimates using combined marginal rates
            {federal ? ` from ${federal.tax_year} federal and state figures` : ''}.
            Actual taxes depend on your full tax situation (deductions,
            other gains and losses, AMT, credits, local taxes). Consult a
            tax professional before acting on these numbers.
          </p>
        </>
      )}
    </div>
  )
}

// ── LEAPS bot risk profile ────────────────────────────────────────
//
// Written by the LDP engine (service role) — the tier gates what the bot
// may buy and whether it auto-trades, so users can't edit it here. The
// copy in `display` is rendered by the engine (ldp.risk.describe) so the
// thresholds it quotes stay in engine config.

const TIER_TONE = {
  conservative: 'bg-sky-500/15 text-sky-300 border-sky-500/40',
  moderate: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  aggressive: 'bg-rose-500/15 text-rose-300 border-rose-500/40',
}

function RiskProfileCard({ userId }) {
  const [row, setRow] = useState(undefined)   // undefined = loading, null = none
  useEffect(() => {
    if (!userId) return
    let cancelled = false
    supabase.from('ldp_risk_profiles')
      .select('tier, capped_by, account_tier, display, computed_at')
      .eq('user_id', userId).maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) console.error('[leaps] risk profile load failed', error)
        setRow(data ?? null)
      })
    return () => { cancelled = true }
  }, [userId])

  if (row === undefined) return null
  if (row === null) {
    return (
      <div className="bg-card border border-border rounded-xl px-4 py-3 mb-4 text-xs text-subtle flex items-start gap-2">
        <ShieldCheck size={14} className="shrink-0 mt-0.5 text-muted" />
        <span className="flex-1">Your LEAPS bot risk profile hasn't been set up yet. Until it is, the bot won't buy anything for you.</span>
        <Link to="/leaps/onboarding"
          className="shrink-0 min-h-[44px] px-3 inline-flex items-center rounded bg-amber-400/10 border border-amber-400/40 text-amber-300 font-semibold hover:bg-amber-400/20 transition">
          Set up
        </Link>
      </div>
    )
  }
  const d = row.display ?? {}
  const label = d.label ?? row.tier.charAt(0).toUpperCase() + row.tier.slice(1)
  return (
    <div className="bg-card border border-border rounded-xl p-4 mb-4">
      <div className="flex items-center gap-2 mb-2">
        <ShieldCheck size={14} className="text-amber-400" />
        <h2 className="text-sm font-semibold flex-1">LEAPS bot risk profile</h2>
        <span className={clsx('text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border font-semibold', TIER_TONE[row.tier])}>
          {label}
        </span>
      </div>
      {d.capped_by_text && <p className="text-xs text-subtle mb-1">{d.capped_by_text}</p>}
      {d.allows && <p className="text-xs text-fg leading-relaxed">{d.allows}</p>}
      <div className="flex items-center gap-2 mt-2">
        <p className="text-[10px] text-muted flex-1">
          {d.account_text ?? (row.account_tier === 'managed' ? 'Managed account.' : 'Self-directed account — suggestions only.')}
        </p>
      </div>
    </div>
  )
}

// ── Profile ───────────────────────────────────────────────────────

// Read-only: the tax profile and goals are edited in /settings.
function TaxSummaryCard({ profile, hasProfile, states }) {
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
  const basis = Number(profile.portfolio_size) * Number(profile.leaps_allocation_pct)
  const status = FILING_STATUSES.find((x) => x.value === profile.filing_status)?.label
  const stateName = states.find((x) => x.state_code === profile.state_code)?.state_name ?? profile.state_code ?? '—'
  return (
    <div className="bg-card border border-border rounded-xl p-4 mb-4">
      <div className="flex items-start gap-2">
        <div className="flex-1 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <Stat label="Portfolio" value={usd(Number(profile.portfolio_size))} />
          <Stat label={`LEAPS basis (${pct(Number(profile.leaps_allocation_pct), 0)})`} value={usd(basis)} />
          <Stat label="Filing status" value={status} />
          <Stat label="Income before LEAPS" value={usd(Number(profile.annual_income))} />
          <Stat label="Residency" value={stateName} />
        </div>
      </div>
    </div>
  )
}

// ── Rate breakdown ────────────────────────────────────────────────

function RateBreakdown({ rates, state, taxYear, show1256 }) {
  const rows = [
    ['Long-term (held > 1 yr)', rates.long_term],
    ['Short-term', rates.short_term],
  ]
  const blend = blended1256Rate(rates)
  return (
    <div className="bg-card border border-border rounded-xl p-4 mb-4">
      <div className="flex items-center gap-2 mb-2">
        <h2 className="text-sm font-semibold flex-1">Your estimated tax rates</h2>
        <span className="text-[10px] text-muted">{taxYear}</span>
      </div>
      <div className="space-y-2">
        {rows.map(([label, r]) => (
          <div key={label} className="text-xs">
            <div className="flex items-baseline gap-2">
              <span className="text-subtle flex-1">{label}</span>
              <span className="font-mono-tab text-fg font-semibold">{ratePct(r.total)}</span>
            </div>
            <div className="text-[10px] text-muted font-mono-tab">
              {r.overridden
                ? 'CPA-provided rate (override)'
                : `${ratePct(r.federal)} federal + ${ratePct(r.niit)} NIIT + ${ratePct(r.state)} ${state?.state_code ?? 'state'} = ${ratePct(r.total)}`}
            </div>
          </div>
        ))}
        {show1256 && (
          <div className="text-xs">
            <div className="flex items-baseline gap-2">
              <span className="text-subtle flex-1">Index options (§1256)</span>
              <span className="font-mono-tab text-fg font-semibold">{ratePct(blend)}</span>
            </div>
            <div className="text-[10px] text-muted font-mono-tab">
              60% × {ratePct(rates.long_term.total)} + 40% × {ratePct(rates.short_term.total)} = {ratePct(blend)} · any holding period
            </div>
          </div>
        )}
      </div>
      <p className="mt-2 text-[10px] text-muted leading-relaxed">
        Brackets use your income plus your current unrealized LEAPS gain,
        so these update as position values change. The state part is the
        effective rate on the gain (after any capital-gains exclusion or
        threshold). Each target row below uses the rate at that target's gain.
        {rates.federal_exempt && ' As a bona fide Puerto Rico resident, gains on appreciation after your move are excluded from federal tax; appreciation from before the move is still federally taxable.'}
        {state?.confidence === 'low' && ' These residency figures are flagged for review — consider entering a CPA rate.'}
      </p>
    </div>
  )
}

// ── Target table ──────────────────────────────────────────────────

function TargetTable({ table, selected, onSelect, show1256 }) {
  return (
    <section className="bg-card border border-border rounded-xl p-4 mb-4">
      <h2 className="text-sm font-semibold mb-1">After-tax targets</h2>
      <p className="text-[10px] text-muted mb-3">
        Multiple your {usd(table.basis)} LEAPS basis must reach to keep each
        after-tax goal. Tap a row to track progress toward it.
        {show1256 && ' §1256 = index options taxed 60/40 regardless of holding period.'}
      </p>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] uppercase tracking-wider text-muted">
            <th className="text-left font-medium pb-2">Target</th>
            <th className="text-right font-medium pb-2">After-tax</th>
            <th className="text-right font-medium pb-2">Long-term</th>
            <th className="text-right font-medium pb-2">Short-term</th>
            {show1256 && <th className="text-right font-medium pb-2">§1256</th>}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => (
            <tr
              key={row.target_pct}
              onClick={() => onSelect(row.target_pct)}
              className={clsx(
                'cursor-pointer border-t border-hairline',
                row.target_pct === selected ? 'text-amber-300 bg-amber-400/5' : 'hover:bg-card-hover',
              )}
            >
              <td className="py-3 font-mono-tab">{pct(row.target_pct, 0)}</td>
              <td className="py-3 text-right font-mono-tab">{usd(row.after_tax_target)}</td>
              <td className="py-3 text-right font-mono-tab font-semibold">{mult(row.long_term.required_multiple)}</td>
              <td className="py-3 text-right font-mono-tab">{mult(row.short_term.required_multiple)}</td>
              {show1256 && <td className="py-3 text-right font-mono-tab">{mult(row.section_1256.required_multiple)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

// ── Positions ─────────────────────────────────────────────────────

const inputCls = 'w-full min-h-[44px] bg-bg border border-border rounded-lg px-3 py-2 text-sm text-fg font-mono-tab placeholder:text-muted focus:outline-none focus:border-amber-400/60 focus:ring-1 focus:ring-amber-400/30 transition-colors'
// iOS renders empty date inputs short and centered — pin height + alignment.
const dateCls = `${inputCls} appearance-none text-left [&::-webkit-date-and-time-value]:text-left [&::-webkit-calendar-picker-indicator]:opacity-60`

// Form rows hold what the user typed: % values and sell shares as
// percents ("100" = +100%), $ values as dollars.
const targetToRow = (t) => ({
  kind: t.kind,
  value: t.kind === 'pct' ? String(+(Number(t.value) * 100).toFixed(2)) : String(t.value),
  sell: String(+(Number(t.sell) * 100).toFixed(2)),
})
const rowToTarget = (r) => ({
  kind: r.kind,
  value: r.kind === 'pct' ? (num(r.value) ?? NaN) / 100 : (num(r.value) ?? NaN),
  sell: (num(r.sell) ?? NaN) / 100,
})
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
const usdExact = (n) => (Number.isFinite(n)
  ? `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
  : '—')

function emptyForm(initial) {
  const own = Array.isArray(initial?.exit_targets) && initial.exit_targets.length > 0
  const str = (v) => (v == null ? '' : String(v))
  return {
    asset: initial?.instrument_type === 'stock' ? 'shares' : 'option',
    is1256: initial?.instrument_type === 'index_option_1256',
    ticker: initial?.ticker ?? '',
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
    targets: own ? initial.exit_targets.map(targetToRow) : DEFAULT_OWN_ROWS,
  }
}

// Units the per-share prices multiply by: shares, or contracts × 100.
function unitsOf(f) {
  if (f.asset === 'shares') return num(f.shares)
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
  const [f, setF] = useState(() => emptyForm(initial))
  const [error, setError] = useState('')
  const [savedNote, setSavedNote] = useState('')
  const [saving, setSaving] = useState(false)
  // Pre-tick §1256 for index roots (SPX, XSP, NDX …) until the user
  // sets it themselves.
  const [typeTouched, setTypeTouched] = useState(!!initial)
  const setV = (k) => (v) => { setError(''); setF((x) => ({ ...x, [k]: v })) }
  const setTicker = (e) => {
    const v = e.target.value.toUpperCase().replace(/[^A-Z.]/g, '')
    setError('')
    setF((x) => ({ ...x, ticker: v, ...(!typeTouched && { is1256: suggestInstrumentType(v) === 'index_option_1256' }) }))
  }
  const isShares = f.asset === 'shares'
  const instrumentType = isShares ? 'stock' : f.is1256 ? 'index_option_1256' : 'equity_option'
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

  async function submit({ keepOpen = false } = {}) {
    if (!/^[A-Z.]{1,10}$/.test(f.ticker)) return setError('Enter a ticker.')
    if (isShares && !(num(f.shares) > 0)) return setError('Enter how many shares you own.')
    if (!isShares && f.price_mode === 'per_share' && !(num(f.contracts) > 0)) return setError('Enter how many contracts you own.')
    if (!isShares && f.contracts !== '' && !Number.isInteger(num(f.contracts))) return setError('Contracts must be a whole number.')
    if (!f.purchase_date) return setError('Enter the purchase date.')
    if (f.purchase_date > todayYmd()) return setError('Purchase date can’t be in the future.')
    if (!(basis > 0)) return setError(f.price_mode === 'per_share' ? 'Enter what you paid per share.' : 'Total cost must be greater than $0.')
    if (value == null || value < 0) return setError(f.price_mode === 'per_share' ? 'Enter the current price per share.' : 'Enter the current value (0 or more).')
    let exitTargets = null
    if (f.own_targets) {
      exitTargets = f.targets.map(rowToTarget)
      const bad = validateCustomTargets(exitTargets, basis)
      if (bad) return setError(bad)
    }
    setSaving(true)
    const err = await onSave({
      ticker: f.ticker,
      instrument_type: instrumentType,
      option_type: isShares ? null : f.option_type,
      strike: isShares ? null : num(f.strike),
      expiration: isShares ? null : f.expiration || null,
      contracts: isShares ? null : num(f.contracts),
      shares: isShares ? num(f.shares) : null,
      cost_basis: exact(basis),
      current_value: exact(value),
      value_as_of: new Date().toISOString(),
      purchase_date: f.purchase_date,
      exit_targets: exitTargets,
    }, { keepOpen })
    setSaving(false)
    setError(err ?? '')
    if (!err && keepOpen) {
      setSavedNote(`${f.ticker} saved — add the next one.`)
      setF((x) => ({ ...emptyForm(null), asset: x.asset, price_mode: x.price_mode }))
      setTypeTouched(false)
    }
  }

  const setRow = (i, k, v) => { setError(''); setF((x) => ({ ...x, targets: x.targets.map((r, j) => (j === i ? { ...r, [k]: v } : r)) })) }
  const addRow = () => setF((x) => {
    const used = x.targets.reduce((sum, r) => sum + (num(r.sell) ?? 0), 0)
    const last = x.targets[x.targets.length - 1]
    const next = last?.kind === 'usd'
      ? { kind: 'usd', value: '', sell: '' }
      : { kind: 'pct', value: last ? String((num(last.value) ?? 0) + 100) : '100', sell: '' }
    next.sell = String(Math.max(0, +(100 - used).toFixed(2)) || '')
    return { ...x, targets: [...x.targets, next] }
  })
  const removeRow = (i) => setF((x) => ({ ...x, targets: x.targets.filter((_, j) => j !== i) }))
  const previewRows = preview
    ? preview({ ...f, instrument_type: instrumentType, cost_basis: basis, current_value: value ?? basis },
      f.own_targets ? f.targets.map(rowToTarget) : null)
    : null
  const perShare = f.price_mode === 'per_share'
  const gainPct = basis > 0 && value != null ? value / basis - 1 : null

  return (
    <div className="bg-card border border-amber-400/40 rounded-xl p-4 mb-3">
      <div className="flex items-center mb-3">
        <h3 className="text-sm font-semibold flex-1">{initial ? `Edit ${initial.ticker}` : 'Add a position'}</h3>
        <button type="button" onClick={onCancel} aria-label="Close"
          className="-mr-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded text-subtle hover:text-fg">
          <X size={16} />
        </button>
      </div>

      <Segmented
        label="What do you own?"
        value={f.asset}
        onChange={(v) => { setError(''); setF((x) => ({ ...x, asset: v })) }}
        options={[{ value: 'option', label: 'Options' }, { value: 'shares', label: 'Shares' }]}
      />

      <FormSection title={isShares ? 'Shares' : 'Contract'}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Ticker">
            <input value={f.ticker} onChange={setTicker} maxLength={10} placeholder={isShares ? 'AAPL' : 'XLK'}
              autoCapitalize="characters" autoComplete="off" spellCheck={false} className={inputCls} />
          </Field>
          {isShares ? (
            <Field label="Shares">
              <NumberInput decimals={4} value={f.shares} onChange={setV('shares')} placeholder="100" className={inputCls} />
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
              <Field label="Expiration" hint="optional">
                <input type="date" value={f.expiration} onChange={(e) => setV('expiration')(e.target.value)} className={dateCls} />
              </Field>
            </>
          )}
          <Field label="Purchase date" wide={isShares}>
            <input type="date" value={f.purchase_date} max={todayYmd()} onChange={(e) => setV('purchase_date')(e.target.value)} className={dateCls} />
          </Field>
        </div>
        {!isShares && (
          <label className="mt-3 flex items-start gap-3 min-h-[44px] cursor-pointer">
            <span className="relative mt-0.5 h-5 w-5 shrink-0">
              <input type="checkbox" checked={f.is1256}
                onChange={(e) => { setTypeTouched(true); setV('is1256')(e.target.checked) }}
                className="peer appearance-none h-5 w-5 rounded-md border border-border bg-bg checked:bg-amber-400 checked:border-amber-400 focus-visible:ring-2 focus-visible:ring-amber-400/40 transition cursor-pointer" />
              <Check size={14} strokeWidth={3} className="pointer-events-none absolute inset-0 m-auto text-bg opacity-0 peer-checked:opacity-100" />
            </span>
            <span className="text-xs leading-relaxed">
              <span className="text-fg">Index option (§1256)</span>
              <span className="block text-[10px] text-muted">
                SPX, XSP, NDX, RUT, VIX… taxed 60% long-term / 40% short-term at any holding period and marked to market at year-end. Not SPY or QQQ.
              </span>
            </span>
          </label>
        )}
      </FormSection>

      <FormSection title="Cost & value" aside={
        <Segmented compact value={f.price_mode} onChange={setPriceMode}
          options={[{ value: 'per_share', label: 'Per share' }, { value: 'total', label: 'Total' }]} />
      }>
        <div className="grid grid-cols-2 gap-3">
          {perShare ? (
            <>
              <Field label={isShares ? 'Paid per share' : 'Premium paid'}>
                <Affix prefix="$"><NumberInput decimals={PRICE_DECIMALS} value={f.cost_each} onChange={setV('cost_each')} placeholder={isShares ? '180.00' : '12.50'} className={clsx(inputCls, 'pl-7')} /></Affix>
              </Field>
              <Field label={isShares ? 'Price now' : 'Premium now'}>
                <Affix prefix="$"><NumberInput decimals={PRICE_DECIMALS} value={f.price_each} onChange={setV('price_each')} placeholder={isShares ? '210.00' : '18.00'} className={clsx(inputCls, 'pl-7')} /></Affix>
              </Field>
            </>
          ) : (
            <>
              <Field label="Total cost">
                <Affix prefix="$"><NumberInput decimals={PRICE_DECIMALS} value={f.cost_basis} onChange={setV('cost_basis')} placeholder="10,000" className={clsx(inputCls, 'pl-7')} /></Affix>
              </Field>
              <Field label="Value now">
                <Affix prefix="$"><NumberInput decimals={PRICE_DECIMALS} value={f.current_value} onChange={setV('current_value')} placeholder="12,500" className={clsx(inputCls, 'pl-7')} /></Affix>
              </Field>
            </>
          )}
        </div>
        {perShare && !isShares && (
          <p className="mt-2 text-[10px] text-muted leading-relaxed">
            Per-share premium, as your broker shows it. Total = premium × 100 × contracts.
          </p>
        )}
        {(basis > 0 || value != null) && (
          <div className="mt-3 grid grid-cols-3 gap-2 rounded-lg bg-bg/40 border border-hairline px-3 py-2 text-xs">
            <Stat label="Total cost" value={usdExact(basis)} />
            <Stat label="Value now" value={usdExact(value)} />
            <div className="min-w-0 text-right">
              <div className="text-[10px] text-muted">Gain</div>
              <div className={clsx('font-mono-tab text-xs truncate', gainPct == null ? 'text-fg' : gainPct >= 0 ? 'text-green-400' : 'text-rose-300')}>
                {gainPct == null ? '—' : `${gainPct >= 0 ? '+' : ''}${pct(gainPct)}`}
              </div>
            </div>
          </div>
        )}
      </FormSection>

      <FormSection title="Exit Targets">
        <TargetsEditor
          own={f.own_targets}
          rows={f.targets}
          contracts={isShares ? null : (Number.parseInt(f.contracts, 10) || null)}
          onOwn={(v) => setF((x) => ({ ...x, own_targets: v }))}
          onRow={setRow}
          onAdd={addRow}
          onRemove={removeRow}
        />
        {previewRows && previewRows.length > 0 && (f.own_targets
          ? <CustomTargetsPreview rows={previewRows} isStock={isShares} />
          : <LadderPreview rungs={previewRows} />)}
      </FormSection>

      {error && (
        <div role="alert" className="mt-4 rounded-lg border border-rose-500/40 bg-rose-500/5 px-3 py-2 text-xs text-rose-200">{error}</div>
      )}
      {!error && savedNote && (
        <div role="status" className="mt-4 rounded-lg border border-green-500/30 bg-green-500/5 px-3 py-2 text-xs text-green-300">{savedNote}</div>
      )}

      <div className="mt-4 space-y-2">
        <button type="button" disabled={saving} onClick={() => submit()}
          className="tap-spring w-full min-h-[48px] rounded-lg bg-amber-400 hover:bg-amber-300 text-bg text-sm font-semibold transition disabled:opacity-50">
          {saving ? 'Saving…' : initial ? 'Save changes' : 'Save position'}
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

function FormSection({ title, aside, children }) {
  return (
    <section className="mt-5 pt-4 border-t border-hairline">
      <div className="flex items-center gap-3 mb-3 min-h-[28px]">
        <h4 className="flex-1 text-[11px] uppercase tracking-wider text-subtle font-semibold">{title}</h4>
        {aside}
      </div>
      {children}
    </section>
  )
}

function Segmented({ label, value, onChange, options, compact }) {
  return (
    <div>
      {label && <div className="text-[11px] text-subtle mb-1.5">{label}</div>}
      <div role="radiogroup" aria-label={label}
        className={clsx('grid rounded-lg border border-border bg-bg p-0.5', compact ? 'gap-0.5' : 'gap-1')}
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
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

// "3 contracts · Bought Jun 2, 2025" — plus "· value Sep 28" only when
// the stored value isn't from today (manual entries go stale).
const shortDate = (ymd, withYear = true) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd ?? ''))
  if (!m) return ''
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(withYear && { year: 'numeric' }), timeZone: 'UTC' })
}

function positionMeta(pos) {
  const parts = []
  const n = Number(pos.contracts)
  if (pos.instrument_type !== 'stock' && n > 0) parts.push(`${n} contract${n === 1 ? '' : 's'}`)
  parts.push(`${pos.exercised_from_id ? 'Exercised' : 'Bought'} ${shortDate(pos.purchase_date)}`)
  if (pos.value_as_of) {
    const asOf = todayYmd(new Date(pos.value_as_of))
    if (asOf !== todayYmd()) parts.push(`value ${shortDate(asOf, asOf.slice(0, 4) !== todayYmd().slice(0, 4))}`)
  }
  return parts.join(' · ')
}

function PositionCard({ pos, calc, ladder, ladderLongTerm, custom, customLongTerm, previewFor, selectedTargetPct, onSave, onDelete, onExercise }) {
  const [editing, setEditing] = useState(false)
  const [exercising, setExercising] = useState(false)
  const [showTaxDetail, setShowTaxDetail] = useState(false)
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
  const isStock = pos.instrument_type === 'stock'
  const label = isStock
    ? `${pos.ticker} · ${Number(pos.shares).toLocaleString()} shares`
    : [pos.ticker, pos.strike && `$${Number(pos.strike).toLocaleString('en-US', { maximumFractionDigits: 2 })}`, pos.option_type === 'P' ? 'Put' : 'Call', pos.expiration]
      .filter(Boolean).join(' ')
  const canExercise = exerciseCall({ option: pos, exerciseDate: todayYmd() }) != null
  const up = calc.gain >= 0
  return (
    <div className="bg-card border border-border rounded-xl p-4 mb-3">
      <div className="flex items-start gap-2 mb-3">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold break-words">{label}</div>
          <div className="text-[10px] text-muted truncate">{positionMeta(pos)}</div>
        </div>
        <span
          className={clsx(
            'text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border font-semibold shrink-0',
            is1256
              ? 'bg-sky-500/15 text-sky-300 border-sky-500/40'
              : calc.is_long_term
                ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                : 'bg-amber-500/15 text-amber-300 border-amber-500/40',
          )}
        >
          {is1256 ? '§1256 · 60/40' : calc.is_long_term ? 'Long-term' : `Short-term · ${calc.days_until_long_term}d to LT`}
        </span>
      </div>
      {pos.notes && <div className="text-[10px] text-subtle -mt-2 mb-3">{pos.notes}</div>}

      <div className="mb-3">
        <div className="text-[10px] uppercase tracking-wider text-muted">After-tax value if sold today</div>
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
        {showTaxDetail && (
          <div className="text-[10px] text-muted font-mono-tab">
            {calc.gain > 0
              ? `${usd(calc.after_tax_gain)} after-tax gain · est. tax ${usd(calc.estimated_tax)} at ${ratePct(calc.tax_rate)}`
              : 'Loss — no tax on sale'}
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2 text-xs mb-3">
        <Stat label="Current value" value={usd(calc.current_value)} />
        <Stat label="Basis" value={usd(calc.basis)} />
        <Stat label="Multiple" value={mult(calc.current_multiple)} />
      </div>

      {calc.tax_saved_by_waiting != null && (
        <div className="rounded border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-200 mb-3">
          Waiting until {calc.long_term_date} ({calc.days_until_long_term} days) would save about{' '}
          <span className="font-semibold font-mono-tab">{usd(calc.tax_saved_by_waiting)}</span> in tax at today's value.
        </div>
      )}

      {custom?.length > 0 ? (
        <CustomExitTargets rows={custom} rowsLongTerm={customLongTerm} character={calc.tax_character}
          longTermDate={calc.long_term_date} isStock={isStock} />
      ) : (
        <ExitLadder ladder={ladder} ladderLongTerm={ladderLongTerm} character={calc.tax_character}
          longTermDate={calc.long_term_date} isStock={isStock} />
      )}

      {calc.target_progress != null && (
        <div className="mb-3">
          <div className="flex text-[10px] text-muted mb-1">
            <span className="flex-1">Progress to {pct(selectedTargetPct, 0)} after-tax target</span>
            <span className="font-mono-tab">{mult(calc.current_multiple)} / {mult(calc.target_multiple)} {is1256 ? '60/40' : 'LT'}</span>
          </div>
          <div className="h-1.5 rounded bg-faint overflow-hidden">
            <div className="h-full bg-amber-400" style={{ width: `${calc.target_progress * 100}%` }} />
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
  )
}

// ── After-tax exit ladder ─────────────────────────────────────────

const CHARACTER_LABEL = {
  long_term: 'long-term rate',
  short_term: 'short-term rate',
  section_1256: '§1256 60/40 rate',
}

const fractionLabel = (f) => {
  const known = { [1 / 2]: 'half', [1 / 3]: 'a third', [1 / 4]: 'a quarter' }
  for (const [k, v] of Object.entries(known)) if (Math.abs(f - Number(k)) < 1e-6) return v
  return pct(f, 0)
}

const sellLabel = (r, isStock) => {
  if (r.contracts == null) return `sell ${fractionLabel(r.fraction)}`
  if (r.contracts === 0) return 'nothing to sell (too few contracts)'
  return `sell ${r.contracts} ${isStock ? 'lot' : 'contract'}${r.contracts === 1 ? '' : 's'}`
}

function ExitLadder({ ladder, ladderLongTerm, character, longTermDate, isStock }) {
  if (!ladder?.length) return null
  return (
    <div className="mb-3 rounded-lg border border-border bg-bg/40 p-3">
      <div className="flex items-baseline gap-2 mb-2">
        <div className="text-xs font-semibold flex-1">Exit Targets</div>
        <div className="text-[10px] text-muted">at {CHARACTER_LABEL[character]} if sold today</div>
      </div>
      <ol className="space-y-2.5">
        {ladder.map((r, i) => (
          <li key={r.index} className="text-xs">
            <div className="flex items-baseline gap-2">
              <span className="text-subtle w-14 shrink-0">Rung {i + 1}</span>
              <span className="flex-1 min-w-0">
                <span className="text-fg">+{pct(r.target, 0)} after tax</span>
                <span className="text-muted"> · {sellLabel(r, isStock)}</span>
              </span>
              <span className={clsx('font-mono-tab shrink-0', r.hit ? 'text-green-400 font-semibold' : 'text-fg')}>
                {usd(r.exit_value)} <span className="text-muted">({mult(r.exit_multiple)})</span>
              </span>
            </div>
            <div className="flex items-center gap-2 mt-1 pl-16">
              {r.hit ? (
                <span className="text-[10px] text-green-400 font-semibold">Target reached</span>
              ) : (
                <div className="flex-1 h-1 rounded bg-faint overflow-hidden" aria-label={`${Math.round(r.progress * 100)}% of the way`}>
                  <div className="h-full bg-amber-400" style={{ width: `${r.progress * 100}%` }} />
                </div>
              )}
              {ladderLongTerm?.[i] && (
                <span className="text-[10px] text-muted font-mono-tab shrink-0">
                  LT {usd(ladderLongTerm[i].exit_value)}
                </span>
              )}
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-2 text-[10px] text-muted leading-relaxed">
        Each target is the value at which selling that share of the position leaves the stated gain after tax.
        {ladderLongTerm && longTermDate && ` "LT" is where each target moves once this goes long-term on ${longTermDate}.`}
        {' '}Recalculated as your tax rate and position value change. Estimates.
      </p>
    </div>
  )
}

function LadderPreview({ rungs }) {
  if (!rungs?.length) return null
  return (
    <div className="mt-3 rounded-lg border border-border bg-bg/40 p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted mb-1.5">Sell when the position is worth</div>
      <div className="grid grid-cols-3 gap-2">
        {rungs.map((r, i) => (
          <div key={r.index} className="text-xs">
            <div className="text-muted text-[10px]">+{pct(r.target, 0)} after tax</div>
            <div className="font-mono-tab text-fg">{usd(r.exit_value)}</div>
            <div className="font-mono-tab text-muted text-[10px]">{mult(r.exit_multiple)} · rung {i + 1}</div>
          </div>
        ))}
      </div>
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
  const contracts = f.instrument_type === 'stock' ? null : (Number.parseInt(f.contracts, 10) || null)
  if (own) {
    const usable = own.filter((t) => Number.isFinite(t.value) && t.value > 0 && Number.isFinite(t.sell) && t.sell > 0)
    return customFor(basis, value, character, contracts, usable)
  }
  return ladderFor(basis, value, character, contracts)
}

// ── User-set Exit Targets (% or $) ───────────────────────────────

function TargetsEditor({ own, rows, contracts, onOwn, onRow, onAdd, onRemove }) {
  const sold = rows.reduce((sum, r) => sum + (num(r.sell) ?? 0), 0)
  const over = sold > 100.0001
  return (
    <div>
      <Segmented value={own ? 'own' : 'default'} onChange={(v) => onOwn(v === 'own')}
        options={[{ value: 'default', label: 'My default' }, { value: 'own', label: 'Set my own' }]} />
      {!own ? (
        <p className="mt-2 text-[10px] text-muted leading-relaxed">
          Uses your after-tax Exit Targets from <Link to="/settings#exit-targets" className="text-amber-300 underline underline-offset-2">Settings</Link>.
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
                  <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-2">
                    <Segmented compact value={r.kind} onChange={(k) => onRow(i, 'kind', k)}
                      options={[{ value: 'pct', label: '%' }, { value: 'usd', label: '$' }]} />
                    <Affix prefix={r.kind === 'pct' ? '+' : '$'} suffix={r.kind === 'pct' ? '%' : null}>
                      <NumberInput value={r.value} onChange={(v) => onRow(i, 'value', v)}
                        aria-label={r.kind === 'pct' ? `Target ${i + 1} gain percent` : `Target ${i + 1} position value`}
                        placeholder={r.kind === 'pct' ? '100' : '60,000'}
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
          <p className="mt-1 text-[10px] text-muted leading-relaxed">
            % = gain on what you paid (+100% = double). $ = what the whole position is worth.
          </p>
        </>
      )}
    </div>
  )
}

const targetLabel = (r) => (r.kind === 'pct' ? `+${pct(r.input, Number.isInteger(+(r.input * 100).toFixed(4)) ? 0 : 1)}` : usd(r.input))
// The other half of the target: the $ value for a % target, the % for a $ one.
const targetOther = (r) => (r.kind === 'pct' ? usd(r.exit_value) : `+${pct(r.gain_pct, 0)}`)
const soldLabel = (r, isStock) => {
  if (r.contracts == null) return `sell ${pct(r.fraction, 0)}`
  if (r.contracts === 0) return 'nothing to sell (too few contracts)'
  return `sell ${r.contracts} ${isStock ? 'lot' : 'contract'}${r.contracts === 1 ? '' : 's'}`
}

function CustomTargetsPreview({ rows, isStock }) {
  if (!rows?.length) return null
  const kept = rows.reduce((sum, r) => sum + r.after_tax_proceeds, 0)
  return (
    <div className="mt-3 rounded-lg border border-border bg-bg/40 p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted mb-2">You keep, after tax</div>
      <ol className="space-y-2">
        {rows.map((r) => (
          <li key={r.index} className="flex items-start gap-3 text-xs">
            <div className="flex-1 min-w-0">
              <div className="text-fg">{targetLabel(r)} <span className="text-muted">· {targetOther(r)}</span></div>
              <div className="text-[10px] text-muted">{soldLabel(r, isStock)}{r.estimated_tax > 0 ? ` · ${usd(r.estimated_tax)} tax` : ''}</div>
            </div>
            <span className="font-mono-tab text-green-400 font-semibold shrink-0">{usd(r.after_tax_proceeds)}</span>
          </li>
        ))}
      </ol>
      {rows.length > 1 && (
        <div className="mt-2 pt-2 border-t border-hairline flex items-baseline text-xs">
          <span className="flex-1 text-subtle">Total if every target hits</span>
          <span className="font-mono-tab text-green-400 font-semibold">{usd(kept)}</span>
        </div>
      )}
    </div>
  )
}

function CustomExitTargets({ rows, rowsLongTerm, character, longTermDate, isStock }) {
  if (!rows?.length) return null
  const kept = rows.reduce((sum, r) => sum + r.after_tax_proceeds, 0)
  const soldShare = rows.reduce((sum, r) => sum + r.fraction, 0)
  return (
    <div className="mb-3 rounded-lg border border-border bg-bg/40 p-3">
      <div className="flex items-baseline gap-2 mb-2">
        <div className="text-xs font-semibold flex-1">Exit Targets</div>
        <div className="text-[10px] text-muted">at {CHARACTER_LABEL[character]} if sold today</div>
      </div>
      <ol className="space-y-3">
        {rows.map((r, i) => (
          <li key={r.index} className="text-xs">
            <div className="flex items-baseline gap-2">
              <span className="flex-1 min-w-0">
                <span className="text-fg">{targetLabel(r)}</span>
                <span className="text-muted"> · {targetOther(r)} · {soldLabel(r, isStock)}</span>
              </span>
              <span className={clsx('font-mono-tab shrink-0 font-semibold', r.hit ? 'text-green-400' : 'text-fg')}>
                {usd(r.after_tax_proceeds)}
              </span>
            </div>
            <div className="flex items-center gap-2 mt-0.5 text-[10px] text-muted font-mono-tab">
              <span className="flex-1">
                {r.realized_gain > 0
                  ? `${usd(r.proceeds)} sale − ${usd(r.estimated_tax)} tax (${ratePct(r.rate)}) · ${usd(r.after_tax_gain)} gain kept`
                  : `${usd(r.proceeds)} sale · no gain, no tax`}
              </span>
              {rowsLongTerm?.[i] && <span className="shrink-0">LT {usd(rowsLongTerm[i].after_tax_proceeds)}</span>}
            </div>
            <div className="mt-1">
              {r.hit ? (
                <span className="text-[10px] text-green-400 font-semibold">Target reached</span>
              ) : r.progress != null && (
                <div className="h-1 rounded bg-faint overflow-hidden" aria-label={`${Math.round(r.progress * 100)}% of the way`}>
                  <div className="h-full bg-amber-400" style={{ width: `${r.progress * 100}%` }} />
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-3 pt-2 border-t border-hairline flex items-baseline text-xs">
        <span className="flex-1 text-subtle">
          Kept after tax if every target hits{soldShare < 0.9999 ? ` (${pct(1 - soldShare, 0)} still held)` : ''}
        </span>
        <span className="font-mono-tab text-green-400 font-semibold">{usd(kept)}</span>
      </div>
      <p className="mt-2 text-[10px] text-muted leading-relaxed">
        Dollars are what you'd keep from each sale after estimated tax.
        {rowsLongTerm && longTermDate && ` "LT" is the same sale once this goes long-term on ${longTermDate}.`}
        {' '}Each sale is taxed on its own; selling several in one year can push the rate higher. Estimates.
      </p>
    </div>
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
    <div className="rounded-xl border border-amber-400/40 p-3 mb-3">
      <div className="text-xs font-semibold mb-1">Exercise into stock</div>
      <p className="text-[10px] text-muted leading-relaxed mb-3">
        The premium you paid rolls into the stock's cost basis. The stock
        starts its own holding period from the exercise date — the call's
        holding time does not carry over.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Exercise date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} /></Field>
        <Field label="Shares received"><NumberInput decimals={4} value={shares} onChange={setShares} className={inputCls} /></Field>
        <Field label="Current value of shares ($)" wide><NumberInput value={value} onChange={setValue} className={inputCls} /></Field>
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

function PortfolioTotals({ summary, count }) {
  return (
    <div className="bg-card border border-amber-400/30 rounded-xl p-4">
      <h3 className="text-sm font-semibold mb-3">All LEAPS ({count})</h3>
      <div className="grid grid-cols-3 gap-2 text-xs mb-3">
        <Stat label="After-tax value" value={usd(summary.after_tax_value)} strong />
        <Stat label="After-tax gain" value={usd(summary.after_tax_gain)} />
        <Stat label="Return on portfolio" value={pct(summary.after_tax_return_pct)} />
      </div>
      <div className="flex items-start gap-1.5 text-[10px] text-muted leading-relaxed">
        <Info size={11} className="shrink-0 mt-0.5" />
        <span>
          Totals add each position's after-tax value separately. If gains and
          losses were netted against each other, the estimated after-tax
          value would be <span className="font-mono-tab text-subtle">{usd(summary.netted.after_tax_value)}</span>{' '}
          (estimate — excludes loss carryforwards and the $3k ordinary-income offset).
        </span>
      </div>
    </div>
  )
}

// ── Bits ──────────────────────────────────────────────────────────

function Stat({ label, value, strong }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] text-muted truncate">{label}</div>
      <div className={clsx('font-mono-tab truncate', strong ? 'text-fg font-semibold' : 'text-fg')}>{value ?? '—'}</div>
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
