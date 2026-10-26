// /charts/tape — the tape scan (owner, 2026-10-26: "Build"; then "a bunch
// of gray and white text … not signaling anything"). Every liquid
// pre-revenue small cap the nightly scan covers (ticker_risks, scan = true),
// listed when both facts are lit: the stock has not held its last
// heavy-volume jump for 20+ sessions, and short interest is up 15%+ while
// the price is down 10%+ over the same window. Rows signal with the app's
// own grammar — a 3-month sparkline, a red price pill, a filled bar for how
// long it has sat below the jump, an amber shorts chip — and still carry no
// score, tier or verdict. The one performance line is the test's reading
// of months with both facts (variants.md, 2026-10-26).
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { ArrowLeft, ChevronRight } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { holdingRiskFacts, BOTH_LIT } from '../utils/holdingRisks'
import { Sparkline } from '../components/ConfluenceLeaders'

const day = (t) => (t ? new Date(`${t}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '')
const money = (x) => { const a = Math.abs(x); return a >= 1e9 ? `$${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `$${Math.round(a / 1e6)}M` : `$${Math.round(a / 1e3)}K` }
const price = (x) => `$${x >= 100 ? x.toFixed(0) : x.toFixed(2)}`
const signed = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(0)}%`
const BAR_MAX = 120 // sessions below the jump that fill the bar

export default function TapeScan() {
  const [rows, setRows] = useState(undefined)
  const [showOne, setShowOne] = useState(false)
  useEffect(() => {
    let cancelled = false
    supabase.from('ticker_risks').select('ticker, as_of, catalyst, shorts, runway, spark').eq('scan', true).limit(2000)
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
      <p className="text-sm text-subtle">Pre-revenue stocks whose last big jump didn't hold, while shorts piled in and the price fell.</p>

      {/* The legend is the grammar: what each colour means, once. */}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
        <span><span className="inline-block h-2 w-2 rounded-full bg-red-400 align-middle mr-1" />price since the jump</span>
        <span><span className="inline-block h-2 w-2 rounded-full bg-amber-400 align-middle mr-1" />shorts rising</span>
        <span><span className="inline-block h-2 w-5 rounded bg-red-400/70 align-middle mr-1" />sessions below the jump</span>
      </div>

      {rows === undefined && <div className="mt-6 text-sm text-muted">Loading…</div>}
      {rows === null && <div className="mt-6 text-sm text-red-300">Couldn't load the scan.</div>}
      {rows?.length === 0 && <div className="mt-6 text-sm text-muted">The scan hasn't run yet. It runs after each close.</div>}

      {both.length > 0 && (
        <section className="mt-5">
          <div className="flex items-baseline justify-between">
            <div className="text-[11px] uppercase tracking-[0.12em] text-muted font-semibold">Both facts lit</div>
            <div className="text-2xl font-semibold font-mono-tab text-red-300 leading-none">{both.length}</div>
          </div>
          <ul className="mt-2 space-y-2">
            {both.map((r) => <Row key={r.ticker} r={r} />)}
          </ul>
          <p className="mt-3 text-[11px] text-muted">
            In the test behind these facts (12,094 stock-months, 2022–2026), a stock with both was {Math.round(Math.abs(BOTH_LIT.median) * 100)}% lower six months later at the median — and doubled one time in {Math.round(1 / BOTH_LIT.doubled)}. Both tails are fat. A watch list, not a forecast. Survivors only.
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
          {showOne && <ul className="mt-2 space-y-2">{one.map((r) => <Row key={r.ticker} r={r} />)}</ul>}
        </section>
      )}
      <p className="mt-6 text-[11px] text-muted">Public float $100M–$2B at some mid-year since 2022, annual revenue under $25M or none, average daily dollar volume over $1M. Prices, FINRA short interest (twice a month, lagged) and SEC filings. General information, the same for every subscriber — not personalized investment advice.</p>
    </div>
  )
}

// One card per stock. Top line: ticker · sparkline · price-since-the-jump
// pill. Then the sessions bar (how long below the jump) and the shorts chip.
// Cash and burn in one muted line. Tap → the entry chart and its ledger.
function Row({ r }) {
  const c = r.catalyst, s = r.shorts, rw = r.runway
  const facts = new Set(holdingRiskFacts(r).map((f) => f.key.split(':')[0]))
  const sinceJump = c ? c.last / c.level - 1 : null
  const spark = Array.isArray(r.spark) && r.spark.length > 2 ? r.spark : null
  const up3m = spark ? spark[spark.length - 1] >= spark[0] : false
  const fill = c ? Math.min(1, c.sessionsBelow / BAR_MAX) : 0
  return (
    <li>
      <Link to={`/charts/entry/${encodeURIComponent(r.ticker)}`} className="block bg-card border border-border rounded-2xl px-4 py-3.5 min-h-[44px] hover:border-amber-400/30 transition">
        <div className="flex items-center gap-3">
          <div className="w-16 shrink-0">
            <div className="text-lg font-semibold text-fg leading-tight">{r.ticker}</div>
            {c && <div className="text-[11px] text-muted font-mono-tab">{price(c.last)}</div>}
          </div>
          {spark ? <Sparkline values={spark} className={clsx('flex-1 min-w-0 h-8', up3m ? 'text-green-400' : 'text-red-400')} /> : <div className="flex-1" />}
          {sinceJump != null && (
            <div className={clsx('shrink-0 rounded-full px-2.5 py-1 text-sm font-semibold font-mono-tab', sinceJump < 0 ? 'bg-red-500/15 text-red-300' : 'bg-green-500/15 text-green-300')}>
              {signed(sinceJump)}
            </div>
          )}
          <ChevronRight size={14} className="text-muted shrink-0 -mr-1" aria-hidden />
        </div>
        {facts.has('catalyst') && c && (
          <div className="mt-3">
            <div className="flex items-baseline justify-between text-xs">
              <span className="text-subtle">Below its {day(c.event)} jump ({price(c.level)})</span>
              <span className="font-semibold font-mono-tab text-red-300">{c.sessionsBelow} sessions</span>
            </div>
            <div className="mt-1 h-1.5 rounded bg-faint overflow-hidden">
              <div className="h-full bg-red-400/80" style={{ width: `${Math.max(6, fill * 100)}%` }} />
            </div>
          </div>
        )}
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {facts.has('shorts') && s && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-200">
              <span className="font-semibold font-mono-tab">Shorts {signed(s.siChange)}</span>
              <span className="text-amber-200/70">· {s.spanDays}d{s.siPct != null ? ` · ${(s.siPct * 100).toFixed(0)}% of shares` : ''}</span>
            </span>
          )}
          {s && facts.has('shorts') && (
            <span className="inline-flex items-center rounded-full bg-red-500/10 px-2.5 py-1 text-xs text-red-300 font-mono-tab">price {signed(s.priceChange)} same window</span>
          )}
        </div>
        {rw?.cash != null && (
          <div className="mt-2 text-[11px] text-muted font-mono-tab truncate">{money(rw.cash)} cash{rw.burn < 0 ? ` · ${money(rw.burn)}${rw.jv > 0 ? ` + ${money(rw.jv)} JV` : ''} a qtr` : ''}</div>
        )}
      </Link>
    </li>
  )
}
