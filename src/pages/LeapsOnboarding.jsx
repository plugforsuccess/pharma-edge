import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ShieldCheck, ChevronLeft, ChevronRight, Check, AlertTriangle } from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { FILING_STATUSES } from '../utils/afterTax'
import { LDP_DISCLOSURES_VERSION, DISCLOSURES, TOLERANCES, EXPERIENCE } from '../lib/ldpDisclosures'

// LEAPS bot onboarding — suitability answers + tax profile.
//
// The tier is computed SERVER-SIDE by the ldp-onboarding edge function
// (ldp_risk_profiles is service-role write only, so a user can't give
// themselves a higher tier). This page collects answers, shows the
// disclosures, submits, and renders the tier the server returns.
//



const HORIZON_CHIPS = [1, 3, 5, 10]


const STEPS = ['Experience', 'Account', 'Taxes', 'Review']

function num(v) {
  if (v === '' || v == null) return null
  const n = Number(String(v).replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? n : null
}

export default function LeapsOnboarding() {
  const { user, profile } = useAuth()
  const navigate = useNavigate()
  const [step, setStep] = useState(0)
  const [states, setStates] = useState([])
  const [form, setForm] = useState({
    stated_tolerance: '',
    options_experience: '',
    account_size: '',
    horizon_years: '',
    filing_status: 'single',
    annual_income: '',
    state_code: '',
    allow_catalyst_plays: false,
  })
  const [accepted, setAccepted] = useState({})
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState(null)

  // Prefill from a previous run, the tax profile, and the account size
  // already on the Cash Moves profile.
  useEffect(() => {
    if (!user?.id) return
    let cancelled = false
    ;(async () => {
      const [risk, tax, fed] = await Promise.all([
        supabase.from('ldp_risk_profiles')
          .select('stated_tolerance, account_size, options_experience, horizon_years, allow_catalyst_plays')
          .eq('user_id', user.id).maybeSingle(),
        supabase.from('leaps_tax_profiles').select('filing_status, annual_income, state_code')
          .eq('user_id', user.id).maybeSingle(),
        supabase.from('tax_year_config').select('tax_year').eq('is_current', true).maybeSingle(),
      ])
      if (cancelled) return
      const r = risk.data
      const t = tax.data
      setForm((f) => ({
        ...f,
        stated_tolerance: r?.stated_tolerance ?? f.stated_tolerance,
        options_experience: r?.options_experience ?? f.options_experience,
        account_size: String(r?.account_size ?? profile?.account_size ?? ''),
        horizon_years: r?.horizon_years != null ? String(r.horizon_years) : f.horizon_years,
        allow_catalyst_plays: r?.allow_catalyst_plays ?? false,
        filing_status: t?.filing_status ?? f.filing_status,
        annual_income: t?.annual_income != null ? String(t.annual_income) : f.annual_income,
        state_code: t?.state_code ?? f.state_code,
      }))
      if (fed.data) {
        const st = await supabase.from('state_tax_rates').select('state_code, state_name')
          .eq('tax_year', fed.data.tax_year).order('state_name')
        if (!cancelled) setStates(st.data ?? [])
      }
    })()
    return () => { cancelled = true }
  }, [user?.id, profile?.account_size])

  const set = (k, v) => { setForm((f) => ({ ...f, [k]: v })); setError('') }

  function stepError(i) {
    if (i === 0) {
      if (!form.stated_tolerance) return 'Pick the option closest to how you feel about risk.'
      if (!form.options_experience) return 'Pick your options experience.'
    }
    if (i === 1) {
      const size = num(form.account_size)
      const years = num(form.horizon_years)
      if (size == null || size < 0) return 'Enter your account size.'
      if (years == null || years < 0 || years > 100) return 'Enter how many years until you need this money.'
    }
    if (i === 2) {
      const income = num(form.annual_income)
      if (!form.filing_status) return 'Pick your filing status.'
      if (income == null || income < 0) return 'Enter your expected taxable income (0 or more).'
      if (!form.state_code) return 'Pick your state.'
    }
    if (i === 3 && !DISCLOSURES.every((d) => accepted[d.id])) return 'Please read and accept each statement.'
    return ''
  }

  function next() {
    const err = stepError(step)
    if (err) return setError(err)
    setStep((s) => Math.min(s + 1, STEPS.length - 1))
  }

  async function submit() {
    for (let i = 0; i < STEPS.length; i++) {
      const err = stepError(i)
      if (err) { setStep(i); return setError(err) }
    }
    setSubmitting(true)
    setError('')
    const { data, error: fnError } = await supabase.functions.invoke('ldp-onboarding', {
      body: {
        answers: {
          stated_tolerance: form.stated_tolerance,
          options_experience: form.options_experience,
          account_size: num(form.account_size),
          horizon_years: num(form.horizon_years),
        },
        tax: {
          filing_status: form.filing_status,
          annual_income: num(form.annual_income),
          state_code: form.state_code,
        },
        allow_catalyst_plays: form.allow_catalyst_plays,
        disclosures: { version: LDP_DISCLOSURES_VERSION, accepted: true },
      },
    })
    setSubmitting(false)
    if (fnError || !data?.success) {
      let msg = data?.error
      if (!msg && fnError?.context?.json) {
        try { msg = (await fnError.context.json()).error } catch { /* fall through */ }
      }
      return setError(msg || 'Could not save your answers. Please try again.')
    }
    setResult(data.profile)
  }

  if (result) {
    return <ResultCard result={result} onDone={() => navigate('/leaps')} onAdd={() => navigate('/leaps?add=1')} />
  }

  return (
    <div className="px-4 py-4 pb-24 max-w-md mx-auto">
      <header className="mb-4">
        <Link to="/leaps" className="text-xs text-subtle hover:text-fg inline-flex items-center gap-1 mb-2 min-h-[44px]">
          <ChevronLeft size={14} /> LEAPS
        </Link>
        <div className="flex items-center gap-2 mb-1">
          <ShieldCheck size={16} className="text-amber-400" />
          <h1 className="text-lg font-semibold">Set up the LEAPS bot</h1>
        </div>
        <p className="text-xs text-subtle leading-relaxed">
          A few questions decide what the bot is allowed to buy for you, and your tax details decide when it sells.
        </p>
      </header>

      <ol className="flex gap-1 mb-5" aria-label="Progress">
        {STEPS.map((s, i) => (
          <li key={s} className="flex-1">
            <div className={clsx('h-1 rounded', i <= step ? 'bg-amber-400' : 'bg-faint')} />
            <div className={clsx('text-[10px] mt-1', i === step ? 'text-fg' : 'text-muted')}>{s}</div>
          </li>
        ))}
      </ol>

      {step === 0 && (
        <section>
          <Question title="How do you feel about risk?">
            {TOLERANCES.map((o) => (
              <Choice key={o.value} selected={form.stated_tolerance === o.value} onClick={() => set('stated_tolerance', o.value)}
                label={o.label} body={o.body} />
            ))}
          </Question>
          <Question title="How much options experience do you have?">
            {EXPERIENCE.map((o) => (
              <Choice key={o.value} selected={form.options_experience === o.value} onClick={() => set('options_experience', o.value)}
                label={o.label} body={o.body} />
            ))}
          </Question>
        </section>
      )}

      {step === 1 && (
        <section className="space-y-4">
          <Field label="Account size ($)" hint="The value of the account the bot will manage or suggest trades for.">
            <input inputMode="decimal" value={form.account_size} onChange={(e) => set('account_size', e.target.value)}
              placeholder="100000" className={inputCls} />
          </Field>
          <Field label="Years until you need this money">
            <input inputMode="decimal" value={form.horizon_years} onChange={(e) => set('horizon_years', e.target.value)}
              placeholder="5" className={inputCls} />
            <div className="flex gap-2 mt-2">
              {HORIZON_CHIPS.map((y) => (
                <button key={y} type="button" onClick={() => set('horizon_years', String(y))}
                  className={clsx('min-h-[44px] flex-1 rounded border text-sm',
                    num(form.horizon_years) === y ? 'border-amber-400/60 text-amber-300 bg-amber-400/10' : 'border-border text-subtle')}>
                  {y}{y === 10 ? '+' : ''} yr
                </button>
              ))}
            </div>
          </Field>
        </section>
      )}

      {step === 2 && (
        <section className="space-y-4">
          <Field label="Filing status">
            <select value={form.filing_status} onChange={(e) => set('filing_status', e.target.value)} className={inputCls}>
              {FILING_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </Field>
          <Field label="Expected taxable income this year, before LEAPS gains ($)"
            hint="Used to estimate which tax bracket your gains land in, and whether the 3.8% NIIT applies.">
            <input inputMode="decimal" value={form.annual_income} onChange={(e) => set('annual_income', e.target.value)}
              placeholder="150000" className={inputCls} />
          </Field>
          <Field label="State of residence">
            <select value={form.state_code} onChange={(e) => set('state_code', e.target.value)} className={inputCls}>
              <option value="">Select…</option>
              {states.map((s) => <option key={s.state_code} value={s.state_code}>{s.state_name}</option>)}
            </select>
          </Field>
        </section>
      )}

      {step === 3 && (
        <section>
          <div className="bg-card border border-border rounded-xl p-4 mb-4 text-xs space-y-1.5">
            <Row label="Risk tolerance" value={TOLERANCES.find((t) => t.value === form.stated_tolerance)?.label} />
            <Row label="Options experience" value={EXPERIENCE.find((t) => t.value === form.options_experience)?.label} />
            <Row label="Account size" value={`$${(num(form.account_size) ?? 0).toLocaleString()}`} />
            <Row label="Time horizon" value={`${num(form.horizon_years)} yr`} />
            <Row label="Filing status" value={FILING_STATUSES.find((s) => s.value === form.filing_status)?.label} />
            <Row label="Taxable income" value={`$${(num(form.annual_income) ?? 0).toLocaleString()}`} />
            <Row label="State" value={states.find((s) => s.state_code === form.state_code)?.state_name ?? form.state_code} />
          </div>

          <label className="flex items-start gap-3 mb-4 bg-card border border-border rounded-xl p-4 cursor-pointer">
            <input type="checkbox" className="mt-1 h-5 w-5 accent-amber-400" checked={form.allow_catalyst_plays}
              onChange={(e) => set('allow_catalyst_plays', e.target.checked)} />
            <span className="text-xs leading-relaxed">
              <span className="block text-fg font-semibold mb-0.5">Allow catalyst plays (optional)</span>
              <span className="text-subtle">
                Let satellites be bought or held right before binary events such as trial readouts or FDA dates.
                Off by default; these can gap sharply either way.
              </span>
            </span>
          </label>

          <div className="space-y-2">
            {DISCLOSURES.map((d) => (
              <label key={d.id} className="flex items-start gap-3 bg-card border border-border rounded-xl p-4 cursor-pointer">
                <input type="checkbox" className="mt-1 h-5 w-5 accent-amber-400" checked={!!accepted[d.id]}
                  onChange={(e) => { setAccepted((a) => ({ ...a, [d.id]: e.target.checked })); setError('') }} />
                <span className="text-xs leading-relaxed text-fg">{d.text}</span>
              </label>
            ))}
          </div>
        </section>
      )}

      {error && (
        <div className="mt-4 rounded-xl border border-rose-500/40 bg-rose-500/5 px-4 py-3 text-xs text-rose-200 flex items-start gap-2">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" /> <span>{error}</span>
        </div>
      )}

      <div className="mt-6 flex gap-2">
        {step > 0 && (
          <button type="button" onClick={() => { setStep((s) => s - 1); setError('') }}
            className="min-h-[44px] px-4 rounded border border-border text-sm text-subtle hover:text-fg">
            <ChevronLeft size={14} className="inline -mt-0.5" /> Back
          </button>
        )}
        {step < STEPS.length - 1 ? (
          <button type="button" onClick={next}
            className="flex-1 min-h-[44px] px-4 rounded bg-amber-400/10 border border-amber-400/40 text-amber-300 text-sm font-semibold hover:bg-amber-400/20 transition">
            Continue <ChevronRight size={14} className="inline -mt-0.5" />
          </button>
        ) : (
          <button type="button" onClick={submit} disabled={submitting}
            className="flex-1 min-h-[44px] px-4 rounded bg-amber-400/10 border border-amber-400/40 text-amber-300 text-sm font-semibold hover:bg-amber-400/20 transition disabled:opacity-40">
            {submitting ? 'Saving…' : 'Save and see my tier'}
          </button>
        )}
      </div>
    </div>
  )
}

const TIER_TONE = {
  conservative: 'bg-sky-500/15 text-sky-300 border-sky-500/40',
  moderate: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  aggressive: 'bg-rose-500/15 text-rose-300 border-rose-500/40',
}

function ResultCard({ result, onDone, onAdd }) {
  const d = result.display ?? {}
  return (
    <div className="px-4 py-4 pb-24 max-w-md mx-auto">
      <div className="bg-card border border-amber-400/40 rounded-xl p-5">
        <div className="flex items-center gap-2 mb-3">
          <Check size={16} className="text-green-400" />
          <h1 className="text-base font-semibold flex-1">You're set up</h1>
          <span className={clsx('text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border font-semibold', TIER_TONE[result.tier])}>
            {d.label ?? result.tier}
          </span>
        </div>
        <p className="text-xs text-subtle mb-2">{d.capped_by_text}</p>
        <p className="text-sm text-fg leading-relaxed mb-3">{d.allows}</p>
        <p className="text-[10px] text-muted mb-4">{d.account_text}</p>
        <button type="button" onClick={onAdd}
          className="w-full min-h-[44px] rounded bg-amber-400/10 border border-amber-400/40 text-amber-300 text-sm font-semibold hover:bg-amber-400/20 transition">
          Add your LEAPS positions
        </button>
        <button type="button" onClick={onDone}
          className="w-full min-h-[44px] mt-2 rounded border border-border text-sm text-subtle hover:text-fg transition">
          Go to LEAPS
        </button>
        <p className="text-[10px] text-muted mt-3 leading-relaxed">
          Each position you add gets its own exit targets, so the bot knows when to sell once your broker is connected.
        </p>
      </div>
      <p className="text-[10px] text-muted leading-relaxed mt-4">
        Tax figures are estimates. Actual taxes depend on your full tax situation; consult a tax professional.
      </p>
    </div>
  )
}

const inputCls = 'w-full min-h-[44px] bg-bg border border-border rounded px-3 py-2 text-sm font-mono-tab focus:outline-none focus:ring-1 focus:ring-amber-400/40'

function Question({ title, children }) {
  return (
    <fieldset className="mb-5">
      <legend className="text-sm font-semibold mb-2">{title}</legend>
      <div className="space-y-2">{children}</div>
    </fieldset>
  )
}

function Choice({ selected, onClick, label, body }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={selected}
      className={clsx('w-full text-left min-h-[44px] rounded-xl border px-4 py-3 transition',
        selected ? 'border-amber-400/60 bg-amber-400/10' : 'border-border bg-card hover:border-amber-400/30')}>
      <div className={clsx('text-sm font-semibold', selected ? 'text-amber-300' : 'text-fg')}>{label}</div>
      <div className="text-xs text-subtle mt-0.5">{body}</div>
    </button>
  )
}

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="block text-xs text-fg mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[10px] text-muted mt-1 leading-relaxed">{hint}</span>}
    </label>
  )
}

function Row({ label, value }) {
  return (
    <div className="flex gap-2">
      <span className="text-subtle flex-1">{label}</span>
      <span className="font-mono-tab text-fg">{value ?? '—'}</span>
    </div>
  )
}
