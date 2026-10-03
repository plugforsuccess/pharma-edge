import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useHoldings, isQuantity } from '../hooks/useHoldings'
import { todayYmd, positionAfterTax, incomeHoldingReturn } from '../utils/afterTax'
import { usd, pctSigned, nameOf, gainLabel, isRoc, exitRows } from '../lib/holdingChecks'
import LineChart from '../components/LineChart'

// Charts — the holdings over time, after tax. History comes from
// leaps_position_marks (one value per holding per day, written whenever a
// price is saved) and starts at each holding's cost on its purchase date.
// After-tax values are figured as of each date (holding period then), so
// a holding crossing its long-term date steps up on the chart.

const DAY_MS = 86400000
const ms = (ymd) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd ?? ''))
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null
}
const ymdOf = (t) => new Date(t).toISOString().slice(0, 10)
const nyDate = (ts) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ts))
const signedUsd = (n) => (n > 0.5 ? `+${usd(n)}` : usd(n))
// Markers further out than this don't stretch the chart.
const MARKER_HORIZON_DAYS = 550

const ALLOC = [
  { key: 'options', label: 'Options', bg: 'bg-amber-400' },
  { key: 'shares', label: 'Shares', bg: 'bg-green-400' },
  { key: 'income', label: 'Income', bg: 'bg-violet-400' },
  { key: 'crypto', label: 'Crypto', bg: 'bg-amber-200' },
  { key: 'cash', label: 'Cash', bg: 'bg-blue-400' },
  { key: 'real_estate', label: 'Real Estate', bg: 'bg-orange-400' },
]
function allocKey(pos) {
  const t = pos.instrument_type
  if (t === 'equity_option' || t === 'index_option_1256') return 'options'
  if (t === 'crypto') return 'crypto'
  if (t === 'stock') return Number(pos.details?.dividend_yield) > 0 || pos.details?.dividend_kind === 'roc' ? 'income' : 'shares'
  return t
}

export default function Charts() {
  const { user } = useAuth()
  const { positions, ready, rateForGain, results, cashResults, realEstateResults } = useHoldings()
  const [marks, setMarks] = useState([])
  const [selected, setSelected] = useState(null)
  const today = todayYmd()

  useEffect(() => {
    if (!user) return
    let live = true
    supabase.from('leaps_position_marks').select('position_id, as_of, value').order('as_of')
      .then(({ data, error }) => { if (live) setMarks(error ? [] : data ?? []) })
    return () => { live = false }
  }, [user, positions])

  // Price history per holding, starting at cost on the purchase date.
  const history = useMemo(() => {
    const byPos = new Map()
    for (const m of marks) {
      if (!byPos.has(m.position_id)) byPos.set(m.position_id, [])
      byPos.get(m.position_id).push(m)
    }
    const out = new Map()
    for (const r of results) {
      const { pos } = r
      const pts = new Map()
      const start = ms(pos.purchase_date)
      if (start != null) pts.set(start, Number(pos.cost_basis))
      for (const m of byPos.get(pos.id) ?? []) {
        const t = ms(m.as_of)
        if (t != null && (start == null || t >= start)) pts.set(t, Number(m.value))
      }
      const nowT = ms(pos.value_as_of ? nyDate(pos.value_as_of) : today)
      if (nowT != null) pts.set(nowT, Number(pos.current_value))
      out.set(pos.id, [...pts.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v })))
    }
    return out
  }, [marks, results, today])

  // After-tax value if sold on that date.
  const afterTaxAt = useMemo(() => {
    if (!rateForGain) return null
    return (r, v, t) => {
      const { pos } = r
      const asOf = ymdOf(t)
      if (r.income) {
        const res = incomeHoldingReturn({ cost: Number(pos.cost_basis), value: v, yieldPct: Number(pos.details?.dividend_yield),
          kind: r.income.kind, purchaseDate: pos.purchase_date, asOf,
          payoutsReceived: asOf === today ? pos.details?.payouts_received : undefined, rateForGain })
        return res?.after_tax_value ?? v
      }
      const res = positionAfterTax({ basis: Number(pos.cost_basis), currentValue: v, purchaseDate: pos.purchase_date,
        asOf, rateForGain, instrumentType: pos.instrument_type })
      return res?.after_tax_value ?? v
    }
  }, [rateForGain, today])

  // Whole portfolio (investments): each holding at its latest value on or
  // before each date, from its purchase date on.
  const portfolio = useMemo(() => {
    if (!afterTaxAt || results.length === 0) return null
    const dates = [...new Set(results.flatMap((r) => (history.get(r.pos.id) ?? []).map((p) => p.t)))].sort((a, b) => a - b)
    const before = []
    const after = []
    for (const t of dates) {
      let b = 0
      let a = 0
      let c = 0
      for (const r of results) {
        const pts = history.get(r.pos.id) ?? []
        let p = null
        for (const x of pts) if (x.t <= t) p = x
        if (!p) continue
        b += p.v
        a += afterTaxAt(r, p.v, t)
        c += Number(r.pos.cost_basis)
      }
      // Gain, not value: new money added isn't growth.
      before.push({ t, v: b - c })
      after.push({ t, v: a - c })
    }
    return { before, after }
  }, [results, history, afterTaxAt])

  const sorted = useMemo(() => [...results].filter((r) => r.calc).sort((a, b) => b.calc.after_tax_value - a.calc.after_tax_value), [results])
  const current = sorted.find((r) => r.pos.id === selected) ?? sorted[0] ?? null

  const holdingChart = useMemo(() => {
    if (!current || !afterTaxAt) return null
    const { pos, calc } = current
    const pts = history.get(pos.id) ?? []
    const after = pts.map((p) => ({ t: p.t, v: afterTaxAt(current, p.v, p.t) }))
    const hLines = [{ v: Number(pos.cost_basis), label: `Cost ${usd(Number(pos.cost_basis))}` }]
    // Targets on the chart: those hit, and the next one if it's in view
    // (a far-off target would flatten the line; it's named below instead).
    let farTarget = null
    if (!isRoc(pos)) {
      const rows = exitRows(current)
      const next = rows.find((x) => !x.hit && x.contracts !== 0)
      const top = Math.max(Number(pos.cost_basis), ...pts.map((p) => p.v))
      for (const row of rows.filter((x) => x.hit).concat(next ? [next] : [])) {
        if (!row.hit && row.exit_value > top * 1.6) { farTarget = { row, needs: row.exit_value / calc.current_value - 1 }; continue }
        hLines.push({ v: row.exit_value, label: `${gainLabel(row)} ${usd(row.exit_value)}`, stroke: 'stroke-amber-400/60', text: 'fill-amber-300' })
      }
    }
    const horizon = ms(today) + MARKER_HORIZON_DAYS * DAY_MS
    const vLines = []
    const lt = ms(calc.long_term_date)
    if (calc.is_long_term === false && lt != null && lt <= horizon) vLines.push({ t: lt, label: 'Long-term' })
    if (!isQuantity(pos.instrument_type) && pos.expiration) {
      const exp = ms(pos.expiration)
      const roll = exp - 270 * DAY_MS
      const stop = exp - 180 * DAY_MS
      if (roll > ms(today) && roll <= horizon) vLines.push({ t: roll, label: 'Roll window' })
      if (stop > ms(today) && stop <= horizon) vLines.push({ t: stop, label: 'Exit or roll' })
    }
    return { pts, after, hLines, vLines, farTarget }
  }, [current, history, afterTaxAt, today])

  // Where the after-tax net worth sits, by type.
  const allocation = useMemo(() => {
    const sums = Object.fromEntries(ALLOC.map((a) => [a.key, 0]))
    for (const r of results) if (r.calc) sums[allocKey(r.pos)] += Math.max(0, r.calc.after_tax_value)
    for (const r of cashResults) sums.cash += Math.max(0, r.cash.after_tax_value)
    for (const r of realEstateResults) sums.real_estate += Math.max(0, r.re?.after_tax_equity ?? 0)
    const total = Object.values(sums).reduce((s, v) => s + v, 0)
    return { total, rows: ALLOC.map((a) => ({ ...a, value: sums[a.key], share: total > 0 ? sums[a.key] / total : 0 })).filter((a) => a.value > 0) }
  }, [results, cashResults, realEstateResults])

  const gains = useMemo(() => sorted.map((r) => ({ r, gain: r.income?.after_tax_gain ?? r.calc.after_tax_gain }))
    .sort((a, b) => b.gain - a.gain), [sorted])
  const maxGain = Math.max(1, ...gains.map((g) => Math.abs(g.gain)))

  const loading = positions === null
  const fewPoints = holdingChart && holdingChart.pts.length < 3

  return (
    <div className="px-4 py-4 pb-24 max-w-md mx-auto">
      <header className="flex items-center justify-between mb-5">
        <h1 className="text-lg font-semibold">Charts</h1>
      </header>

      {loading ? (
        <div className="text-xs text-muted py-8 text-center">Loading…</div>
      ) : (positions?.length ?? 0) === 0 ? (
        <section className="bg-card border border-border rounded-2xl p-5">
          <p className="text-sm text-subtle mb-4">Add a holding to chart it after tax.</p>
          <Link to="/leaps?add=1" className="min-h-[44px] inline-flex items-center px-4 rounded-lg bg-amber-400 text-bg text-sm font-semibold">Add a holding</Link>
        </section>
      ) : !ready ? (
        <section className="bg-card border border-border rounded-2xl p-5 text-sm text-subtle">
          Add your tax details in Settings to chart your holdings after tax.
        </section>
      ) : (
        <>
          {portfolio && results.length > 0 && (
            <section className="bg-card border border-border rounded-2xl p-5 mb-5">
              <h2 className="text-sm font-semibold mb-3">Gain over time</h2>
              <LineChart format={signedUsd} hLines={[{ v: 0, label: 'Break-even' }]}
                series={[
                  { id: 'after', label: 'After tax', points: portfolio.after, stroke: 'stroke-green-400', text: 'text-green-400' },
                  { id: 'before', label: 'Before tax', points: portfolio.before, stroke: 'stroke-amber-400', text: 'text-amber-300' },
                ]} />
            </section>
          )}

          {current && holdingChart && (
            <section className="bg-card border border-border rounded-2xl p-5 mb-5">
              <div className="-mx-1 mb-4 flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Holding">
                {sorted.map((r) => (
                  <button key={r.pos.id} type="button" role="tab" aria-selected={r === current}
                    onClick={() => setSelected(r.pos.id)}
                    className={clsx('shrink-0 min-h-[36px] px-3 rounded-full border text-xs font-semibold transition',
                      r === current ? 'border-amber-400/60 bg-amber-400/10 text-amber-300' : 'border-border text-subtle hover:text-fg')}>
                    {nameOf(r.pos)}
                  </button>
                ))}
              </div>
              <LineChart format={usd} hLines={holdingChart.hLines} vLines={holdingChart.vLines}
                series={[
                  { id: 'after', label: 'After tax', points: holdingChart.after, stroke: 'stroke-green-400', text: 'text-green-400' },
                  { id: 'before', label: 'Before tax', points: holdingChart.pts, stroke: 'stroke-amber-400', text: 'text-amber-300' },
                ]} />
              {holdingChart.farTarget && (
                <p className="mt-3 text-xs text-muted">
                  Next target: {gainLabel(holdingChart.farTarget.row)} at <span className="font-mono-tab text-amber-300">{usd(holdingChart.farTarget.row.exit_value)}</span> · needs <span className="font-mono-tab text-fg">{pctSigned(holdingChart.farTarget.needs)}</span>
                </p>
              )}
              {fewPoints && (
                <p className="mt-3 text-xs text-muted">Each price you save adds a point. History starts at your cost on the day you bought.</p>
              )}
              <div className="mt-4 pt-4 border-t border-hairline grid grid-cols-3 gap-3">
                <MiniStat label="After tax" value={usd(current.calc.after_tax_value)} tone="text-green-400" />
                <MiniStat label="Gain after tax" value={pctSigned((current.income?.after_tax_gain ?? current.calc.after_tax_gain) / current.calc.basis)}
                  tone={(current.income?.after_tax_gain ?? current.calc.after_tax_gain) < 0 ? 'text-rose-300' : 'text-green-400'} />
                <MiniStat label={current.calc.is_long_term === false ? 'Long-term in' : 'Tax status'}
                  value={current.calc.is_long_term === false ? `${current.calc.days_until_long_term} days`
                    : current.calc.tax_character === 'section_1256' ? '§1256' : 'Long-term'} />
              </div>
            </section>
          )}

          {allocation.rows.length > 0 && (
            <section className="bg-card border border-border rounded-2xl p-5 mb-5">
              <h2 className="text-sm font-semibold mb-3">Where it sits, after tax</h2>
              <div className="flex h-3 rounded-full overflow-hidden bg-faint" role="img"
                aria-label={allocation.rows.map((a) => `${a.label} ${Math.round(a.share * 100)}%`).join(', ')}>
                {allocation.rows.map((a) => <div key={a.key} className={a.bg} style={{ width: `${a.share * 100}%` }} />)}
              </div>
              <ul className="mt-4 space-y-2">
                {allocation.rows.map((a) => (
                  <li key={a.key} className="flex items-center gap-3 text-sm">
                    <span className={clsx('h-2.5 w-2.5 rounded-sm shrink-0', a.bg)} aria-hidden />
                    <span className="flex-1 text-subtle">{a.label}</span>
                    <span className="font-mono-tab text-fg">{usd(a.value)}</span>
                    <span className="w-12 text-right font-mono-tab text-muted text-xs">{Math.round(a.share * 100)}%</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {gains.length > 0 && (
            <section className="bg-card border border-border rounded-2xl p-5 mb-5">
              <h2 className="text-sm font-semibold mb-3">Gain after tax, by holding</h2>
              <ul className="space-y-3">
                {gains.map(({ r, gain }) => (
                  <li key={r.pos.id}>
                    <div className="flex items-baseline gap-3 text-sm">
                      <span className="flex-1 min-w-0 truncate text-subtle">{nameOf(r.pos)}</span>
                      <span className={clsx('font-mono-tab', gain < 0 ? 'text-rose-300' : 'text-green-400')}>{gain < 0 ? '' : '+'}{usd(gain)}</span>
                    </div>
                    <div className="mt-1 h-1.5 rounded bg-faint overflow-hidden">
                      <div className={clsx('h-full', gain < 0 ? 'bg-red-400' : 'bg-green-400')} style={{ width: `${(Math.abs(gain) / maxGain) * 100}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <p className="text-xs text-muted">
            All tax figures are estimates, not tax advice. Consult a tax professional before acting on them.
          </p>
        </>
      )}
    </div>
  )
}

function MiniStat({ label, value, tone }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted truncate mb-1">{label}</div>
      <div className={clsx('text-sm font-mono-tab font-semibold truncate', tone ?? 'text-fg')}>{value}</div>
    </div>
  )
}
