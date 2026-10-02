import { useCallback, useEffect, useMemo, useState } from 'react'
import { Landmark, Plus, Pencil, Trash2, Check, X, AlertTriangle, Info, ArrowRightLeft, ShieldCheck } from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import {
  FILING_STATUSES, DEFAULT_TARGET_PCTS, makeRateResolver, deriveRates,
  applyRateOverride, targetTable, positionAfterTax, portfolioSummary,
  isValidTaxRate, todayYmd, holdingPeriod, INSTRUMENT_TYPES, suggestInstrumentType, exerciseCall,
  blended1256Rate,
} from '../utils/afterTax'

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
}

const usd = (n) =>
  Number.isFinite(n) ? `${n < 0 ? '−' : ''}$${Math.round(Math.abs(n)).toLocaleString()}` : '—'
const mult = (n) => (Number.isFinite(n) ? `${n.toFixed(2)}x` : '—')
const pct = (n, dp = 1) => (Number.isFinite(n) ? `${(n * 100).toFixed(dp)}%` : '—')
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
  const [editingProfile, setEditingProfile] = useState(false)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    if (!user?.id) return
    let cancelled = false
    ;(async () => {
      try {
        const [fed, prof, pos] = await Promise.all([
          supabase.from('tax_year_config').select('*').eq('is_current', true).maybeSingle(),
          supabase.from('leaps_tax_profiles').select('*').eq('user_id', user.id).maybeSingle(),
          supabase.from('leaps_positions').select('*').eq('user_id', user.id)
            .is('closed_at', null).order('purchase_date', { ascending: true }),
        ])
        if (cancelled) return
        if (fed.error || prof.error || pos.error) {
          console.error('[leaps] load failed', fed.error || prof.error || pos.error)
          setLoadError('Could not load your LEAPS data. Reload the page to try again.')
        }
        setFederal(fed.data ?? null)
        setProfile(prof.data ?? null)
        setPositions(pos.data ?? [])
        if (fed.data) {
          const st = await supabase.from('state_tax_rates').select('*')
            .eq('tax_year', fed.data.tax_year).order('state_name')
          if (!cancelled) setStates(st.data ?? [])
        }
        if (!prof.error && !prof.data) setEditingProfile(true)
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

  const rateForGain = useMemo(() => {
    if (!federal) return null
    return makeRateResolver({ federal, state, filingStatus: p.filing_status, income: Number(p.annual_income) || 0, override })
  }, [federal, state, p.filing_status, p.annual_income, override])

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

  const results = useMemo(() => {
    if (!rateForGain || !positions) return []
    return positions.map((pos) => ({
      pos,
      calc: positionAfterTax({
        basis: Number(pos.cost_basis),
        currentValue: Number(pos.current_value),
        purchaseDate: pos.purchase_date,
        asOf,
        rateForGain,
        instrumentType: pos.instrument_type,
        targetMultiple: pos.instrument_type === 'index_option_1256'
          ? selectedRow?.section_1256.required_multiple
          : selectedRow?.long_term.required_multiple,
      }),
    }))
  }, [positions, rateForGain, asOf, selectedRow])

  const summary = useMemo(() => {
    if (!rateForGain || results.length === 0) return null
    return portfolioSummary(results.map((r) => r.calc), portfolio, rateForGain)
  }, [results, portfolio, rateForGain])

  // Breakdown is shown at the user's current unrealized gain — it moves
  // as position values change (a big gain can cross a bracket or NIIT).
  const totalGain = Math.max(0, results.reduce((s, r) => s + (r.calc?.gain ?? 0), 0))
  const breakdown = useMemo(() => {
    if (!federal) return null
    const derived = deriveRates({ federal, state, filingStatus: p.filing_status, income: Number(p.annual_income) || 0, gain: totalGain })
    return applyRateOverride(derived, override)
  }, [federal, state, p.filing_status, p.annual_income, totalGain, override])

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
          <ProfileCard
            profile={p}
            states={states}
            editing={editingProfile}
            onEdit={() => setEditingProfile(true)}
            onCancel={profile ? () => setEditingProfile(false) : null}
            onSave={async (next) => {
              const err = await saveProfile(next)
              if (!err) setEditingProfile(false)
              return err
            }}
          />

          {breakdown && ready && !editingProfile && <RateBreakdown rates={breakdown} state={state} taxYear={federal.tax_year} show1256={has1256} />}

          {!ready && !editingProfile && (
            <Banner tone="amber">Pick your state (or enter both CPA rates) to see after-tax figures.</Banner>
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
                  onCancel={() => setAdding(false)}
                  onSave={async (row) => {
                    const err = await savePosition(row)
                    if (!err) setAdding(false)
                    return err
                  }}
                />
              )}

              {results.length === 0 && !adding && (
                <div className="text-xs text-muted py-6 text-center border border-dashed border-border rounded-xl">
                  No LEAPS tracked yet.
                </div>
              )}

              {results.map(({ pos, calc }) => (
                <PositionCard
                  key={pos.id}
                  pos={pos}
                  calc={calc}
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
        <span>Your LEAPS bot risk profile hasn't been set up yet. Until it is, the bot won't buy anything for you.</span>
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
      <p className="text-[10px] text-muted mt-2">
        {d.account_text ?? (row.account_tier === 'managed' ? 'Managed account.' : 'Self-directed account — suggestions only.')}
      </p>
    </div>
  )
}

// ── Profile ───────────────────────────────────────────────────────

function ProfileCard({ profile, states, editing, onEdit, onCancel, onSave }) {
  const [form, setForm] = useState(() => toForm(profile))
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => { if (editing) setForm(toForm(profile)) }, [editing, profile])

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  async function submit() {
    const portfolio = num(form.portfolio_size)
    const alloc = num(form.leaps_allocation_pct)
    const income = num(form.annual_income) ?? 0
    const targets = form.target_pcts.split(',').map((s) => num(s)).filter((n) => n != null && n > 0)
    const lt = num(form.lt_rate_override)
    const st = num(form.st_rate_override)
    if (!(portfolio > 0)) return setError('Portfolio size must be greater than $0.')
    if (!(alloc > 0 && alloc <= 100)) return setError('LEAPS allocation must be between 0% and 100%.')
    if (income < 0) return setError('Income cannot be negative.')
    if (targets.length === 0) return setError('Enter at least one target return %.')
    if (lt != null && !isValidTaxRate(lt / 100)) return setError('Long-term override must be between 0% and 99%.')
    if (st != null && !isValidTaxRate(st / 100)) return setError('Short-term override must be between 0% and 99%.')
    const targetPcts = [...new Set(targets.map((t) => t / 100))].sort((a, b) => b - a)
    const prevSel = Number(profile.selected_target_pct)
    setSaving(true)
    const err = await onSave({
      portfolio_size: portfolio,
      leaps_allocation_pct: alloc / 100,
      filing_status: form.filing_status,
      annual_income: income,
      state_code: form.state_code || null,
      target_pcts: targetPcts,
      selected_target_pct: targetPcts.includes(prevSel) ? prevSel : targetPcts[0],
      lt_rate_override: lt == null ? null : lt / 100,
      st_rate_override: st == null ? null : st / 100,
    })
    setSaving(false)
    setError(err ?? '')
  }

  if (!editing) {
    const basis = Number(profile.portfolio_size) * Number(profile.leaps_allocation_pct)
    const status = FILING_STATUSES.find((s) => s.value === profile.filing_status)?.label
    const stateName = states.find((s) => s.state_code === profile.state_code)?.state_name ?? profile.state_code ?? '—'
    return (
      <div className="bg-card border border-border rounded-xl p-4 mb-4">
        <div className="flex items-start gap-2">
          <div className="flex-1 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            <Stat label="Portfolio" value={usd(Number(profile.portfolio_size))} />
            <Stat label={`LEAPS basis (${pct(Number(profile.leaps_allocation_pct), 0)})`} value={usd(basis)} />
            <Stat label="Filing status" value={status} />
            <Stat label="Income before LEAPS" value={usd(Number(profile.annual_income))} />
            <Stat label="State" value={stateName} />
          </div>
          <button
            type="button"
            onClick={onEdit}
            aria-label="Edit tax profile"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded border border-border text-subtle hover:text-fg hover:border-amber-400/40 transition"
          >
            <Pencil size={14} />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-card border border-amber-400/40 rounded-xl p-4 mb-4">
      <h2 className="text-sm font-semibold mb-3">Your tax profile</h2>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Portfolio size ($)">
          <input inputMode="decimal" value={form.portfolio_size} onChange={set('portfolio_size')} className={inputCls} />
        </Field>
        <Field label="LEAPS allocation (%)">
          <input inputMode="decimal" value={form.leaps_allocation_pct} onChange={set('leaps_allocation_pct')} className={inputCls} />
        </Field>
        <Field label="Filing status">
          <select value={form.filing_status} onChange={set('filing_status')} className={inputCls}>
            {FILING_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </Field>
        <Field label="State of residence">
          <select value={form.state_code} onChange={set('state_code')} className={inputCls}>
            <option value="">Select…</option>
            {states.map((s) => <option key={s.state_code} value={s.state_code}>{s.state_name}</option>)}
          </select>
        </Field>
        <Field label="Annual taxable income before LEAPS gains ($)" wide>
          <input inputMode="decimal" value={form.annual_income} onChange={set('annual_income')} className={inputCls} />
        </Field>
        <Field label="Target after-tax returns (% of portfolio, comma-separated)" wide>
          <input value={form.target_pcts} onChange={set('target_pcts')} className={inputCls} />
        </Field>
        <Field label="CPA long-term rate (%, optional)">
          <input inputMode="decimal" value={form.lt_rate_override} onChange={set('lt_rate_override')} placeholder="Derived" className={inputCls} />
        </Field>
        <Field label="CPA short-term rate (%, optional)">
          <input inputMode="decimal" value={form.st_rate_override} onChange={set('st_rate_override')} placeholder="Derived" className={inputCls} />
        </Field>
      </div>
      {error && <div className="mt-3 text-xs text-rose-300">{error}</div>}
      <div className="mt-4 flex gap-2 justify-end">
        {onCancel && (
          <button type="button" onClick={onCancel} className="min-h-[44px] px-4 rounded border border-border text-sm text-subtle hover:text-fg">
            Cancel
          </button>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={saving}
          className="min-h-[44px] px-4 rounded bg-amber-400/10 border border-amber-400/40 text-amber-300 text-sm font-semibold hover:bg-amber-400/20 transition disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

function toForm(p) {
  const pctStr = (x) => (x == null ? '' : String(+(Number(x) * 100).toFixed(4)))
  return {
    portfolio_size: String(p.portfolio_size ?? ''),
    leaps_allocation_pct: pctStr(p.leaps_allocation_pct),
    filing_status: p.filing_status ?? 'single',
    annual_income: String(p.annual_income ?? 0),
    state_code: p.state_code ?? '',
    target_pcts: (p.target_pcts ?? DEFAULT_TARGET_PCTS).map((t) => pctStr(t)).join(', '),
    lt_rate_override: pctStr(p.lt_rate_override),
    st_rate_override: pctStr(p.st_rate_override),
  }
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
        {state?.confidence === 'low' && ' Your state’s figures are flagged for review — consider entering a CPA rate.'}
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

const inputCls = 'w-full min-h-[44px] bg-bg border border-border rounded px-3 py-2 text-sm font-mono-tab focus:outline-none focus:ring-1 focus:ring-amber-400/40'

function PositionForm({ initial, onSave, onCancel }) {
  const [f, setF] = useState(() => ({
    ticker: initial?.ticker ?? '',
    instrument_type: initial?.instrument_type ?? 'equity_option',
    shares: initial?.shares ?? '',
    option_type: initial?.option_type ?? 'C',
    strike: initial?.strike ?? '',
    expiration: initial?.expiration ?? '',
    contracts: initial?.contracts ?? '',
    cost_basis: initial?.cost_basis ?? '',
    current_value: initial?.current_value ?? '',
    purchase_date: initial?.purchase_date ?? '',
  }))
  const [error, setError] = useState('')
  // Pre-select §1256 for index roots (SPX, XSP, NDX …) until the user
  // picks a type themselves.
  const [typeTouched, setTypeTouched] = useState(!!initial)
  const set = (k) => (e) => setF((x) => {
    const v = k === 'ticker' ? e.target.value.toUpperCase() : e.target.value
    const next = { ...x, [k]: v }
    if (k === 'ticker' && !typeTouched && x.instrument_type !== 'stock') next.instrument_type = suggestInstrumentType(v)
    return next
  })
  const isStock = f.instrument_type === 'stock'

  async function submit() {
    const basis = num(f.cost_basis)
    const value = num(f.current_value)
    if (!/^[A-Z.]{1,10}$/.test(f.ticker)) return setError('Enter a ticker.')
    if (!(basis > 0)) return setError('Cost basis must be greater than $0.')
    if (value == null || value < 0) return setError('Enter the current value (0 or more).')
    if (!f.purchase_date) return setError('Enter the purchase date.')
    if (f.purchase_date > todayYmd()) return setError('Purchase date can’t be in the future.')
    if (isStock && !(num(f.shares) > 0)) return setError('Enter the number of shares.')
    const err = await onSave({
      ticker: f.ticker,
      instrument_type: f.instrument_type,
      option_type: isStock ? null : f.option_type,
      strike: isStock ? null : num(f.strike),
      expiration: isStock ? null : f.expiration || null,
      contracts: isStock ? null : num(f.contracts),
      shares: isStock ? num(f.shares) : null,
      cost_basis: basis,
      current_value: value,
      value_as_of: new Date().toISOString(),
      purchase_date: f.purchase_date,
    })
    setError(err ?? '')
  }

  return (
    <div className="bg-card border border-amber-400/40 rounded-xl p-4 mb-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Ticker"><input value={f.ticker} onChange={set('ticker')} maxLength={10} className={inputCls} /></Field>
        <Field label="Instrument">
          <select
            value={f.instrument_type}
            onChange={(e) => { setTypeTouched(true); set('instrument_type')(e) }}
            className={inputCls}
          >
            {INSTRUMENT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </Field>
        {isStock ? (
          <Field label="Shares"><input inputMode="decimal" value={f.shares} onChange={set('shares')} className={inputCls} /></Field>
        ) : (
          <>
            <Field label="Call / put">
              <select value={f.option_type} onChange={set('option_type')} className={inputCls}>
                <option value="C">Call</option>
                <option value="P">Put</option>
              </select>
            </Field>
            <Field label="Strike (needed to exercise)"><input inputMode="decimal" value={f.strike} onChange={set('strike')} className={inputCls} /></Field>
            <Field label="Expiration (optional)"><input type="date" value={f.expiration} onChange={set('expiration')} className={inputCls} /></Field>
            <Field label="Contracts (needed to exercise)"><input inputMode="numeric" value={f.contracts} onChange={set('contracts')} className={inputCls} /></Field>
          </>
        )}
        <Field label="Purchase date"><input type="date" value={f.purchase_date} onChange={set('purchase_date')} className={inputCls} /></Field>
        <Field label="Total cost basis ($)"><input inputMode="decimal" value={f.cost_basis} onChange={set('cost_basis')} className={inputCls} /></Field>
        <Field label="Current value ($)"><input inputMode="decimal" value={f.current_value} onChange={set('current_value')} className={inputCls} /></Field>
      </div>
      {f.instrument_type === 'index_option_1256' && (
        <p className="mt-3 text-[10px] text-muted leading-relaxed">
          §1256 contracts are taxed 60% long-term / 40% short-term however long
          you hold them, and open positions are marked to market at year-end
          (taxed as if sold on Dec 31). ETF options like SPY and QQQ are not §1256.
        </p>
      )}
      {error && <div className="mt-3 text-xs text-rose-300">{error}</div>}
      <div className="mt-4 flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className="min-h-[44px] px-4 rounded border border-border text-sm text-subtle hover:text-fg">
          <X size={14} className="inline -mt-0.5" /> Cancel
        </button>
        <button type="button" onClick={submit} className="min-h-[44px] px-4 rounded bg-amber-400/10 border border-amber-400/40 text-amber-300 text-sm font-semibold hover:bg-amber-400/20 transition">
          <Check size={14} className="inline -mt-0.5" /> Save
        </button>
      </div>
    </div>
  )
}

function PositionCard({ pos, calc, selectedTargetPct, onSave, onDelete, onExercise }) {
  const [editing, setEditing] = useState(false)
  const [exercising, setExercising] = useState(false)
  if (editing) {
    return (
      <PositionForm
        initial={pos}
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
    : [pos.ticker, pos.strike && `$${Number(pos.strike)}`, pos.option_type === 'P' ? 'Put' : 'Call', pos.expiration]
      .filter(Boolean).join(' ')
  const canExercise = exerciseCall({ option: pos, exerciseDate: todayYmd() }) != null
  const up = calc.gain >= 0
  return (
    <div className="bg-card border border-border rounded-xl p-4 mb-3">
      <div className="flex items-start gap-2 mb-3">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold break-words">{label}</div>
          <div className="text-[10px] text-muted">
            {pos.exercised_from_id ? 'Acquired by exercise' : 'Bought'} {pos.purchase_date}{pos.contracts ? ` · ${pos.contracts} contract${Number(pos.contracts) === 1 ? '' : 's'}` : ''}
            {' · '}value as of {new Date(pos.value_as_of).toLocaleDateString()}
          </div>
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
        <div className={clsx('text-2xl font-semibold font-mono-tab', up ? 'text-green-400' : 'text-rose-300')}>
          {usd(calc.after_tax_value)}
        </div>
        <div className="text-[10px] text-muted font-mono-tab">
          {calc.gain > 0
            ? `${usd(calc.after_tax_gain)} after-tax gain · est. tax ${usd(calc.estimated_tax)} at ${ratePct(calc.tax_rate)}`
            : 'Loss — no tax on sale'}
        </div>
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
        <Field label="Shares received"><input inputMode="decimal" value={shares} onChange={(e) => setShares(e.target.value)} className={inputCls} /></Field>
        <Field label="Current value of shares ($)" wide><input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} className={inputCls} /></Field>
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

function Field({ label, wide, children }) {
  return (
    <label className={clsx('block', wide && 'col-span-2')}>
      <span className="block text-[10px] text-muted mb-1">{label}</span>
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
