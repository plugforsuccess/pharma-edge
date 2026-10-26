// /charts/tape — the tape scan (owner, 2026-10-26: "Build"). Every liquid
// pre-revenue small cap the nightly scan covers (ticker_risks, scan = true),
// listed when both facts are lit: the stock has not held its last
// heavy-volume jump for 20+ sessions, and short interest is up 15%+ while
// the price is down 10%+ over the same window. Facts, dated and priced;
// no score, tier or verdict. The one performance line is the test's own
// reading of months with both facts (variants.md, 2026-10-26).
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, ChevronRight } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { holdingRiskFacts, riskRows, cashLine, BOTH_LIT } from '../utils/holdingRisks'

const day = (t) => (t ? new Date(`${t}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '')

export default function TapeScan() {
  const [rows, setRows] = useState(undefined)
  const [showOne, setShowOne] = useState(false)
  useEffect(() => {
    let cancelled = false
    supabase.from('ticker_risks').select('ticker, as_of, catalyst, shorts, runway').eq('scan', true).limit(2000)
      .then(({ data, error }) => { if (!cancelled) setRows(error ? null : data ?? []) })
    return () => { cancelled = true }
  }, [])
  const { both, one, asOf } = useMemo(() => {
    const scored = (rows ?? []).map((r) => ({ r, n: holdingRiskFacts(r).length }))
    const by = (x) => (x.r.catalyst?.sessionsBelow ?? 0)
    return {
      both: scored.filter((x) => x.n === 2).sort((a, b) => by(b) - by(a)).map((x) => x.r),
      one: scored.filter((x) => x.n === 1).sort((a, b) => by(b) - by(a)).map((x) => x.r),
      asOf: rows?.[0]?.as_of,
    }
  }, [rows])

  return (
    <div className="max-w-md mx-auto px-4 pt-4 pb-28">
      <Link to="/charts" className="min-h-[44px] -ml-1 inline-flex items-center gap-1.5 text-sm text-subtle hover:text-fg">
        <ArrowLeft size={16} aria-hidden /> Leaders
      </Link>
      <div className="mt-1 text-[11px] text-muted">{asOf ? `As of ${day(asOf)} close` : 'Updated after each close'}{rows?.length ? ` · ${rows.length} pre-revenue stocks scanned` : ''}</div>
      <h1 className="mt-0.5 text-[28px] leading-9 font-semibold tracking-tight">Stopped believing</h1>
      <p className="text-sm text-subtle">Small companies with no revenue yet whose last big jump has not held for 20+ sessions, while short interest rose and the price fell. Two facts from the tape, nothing more.</p>

      {rows === undefined && <div className="mt-6 text-sm text-muted">Loading…</div>}
      {rows === null && <div className="mt-6 text-sm text-red-300">Couldn't load the scan.</div>}
      {rows?.length === 0 && <div className="mt-6 text-sm text-muted">The scan hasn't run yet. It runs after each close.</div>}

      {both.length > 0 && (
        <section className="mt-5">
          <div className="text-[11px] uppercase tracking-[0.12em] text-muted font-semibold">Both facts lit · {both.length}</div>
          <ul className="mt-2 divide-y divide-border border border-border rounded-2xl overflow-hidden bg-card">
            {both.map((r) => <Row key={r.ticker} r={r} />)}
          </ul>
          <p className="mt-2 text-[11px] text-muted">
            In the test behind these facts (12,094 stock-months, 2022–2026), a stock with both was {Math.round(Math.abs(BOTH_LIT.median) * 100)}% lower six months later at the median, and doubled one time in {Math.round(1 / BOTH_LIT.doubled)}. Both tails are fat; this is a watch list, not a forecast. Survivors only.
          </p>
        </section>
      )}
      {rows?.length > 0 && both.length === 0 && <div className="mt-6 text-sm text-subtle">No stock has both facts lit today.</div>}

      {one.length > 0 && (
        <section className="mt-6">
          <button type="button" onClick={() => setShowOne((v) => !v)} className="w-full min-h-[44px] flex items-center justify-between text-left">
            <span className="text-[11px] uppercase tracking-[0.12em] text-muted font-semibold">One fact lit · {one.length}</span>
            <span className="text-xs text-subtle">{showOne ? 'Hide' : 'Show'}</span>
          </button>
          {showOne && (
            <ul className="mt-2 divide-y divide-border border border-border rounded-2xl overflow-hidden bg-card">
              {one.map((r) => <Row key={r.ticker} r={r} />)}
            </ul>
          )}
        </section>
      )}
      <p className="mt-6 text-[11px] text-muted">Public float $100M–$2B at some mid-year since 2022, annual revenue under $25M or none, average daily dollar volume over $1M. Prices, FINRA short interest (twice a month, lagged) and SEC filings. General information, the same for every subscriber — not personalized investment advice.</p>
    </div>
  )
}

function Row({ r }) {
  const facts = riskRows(r)
  const cash = cashLine(r)
  return (
    <li>
      <Link to={`/charts/entry/${encodeURIComponent(r.ticker)}`} className="flex items-start gap-3 px-4 py-3 min-h-[44px]">
        <div className="w-14 shrink-0 text-base font-semibold text-fg">{r.ticker}</div>
        <div className="flex-1 min-w-0">
          {facts.map((f) => (
            <div key={f.key} className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-fg truncate">{f.label}</span>
              <span className="shrink-0 text-sm font-semibold font-mono-tab text-fg">{f.value}</span>
            </div>
          ))}
          {cash && <div className="mt-0.5 text-xs text-subtle truncate">{cash}</div>}
        </div>
        <ChevronRight size={14} className="mt-1.5 text-muted shrink-0" aria-hidden />
      </Link>
    </li>
  )
}
