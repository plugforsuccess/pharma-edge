import { useEffect, useMemo, useState } from 'react'
import { ArrowUpCircle, ArrowDownCircle, Flame, Filter } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useSubscription } from '../hooks/useSubscription'
import LiveDataStatus from '../components/LiveDataStatus'

// Options flow page — today's per-strike volume + premium + UOA
// (unusual options activity) across the full streamed universe.
//
// Data source: public.option_flow_daily, populated by the dxlink-worker
// via dxFeed Trade events. Empty until the worker is healthy and RTH
// is in session — we surface that state explicitly so users don't think
// the page is broken when it just hasn't seen prints yet.
//
// Two views (tabbed):
//   "All tickers" — cross-market top flow, sorted by volume
//   "By ticker"   — type a ticker → see only that ticker's flow

const FILTER_TABS = ['All tickers', 'Calls only', 'Puts only', 'Notable (UOA)']

export default function Flow() {
  const { isPro } = useSubscription()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [filter, setFilter] = useState('All tickers')
  const [tickerFilter, setTickerFilter] = useState('')
  const [lastFetched, setLastFetched] = useState(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const today = nyToday()
      let q = supabase
        .from('option_flow_daily')
        .select(
          'ticker, strike, expiration_date, option_type, total_volume, total_premium, print_count, biggest_print_size, biggest_print_at',
        )
        .eq('trade_date', today)
        .order('total_volume', { ascending: false })
        .limit(200)
      if (tickerFilter.trim()) {
        q = q.eq('ticker', tickerFilter.trim().toUpperCase())
      }
      const { data, error: err } = await q
      if (err) throw err
      setRows(data ?? [])
      setLastFetched(new Date())
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickerFilter])

  const filtered = useMemo(() => {
    if (filter === 'Calls only') return rows.filter((r) => r.option_type === 'C')
    if (filter === 'Puts only') return rows.filter((r) => r.option_type === 'P')
    if (filter === 'Notable (UOA)') {
      // We don't have OI in this table directly; approximate UOA as
      // strikes with a single biggest_print >= 500 contracts OR total
      // volume >= 5,000 + above-average premium.
      return rows.filter((r) =>
        (r.biggest_print_size && Number(r.biggest_print_size) >= 500) ||
        (Number(r.total_volume) >= 5000),
      )
    }
    return rows
  }, [rows, filter])

  if (!isPro) {
    return (
      <div className="px-4 lg:px-6 py-5 max-w-md mx-auto lg:max-w-2xl">
        <div className="bg-card border border-amber-400/20 rounded-xl p-4 space-y-2">
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <Flame size={16} className="text-amber-400" />
            Options Flow
          </h1>
          <p className="text-xs text-subtle leading-relaxed">
            Real-time options prints across the streamed universe — top
            volume by strike, biggest single prints, and unusual options
            activity (UOA) detection. Pro feature.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="px-4 lg:px-6 py-5 max-w-md mx-auto lg:max-w-6xl space-y-4">
      <div>
        <h1 className="text-lg lg:text-2xl font-semibold leading-tight flex items-center gap-2">
          <Flame size={16} className="text-amber-400" />
          Options Flow
        </h1>
        <p className="text-xs lg:text-sm text-subtle">
          Today's prints across the streamed universe.
          {lastFetched && (
            <span className="text-muted ml-1">
              · {lastFetched.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
            </span>
          )}
        </p>
      </div>

      <LiveDataStatus />

      <div className="flex gap-2">
        <input
          type="text"
          value={tickerFilter}
          onChange={(e) => setTickerFilter(e.target.value.toUpperCase())}
          placeholder="Filter by ticker (e.g. SPY)"
          className="flex-1 bg-card border border-border rounded-lg px-3 py-1.5 text-sm placeholder:text-muted focus:outline-none focus:border-amber-400/40"
        />
        <button
          onClick={load}
          disabled={loading}
          className="px-3 py-1.5 bg-card border border-border rounded-lg text-xs text-subtle hover:text-fg disabled:opacity-50"
        >
          {loading ? '…' : 'Refresh'}
        </button>
      </div>

      {/* Filter chips */}
      <div className="-mx-4 px-4 overflow-x-auto">
        <div className="flex gap-2 pb-1">
          {FILTER_TABS.map((t) => (
            <button
              key={t}
              onClick={() => setFilter(t)}
              className={
                'shrink-0 px-3 py-1 rounded-full border text-xs font-medium transition ' +
                (filter === t
                  ? 'bg-amber-400 text-bg border-amber-400'
                  : 'bg-card text-subtle border-border hover:text-fg')
              }
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="bg-red-950/30 border border-red-900/50 text-red-400 text-xs rounded p-3">
          Couldn't load flow: {error}
        </div>
      )}

      {loading && (
        <div className="bg-card border border-border rounded-xl p-3 space-y-2 animate-pulse" aria-label="Loading flow">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="h-3 w-16 rounded bg-white/[0.04]" />
              <div className="h-2 rounded bg-white/[0.04]" style={{ width: `${40 + ((i * 9) % 40)}%` }} />
              <div className="h-3 w-10 rounded bg-white/[0.04] ml-auto" />
            </div>
          ))}
        </div>
      )}

      {!loading && !error && rows.length === 0 && (
        <div className="bg-card border border-border rounded-xl p-6 text-center space-y-2">
          <Filter size={20} className="text-muted mx-auto" />
          <p className="text-sm text-fg font-medium">No flow captured today</p>
          <p className="text-xs text-subtle leading-relaxed">
            Either US markets are closed, or the dxlink-worker hasn't
            seen prints yet for {tickerFilter ? tickerFilter : 'any tracked ticker'}.
            Worker only captures Trade events during regular trading hours
            (M-F, 9:30am-4pm ET).
          </p>
        </div>
      )}

      {!loading && !error && filtered.length > 0 && (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 px-3 py-2 text-[9px] uppercase tracking-wider text-muted border-b border-border">
            <div>Symbol / Exp</div>
            <div className="text-right">Vol</div>
            <div className="text-right">Premium</div>
            <div className="text-right w-10">Biggest</div>
          </div>
          <div className="divide-y divide-border">
            {filtered.slice(0, 60).map((r, i) => (
              <FlowRow key={`${r.ticker}-${r.strike}-${r.expiration_date}-${r.option_type}-${i}`} r={r} />
            ))}
          </div>
        </div>
      )}

      <p className="text-[10px] text-muted leading-relaxed px-1">
        Volume + premium are running totals since the open. Premium = price ×
        size × 100 per print, summed. Biggest print flagged when ≥ 100
        contracts. UOA (unusual activity) is approximated as strikes with
        single prints ≥ 500 contracts or total volume ≥ 5K. Without standing
        OI in this view we can't compute exact vol/OI ratios — the
        Suggested Plays prompt sees those numbers and uses them in
        Claude's reasoning.
      </p>
    </div>
  )
}

function FlowRow({ r }) {
  const isCall = r.option_type === 'C'
  const Icon = isCall ? ArrowUpCircle : ArrowDownCircle
  const tone = isCall ? 'text-green-400' : 'text-crimson'
  return (
    <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 px-3 py-2 text-xs items-center">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <Icon size={11} className={tone} />
          <span className="font-mono-tab font-semibold text-fg">
            {r.ticker} ${formatStrike(r.strike)}
          </span>
        </div>
        <div className="text-[10px] text-muted">{r.expiration_date}</div>
      </div>
      <div className="text-right font-mono-tab tabular-nums text-fg">
        {Number(r.total_volume).toLocaleString()}
      </div>
      <div className="text-right font-mono-tab tabular-nums text-subtle">
        ${formatPremium(r.total_premium)}
      </div>
      <div className="text-right font-mono-tab tabular-nums text-muted w-10">
        {r.biggest_print_size ? Number(r.biggest_print_size).toLocaleString() : '—'}
      </div>
    </div>
  )
}

function nyToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

function formatStrike(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return n >= 1000 ? n.toFixed(0) : n.toFixed(1)
}

function formatPremium(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`
  return n.toFixed(0)
}
