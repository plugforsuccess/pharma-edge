import { useEffect, useMemo, useState } from 'react'
import { Calculator } from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import {
  FILING_STATUSES, INCOME_KINDS, makeRateResolver, growthProjection, portfolioProjection, positionAfterTax, rocAdjustedBasis,
} from '../utils/afterTax'
import NumberInput from '../components/NumberInput'

// /simulator — after-tax "what if" sandbox (Pro).
//   Grow: add money over time (monthly contributions, price growth,
//         payouts reinvested or paid out) → after-tax value by year.
//   Sell: one sale under a different date, price, residency, filing
//         status or income, next to your own tax setup.
// Same math as /leaps (afterTax.js), so the numbers line up with
// Positions. Nothing here is saved.

const usd = (n) => (Number.isFinite(n)
  ? `${n < 0 ? '−' : ''}$${Math.round(Math.abs(n)).toLocaleString('en-US')}` : '—')
const num = (s) => {
  if (s === '' || s == null) return null
  const n = Number(String(s).replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}
const todayYmd = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const unitsLabel = (pos) => (pos.instrument_type === 'crypto' ? `${Number(pos.shares)} $${pos.ticker}`
  : pos.instrument_type === 'stock' ? `${Number(pos.shares).toLocaleString('en-US')} shares`
    : `${Number(pos.contracts).toLocaleString('en-US')} contracts`)
const shortDate = (ymd) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd ?? ''))
  if (!m) return ''
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}
const holdingLabel = (pos) => `${pos.ticker ?? pos.name} • ${unitsLabel(pos)}`

const CARD = 'bg-card border border-border rounded-2xl p-5 mb-5'
const inputCls = 'w-full min-h-[44px] bg-bg border border-border rounded-lg px-3 py-2 text-sm text-fg font-mono-tab placeholder:text-muted focus:outline-none focus:border-amber-400/60 focus:ring-1 focus:ring-amber-400/30 transition-colors'
const dateCls = `${inputCls} appearance-none text-left [&::-webkit-date-and-time-value]:text-left [&::-webkit-calendar-picker-indicator]:opacity-60`
const INVESTMENTS = new Set(['equity_option', 'index_option_1256', 'stock', 'crypto'])
const GROWABLE = new Set(['stock', 'crypto'])

export default function Simulator() {
  const { user } = useAuth()
  const [federal, setFederal] = useState(undefined)
  const [profile, setProfile] = useState(null)
  const [states, setStates] = useState([])
  const [positions, setPositions] = useState([])
  const [tab, setTab] = useState('grow')

  useEffect(() => {
    if (!user?.id) return
    let cancelled = false
    ;(async () => {
      try {
        const [fed, prof, pos] = await Promise.all([
          supabase.from('tax_year_config').select('*').eq('is_current', true).maybeSingle(),
          supabase.from('leaps_tax_profiles').select('*').eq('user_id', user.id).maybeSingle(),
          supabase.from('leaps_positions').select('*').eq('user_id', user.id).is('closed_at', null)
            .order('purchase_date', { ascending: true }),
        ])
        if (cancelled) return
        setFederal(fed.data ?? null)
        setProfile(prof.data ?? null)
        setPositions(pos.data ?? [])
        if (fed.data) {
          const st = await supabase.from('state_tax_rates').select('*').eq('tax_year', fed.data.tax_year).order('state_name')
          if (!cancelled) setStates(st.data ?? [])
        }
      } catch (err) {
        console.error('[simulator] load threw', err)
        if (!cancelled) setFederal(null)
      }
    })()
    return () => { cancelled = true }
  }, [user?.id])

  const setup = useMemo(() => ({
    filing_status: profile?.filing_status ?? 'single',
    annual_income: Number(profile?.annual_income) || 0,
    state_code: profile?.state_code ?? null,
    act60: profile?.pr_act60_rate == null ? null : Number(profile.pr_act60_rate),
    override: { long_term: profile?.lt_rate_override ?? null, short_term: profile?.st_rate_override ?? null },
  }), [profile])

  const resolverFor = useMemo(() => (s) => {
    if (!federal) return null
    const state = states.find((x) => x.state_code === s.state_code) ?? null
    const override = s.override ?? { long_term: null, short_term: null }
    if (!state && (override.long_term == null || override.short_term == null)) return null
    return makeRateResolver({ federal, state, filingStatus: s.filing_status, income: s.annual_income,
      override, act60Rate: s.state_code === 'PR' ? s.act60 : null })
  }, [federal, states])

  const myRates = useMemo(() => resolverFor(setup), [resolverFor, setup])

  return (
    <div className="px-4 py-4 pb-24 max-w-md mx-auto">
      <div className="flex items-center gap-2 mb-4">
        <Calculator size={16} className="text-amber-400" />
        <h1 className="text-lg font-semibold">Simulator</h1>
      </div>

      <Segmented value={tab} onChange={setTab}
        options={[{ value: 'grow', label: 'Grow' }, { value: 'sell', label: 'Sell' }]} />
      <div className="h-5" />

      {federal === undefined ? (
        <div className="text-xs text-muted py-8 text-center">Loading…</div>
      ) : !federal ? (
        <div className={CARD}><p className="text-sm text-subtle">Tax figures for this year haven't loaded. Reload to try again.</p></div>
      ) : !myRates ? (
        <div className={CARD}><p className="text-sm text-subtle">Pick your residency in Settings to run the simulator.</p></div>
      ) : tab === 'grow' ? (
        <GrowSim positions={positions.filter((x) => GROWABLE.has(x.instrument_type))}
          cash={positions.filter((x) => x.instrument_type === 'cash')} rateForGain={myRates} />
      ) : (
        <SellSim positions={positions.filter((x) => INVESTMENTS.has(x.instrument_type))} setup={setup} states={states} resolverFor={resolverFor} />
      )}

      <p className="text-xs text-muted">
        All tax figures are estimates, not tax advice. Consult a tax professional before acting on them.
      </p>
    </div>
  )
}

// ── Grow: contributions over time ─────────────────────────────────

// One holding's numbers into the Grow form.
function fromHolding(pos, x) {
  const d = pos.details ?? {}
  return {
    ...x,
    start: String(Number(pos.current_value) || 0),
    cost: String(+rocAdjustedBasis(pos, todayYmd()).toFixed(2)),
    yield: d.dividend_yield != null ? String(+(Number(d.dividend_yield) * 100).toFixed(4)) : '0',
    kind: d.dividend_kind ?? 'qualified',
    // Income holdings (preferreds, dividend funds) start with flat prices.
    growth: Number(d.dividend_yield) > 0 ? '0' : x.growth,
  }
}
const largest = (list) => [...list].sort((a, b) => (Number(b.current_value) || 0) - (Number(a.current_value) || 0))[0] ?? null

// Each holding keeps its own yield and income type; cash grows at its
// APY (taxed as interest; T-bills skip state tax). Return-of-capital
// preferreds hold their price. Real estate and options aren't included.
function sleevesFor(positions, cash) {
  return [
    ...positions.map((pos) => {
      const d = pos.details ?? {}
      return {
        startValue: Number(pos.current_value) || 0,
        startBasis: rocAdjustedBasis(pos, todayYmd()),
        yieldPct: Number(d.dividend_yield) || 0,
        kind: d.dividend_kind ?? 'qualified',
        ...(d.dividend_kind === 'roc' ? { priceGrowth: 0 } : {}),
      }
    }),
    ...cash.map((c) => ({
      startValue: Number(c.current_value) || 0,
      startBasis: Number(c.current_value) || 0,
      yieldPct: Number(c.details?.apy) || 0,
      kind: c.details?.account_kind === 't_bills' ? 'treasury' : 'ordinary',
      priceGrowth: 0,
    })),
  ]
}

function GrowSim({ positions, cash = [], rateForGain }) {
  const base = { start: '10000', cost: '10000', monthly: '500', years: '10', growth: '7', yield: '0', kind: 'qualified', reinvest: true }
  // Opens on your largest holding; "All holdings" and "New" are in the list.
  const first = largest(positions)
  const [from, setFrom] = useState(first ? first.id : 'new')
  const [f, setF] = useState(() => (first ? fromHolding(first, base) : base))
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }))
  const all = from === 'all'
  const sleeves = useMemo(() => sleevesFor(positions, cash), [positions, cash])
  const allValue = sleeves.reduce((sum, x) => sum + x.startValue, 0)
  const holdingsCount = positions.length + cash.length

  function pick(id) {
    setFrom(id)
    const pos = positions.find((x) => x.id === id)
    if (pos) setF((x) => fromHolding(pos, x))
  }

  const years = Math.min(50, Math.max(0, Math.round(num(f.years) ?? 0)))
  const rows = useMemo(() => (all
    ? portfolioProjection({
      sleeves, monthly: num(f.monthly) ?? 0, years, priceGrowth: (num(f.growth) ?? 0) / 100, reinvest: f.reinvest, rateForGain,
    })
    : growthProjection({
      startValue: num(f.start) ?? 0,
      startBasis: num(f.cost) ?? num(f.start) ?? 0,
      monthly: num(f.monthly) ?? 0,
      years,
      priceGrowth: (num(f.growth) ?? 0) / 100,
      yieldPct: (num(f.yield) ?? 0) / 100,
      kind: f.kind,
      reinvest: f.reinvest,
      rateForGain,
    })), [all, sleeves, f, years, rateForGain])
  const end = rows[rows.length - 1]
  const hasYield = all ? sleeves.some((x) => x.yieldPct > 0) : (num(f.yield) ?? 0) > 0
  // Year 1–5, then every 5th year, and always the last.
  const shown = rows.filter((r) => r.year <= 5 || r.year % 5 === 0 || r === end)

  return (
    <>
      <section className={CARD}>
        <h2 className="text-sm font-semibold mb-4">Add money over time</h2>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start from" wide>
            <select value={from} onChange={(e) => (['new', 'all'].includes(e.target.value) ? setFrom(e.target.value) : pick(e.target.value))} className={inputCls}>
              {holdingsCount > 1 && <option value="all">All holdings ({holdingsCount})</option>}
              {positions.map((pos) => <option key={pos.id} value={pos.id}>{holdingLabel(pos)}</option>)}
              <option value="new">New investment</option>
            </select>
            {all && (
              <span className="block mt-1.5 text-xs text-muted">
                Starts from <span className="font-mono-tab text-fg">{usd(allValue)}</span>, each holding at its own yield; cash at its APY. Real estate and options aren't included.
              </span>
            )}
          </Field>
          {!all && (<>
          <Field label="Starting value">
            <Affix prefix="$"><NumberInput value={f.start} onChange={set('start')} placeholder="0" className={clsx(inputCls, 'pl-7')} /></Affix>
          </Field>
          <Field label="Cost so far">
            <Affix prefix="$"><NumberInput value={f.cost} onChange={set('cost')} placeholder="0" className={clsx(inputCls, 'pl-7')} /></Affix>
          </Field>
          </>)}
          <Field label="Add each month">
            <Affix prefix="$"><NumberInput value={f.monthly} onChange={set('monthly')} placeholder="500" className={clsx(inputCls, 'pl-7')} /></Affix>
          </Field>
          <Field label="Years">
            <NumberInput decimals={0} value={f.years} onChange={set('years')} placeholder="10" className={inputCls} />
          </Field>
          <Field label="Price growth / yr">
            <Affix suffix="%"><NumberInput decimals={2} value={f.growth} onChange={set('growth')} placeholder="7" className={clsx(inputCls, 'pr-8')} /></Affix>
          </Field>
          {!all && (
            <Field label="Yield / yr">
              <Affix suffix="%"><NumberInput decimals={4} value={f.yield} onChange={set('yield')} placeholder="0" className={clsx(inputCls, 'pr-8')} /></Affix>
            </Field>
          )}
          {hasYield && (
            <>
              {!all && (
                <Field label="Income type" wide>
                  <select value={f.kind} onChange={(e) => set('kind')(e.target.value)} className={inputCls}>
                    {INCOME_KINDS.map((k) => <option key={k.value} value={k.value}>{k.long}</option>)}
                  </select>
                </Field>
              )}
              <Field label="Payouts" wide>
                <Segmented compact value={f.reinvest ? 'reinvest' : 'cash'} onChange={(v) => set('reinvest')(v === 'reinvest')}
                  options={[{ value: 'reinvest', label: 'Reinvest' }, { value: 'cash', label: 'Take as cash' }]} />
              </Field>
            </>
          )}
        </div>
      </section>

      {end && (
        <section className={CARD}>
          <div className="text-[10px] uppercase tracking-wider text-muted mb-1">After tax if sold in {end.year} year{end.year === 1 ? '' : 's'}</div>
          <div className="text-2xl font-semibold font-mono-tab text-green-400">{usd(end.total_after_tax)}</div>
          <div className="text-sm text-subtle mt-1">
            You put in <span className="text-fg font-mono-tab">{usd(end.invested)}</span>
            {' · '}gain after tax <span className={clsx('font-mono-tab', end.total_after_tax - end.invested < 0 ? 'text-rose-300' : 'text-green-400')}>{usd(end.total_after_tax - end.invested)}</span>
          </div>
          <div className="grid grid-cols-3 gap-3 mt-4 py-3 border-y border-hairline">
            <Stat label="Value" value={usd(end.value)} />
            <Stat label="Tax at sale" value={usd(end.sale_tax)} />
            <Stat label={f.reinvest ? 'Tax on payouts' : 'Payouts kept'} value={usd(f.reinvest ? end.tax_paid : end.income_kept)} />
          </div>

          <table className="w-full text-sm mt-4">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-muted">
                <th className="text-left font-medium pb-2">Year</th>
                <th className="text-right font-medium pb-2">Put in</th>
                <th className="text-right font-medium pb-2">Value</th>
                <th className="text-right font-medium pb-2">After tax</th>
              </tr>
            </thead>
            <tbody className="font-mono-tab">
              {shown.map((r) => (
                <tr key={r.year} className="border-t border-hairline">
                  <td className="py-2 text-subtle">{r.year}</td>
                  <td className="py-2 text-right">{usd(r.invested)}</td>
                  <td className="py-2 text-right">{usd(r.value)}</td>
                  <td className="py-2 text-right text-fg font-semibold">{usd(r.total_after_tax)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  )
}

// ── Sell: one sale, two tax setups ────────────────────────────────

const sellFrom = (pos, x) => ({ ...x, cost: String(+rocAdjustedBasis(pos, todayYmd()).toFixed(2)), value: String(Number(pos.current_value) || 0),
  bought: pos.purchase_date ?? '', type: pos.instrument_type })

function SellSim({ positions, setup, states, resolverFor }) {
  // Opens on your largest investment; "New trade" is in the list.
  const first = largest(positions)
  const [from, setFrom] = useState(first ? first.id : 'new')
  const [f, setF] = useState(() => {
    const base = { cost: '10000', value: '20000', bought: '', sell: todayYmd(), type: 'equity_option' }
    return first ? sellFrom(first, base) : base
  })
  const [alt, setAlt] = useState({ state_code: setup.state_code ?? '', filing_status: setup.filing_status, income: String(setup.annual_income) })
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }))
  const setA = (k) => (v) => setAlt((x) => ({ ...x, [k]: v }))

  function pick(id) {
    setFrom(id)
    const pos = positions.find((x) => x.id === id)
    if (pos) setF((x) => sellFrom(pos, x))
  }

  // Your CPA rates (if any) only carry over while the what-if matches your setup.
  const altSetup = useMemo(() => {
    const same = (alt.state_code || null) === setup.state_code && alt.filing_status === setup.filing_status
      && (num(alt.income) ?? 0) === setup.annual_income
    return {
      filing_status: alt.filing_status, annual_income: num(alt.income) ?? 0, state_code: alt.state_code || null,
      act60: setup.act60, override: same ? setup.override : { long_term: null, short_term: null },
    }
  }, [alt, setup])

  const sale = { basis: num(f.cost), currentValue: num(f.value) ?? 0, purchaseDate: f.bought || f.sell, asOf: f.sell, instrumentType: f.type }
  const mine = sale.basis > 0 ? positionAfterTax({ ...sale, rateForGain: resolverFor(setup) }) : null
  const altRates = resolverFor(altSetup)
  const theirs = sale.basis > 0 && altRates ? positionAfterTax({ ...sale, rateForGain: altRates }) : null
  const diff = mine && theirs ? theirs.after_tax_value - mine.after_tax_value : null
  const stateName = (code) => states.find((x) => x.state_code === code)?.state_name ?? code ?? '—'
  const character = (c) => (c?.tax_character === 'section_1256' ? '§1256 60/40' : c?.is_long_term ? 'Long-term' : 'Short-term')

  return (
    <>
      <section className={CARD}>
        <h2 className="text-sm font-semibold mb-4">The sale</h2>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start from" wide>
            <select value={from} onChange={(e) => (e.target.value === 'new' ? setFrom('new') : pick(e.target.value))} className={inputCls}>
              {positions.map((pos) => <option key={pos.id} value={pos.id}>{holdingLabel(pos)}</option>)}
              <option value="new">New trade</option>
            </select>
          </Field>
          <Field label="Cost">
            <Affix prefix="$"><NumberInput value={f.cost} onChange={set('cost')} placeholder="10,000" className={clsx(inputCls, 'pl-7')} /></Affix>
          </Field>
          <Field label="Sell for">
            <Affix prefix="$"><NumberInput value={f.value} onChange={set('value')} placeholder="20,000" className={clsx(inputCls, 'pl-7')} /></Affix>
          </Field>
          <Field label="Bought">
            <input type="date" value={f.bought} max={f.sell || undefined} onChange={(e) => set('bought')(e.target.value)} className={dateCls} />
          </Field>
          <Field label="Sell on">
            <input type="date" value={f.sell} min={f.bought || undefined} onChange={(e) => set('sell')(e.target.value)} className={dateCls} />
          </Field>
        </div>
      </section>

      <section className={CARD}>
        <h2 className="text-sm font-semibold mb-4">What if</h2>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Residency" wide>
            <select value={alt.state_code} onChange={(e) => setA('state_code')(e.target.value)} className={inputCls}>
              <option value="">Pick one</option>
              {states.map((s) => <option key={s.state_code} value={s.state_code}>{s.state_name}</option>)}
            </select>
          </Field>
          <Field label="Filing status" wide>
            <select value={alt.filing_status} onChange={(e) => setA('filing_status')(e.target.value)} className={inputCls}>
              {FILING_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </Field>
          <Field label="Income before gains" wide>
            <Affix prefix="$"><NumberInput value={alt.income} onChange={setA('income')} placeholder="150,000" className={clsx(inputCls, 'pl-7')} /></Affix>
          </Field>
        </div>
      </section>

      {mine && (
        <section className={CARD}>
          <div className="grid grid-cols-2 gap-4">
            <Outcome title="Your setup" sub={`${stateName(setup.state_code)} · ${character(mine)}`} r={mine} />
            {theirs ? <Outcome title="What if" sub={`${stateName(altSetup.state_code)} · ${character(theirs)}`} r={theirs} />
              : <div className="text-sm text-subtle">Pick a residency to compare.</div>}
          </div>
          {diff != null && (
            <div className="mt-4 pt-3 border-t border-hairline text-sm">
              {Math.abs(diff) < 0.5 ? <span className="text-subtle">Same after tax.</span> : (
                <>The what-if keeps <span className={clsx('font-mono-tab font-semibold', diff > 0 ? 'text-green-400' : 'text-rose-300')}>{usd(Math.abs(diff))}</span> {diff > 0 ? 'more' : 'less'}.</>
              )}
            </div>
          )}
          {mine.is_long_term === false && mine.tax_saved_by_waiting > 0 && (
            <div className="mt-3 text-sm text-subtle">
              Selling on or after {shortDate(mine.long_term_date)} (long-term) keeps about <span className="font-mono-tab text-green-400">{usd(mine.tax_saved_by_waiting)}</span> more in your setup.
            </div>
          )}
        </section>
      )}
    </>
  )
}

function Outcome({ title, sub, r }) {
  return (
    <div className="min-w-0">
      <div className="text-sm font-semibold">{title}</div>
      <div className="text-xs text-muted mb-3 truncate">{sub}</div>
      <div className="text-xs text-muted">After tax</div>
      <div className="text-lg font-semibold font-mono-tab text-green-400 mb-2">{usd(r.after_tax_value)}</div>
      <div className="text-xs text-muted">Tax</div>
      <div className="text-sm font-mono-tab">{usd(r.estimated_tax)} <span className="text-muted">at {(r.tax_rate * 100).toFixed(2)}%</span></div>
    </div>
  )
}

// ── Small form pieces (match /leaps) ──────────────────────────────

function Field({ label, wide, children }) {
  return (
    <label className={clsx('block min-w-0', wide && 'col-span-2')}>
      <span className="block text-xs text-subtle mb-1.5">{label}</span>
      {children}
    </label>
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

function Stat({ label, value }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted truncate mb-1">{label}</div>
      <div className="text-sm truncate font-mono-tab text-fg">{value}</div>
    </div>
  )
}

function Segmented({ value, onChange, options, compact }) {
  return (
    <div role="radiogroup" className={clsx('grid rounded-lg border border-border bg-bg p-0.5', compact ? 'gap-0.5' : 'gap-1')}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}
          className={clsx('rounded-md font-semibold transition whitespace-nowrap',
            compact ? 'min-h-[40px] px-2.5 text-xs' : 'min-h-[44px] px-3 text-sm',
            value === o.value ? 'bg-amber-400/15 text-amber-300 ring-1 ring-amber-400/40' : 'text-subtle hover:text-fg')}>
          {o.label}
        </button>
      ))}
    </div>
  )
}
