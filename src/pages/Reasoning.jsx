import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  Activity,
  ChevronDown,
  RefreshCw,
  Sparkles,
  ArrowLeft,
} from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { HOT_TICKERS } from '../lib/tickerUniverse'

// /reasoning — the always-on inference surface.
//
// Cheap deterministic context (regime, walls, flip, expected move,
// pinning probability) refreshes every 60s with NO LLM call — just a
// compute-gex matrix fetch keyed off the existing dxlink cache. The
// LLM-driven Suggested Plays still requires an explicit user click
// (cost + drift control, see the design doc).
//
// History panel reads from reasoning_history — every successful
// suggest-plays call lands a row there (server-side, in the edge fn
// itself), so we can show regime drift + confidence trail across the
// day without any new tracking code on the client.

const POLL_MS = 60_000
const MATRIX_OPTS = {
  maxExpirations: 4,
  maxStrikes: 24,
  strikeWindowPct: 0.05,
}

export default function Reasoning() {
  const { user } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const [ticker, setTicker] = useState(() => (searchParams.get('t') || 'SPY').toUpperCase())
  const [matrix, setMatrix] = useState(null)
  const [matrixError, setMatrixError] = useState(null)
  const [matrixAt, setMatrixAt] = useState(null)
  const [matrixLoading, setMatrixLoading] = useState(false)
  const [plays, setPlays] = useState(null)
  const [playsLoading, setPlaysLoading] = useState(false)
  const [playsError, setPlaysError] = useState(null)
  const [history, setHistory] = useState([])
  const pollRef = useRef(null)

  // Persist ticker selection in the URL so deep-links work and so
  // browser back/forward jumps between tickers cleanly.
  useEffect(() => {
    if (searchParams.get('t')?.toUpperCase() !== ticker) {
      setSearchParams({ t: ticker }, { replace: true })
    }
  }, [ticker, searchParams, setSearchParams])

  // Cheap context fetch — compute-gex matrix mode, no LLM. Runs on
  // mount, on ticker change, and every POLL_MS while the tab is open.
  async function fetchContext(forceRefresh = false) {
    setMatrixLoading(true)
    try {
      const { data: result, error: invokeErr } = await supabase.functions.invoke('compute-gex', {
        body: {
          ticker,
          refresh: forceRefresh,
          matrix: true,
          matrix_max_expirations: MATRIX_OPTS.maxExpirations,
          matrix_max_strikes: MATRIX_OPTS.maxStrikes,
          matrix_strike_window_pct: MATRIX_OPTS.strikeWindowPct,
        },
      })
      if (invokeErr) throw new Error(invokeErr.message || 'compute-gex failed')
      if (!result?.success) throw new Error(result?.error || 'compute-gex returned no data')
      setMatrix(result.data)
      setMatrixError(null)
      setMatrixAt(Date.now())
    } catch (err) {
      setMatrixError(err.message || String(err))
    } finally {
      setMatrixLoading(false)
    }
  }

  // History fetch — last 20 reasoning_history rows for this user ×
  // ticker. RLS pins it to the calling user; we filter by ticker
  // client-side here so switching tickers doesn't refetch.
  async function fetchHistory() {
    if (!user?.id) return
    const { data } = await supabase
      .from('reasoning_history')
      .select('id, computed_at, regime, regime_explanation, spot, net_gex, expected_move, pinning_probability, call_wall, put_wall, flip_strike, play_count, confidence')
      .eq('user_id', user.id)
      .eq('ticker', ticker)
      .order('computed_at', { ascending: false })
      .limit(20)
    if (data) setHistory(data)
  }

  useEffect(() => {
    fetchContext()
    fetchHistory()
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(() => {
      fetchContext()
    }, POLL_MS)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker, user?.id])

  async function handleReanalyze() {
    setPlaysLoading(true)
    setPlaysError(null)
    try {
      const { data: result, error: invokeErr } = await supabase.functions.invoke('suggest-plays', {
        body: { ticker, refresh: true },
      })
      if (invokeErr) throw new Error(invokeErr.message || 'suggest-plays failed')
      if (!result?.success) throw new Error(result?.error || 'suggest-plays returned no data')
      setPlays(result.data)
      // History row was logged server-side — pull the updated list.
      fetchHistory()
    } catch (err) {
      setPlaysError(err.message || String(err))
    } finally {
      setPlaysLoading(false)
    }
  }

  const regime = matrix?.largest && matrix?.net_gex != null
    ? deriveRegime(matrix.spot, matrix.zero_gamma_strike, matrix.net_gex)
    : null

  return (
    <div className="px-4 py-4 lg:px-8 lg:py-6 max-w-5xl lg:mx-auto space-y-4">
      <div className="flex items-center gap-3">
        <Link to="/markets" className="lg:hidden p-2 -ml-2 text-subtle hover:text-fg" aria-label="Back to Gamma Map">
          <ArrowLeft size={20} />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <Sparkles size={16} className="text-amber-400" />
            <h1 className="text-lg lg:text-2xl font-semibold leading-tight">Reasoning</h1>
            <span className="text-[10px] text-muted uppercase tracking-wider">Live inference</span>
          </div>
          <p className="text-xs lg:text-sm text-subtle">
            What the engine thinks of the tape, refreshed every minute.
          </p>
        </div>
        <TickerPicker ticker={ticker} onChange={setTicker} />
      </div>

      {matrixError && !matrix && (
        <div className="bg-red-950/30 border border-red-900/40 rounded-xl p-4 text-sm text-red-400">
          Couldn't load context: {matrixError}
          <button
            onClick={() => fetchContext(true)}
            className="ml-3 underline text-red-300 text-xs"
          >
            Retry
          </button>
        </div>
      )}

      {/* Top regime banner — the headline answer to "what's going on?" */}
      {matrix && regime && (
        <div className="bg-card border border-border rounded-xl p-4 lg:p-5 space-y-3">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <div className="flex items-baseline gap-3">
              <RegimeBadge regime={regime.code} />
              <span className="text-fg text-sm font-semibold">{regime.label}</span>
            </div>
            <RefreshTimer lastAt={matrixAt} pollMs={POLL_MS} loading={matrixLoading} onRefresh={() => fetchContext(true)} />
          </div>
          <p className="text-sm text-subtle leading-relaxed">{regime.explanation}</p>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
            <Metric label="Spot" value={`$${formatNum(matrix.spot)}`} tone="amber" />
            <Metric label="Net GEX" value={formatGex(matrix.net_gex)} tone={matrix.net_gex >= 0 ? 'green' : 'red'} />
            <Metric
              label="Expected ±"
              value={matrix.expected_move ? `$${matrix.expected_move.toFixed(2)} (${(matrix.expected_move_pct * 100).toFixed(1)}%)` : '—'}
              tone="amber"
            />
            <Metric
              label="Pin prob."
              value={matrix.pinning_probability != null ? `${Math.round(matrix.pinning_probability * 100)}%` : '—'}
              tone={matrix.pinning_probability >= 0.6 ? 'green' : matrix.pinning_probability >= 0.3 ? 'amber' : 'muted'}
            />
            <Metric
              label="Wall"
              value={matrix.largest ? `$${formatNum(matrix.largest.strike)}` : '—'}
              tone={matrix.largest && matrix.largest.gex_net >= 0 ? 'green' : 'red'}
            />
          </div>
        </div>
      )}

      {/* Plays panel — LLM-gated. Manual click to re-analyze. */}
      <div className="bg-card border border-border rounded-xl p-4 lg:p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Activity size={14} className="text-brand" />
            Suggested Plays
          </h2>
          <button
            onClick={handleReanalyze}
            disabled={playsLoading}
            className={clsx(
              'tap-spring inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border transition',
              playsLoading
                ? 'border-border text-muted'
                : 'border-amber-400/50 text-amber-400 hover:bg-amber-400/10',
            )}
          >
            <RefreshCw size={12} className={playsLoading ? 'animate-spin' : ''} />
            {playsLoading ? 'Thinking…' : plays ? 'Re-analyze' : 'Analyze plays'}
          </button>
        </div>
        {playsError && (
          <p className="text-xs text-crimson">Couldn't analyze: {playsError}</p>
        )}
        {!plays && !playsLoading && !playsError && (
          <p className="text-xs text-subtle leading-relaxed">
            Tap <strong className="text-amber-400">Analyze plays</strong> to have the engine
            propose 0–3 spread setups based on the current regime + flow. Each
            successful run is logged below.
          </p>
        )}
        {plays && (
          <div className="space-y-2">
            <p className="text-xs text-subtle">
              <span className="text-fg font-semibold">{plays.regime_explanation}</span>
            </p>
            {plays.plays?.length === 0 && (
              <p className="text-xs text-muted italic">No high-conviction setups in this regime — the engine declined to pad.</p>
            )}
            {plays.plays?.map((p, i) => (
              <PlayCard key={i} play={p} />
            ))}
          </div>
        )}
      </div>

      {/* History panel — regime + confidence drift across recent
          evaluations. Reads from reasoning_history (RLS-pinned). */}
      <div className="bg-card border border-border rounded-xl p-4 lg:p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">History</h2>
          <span className="text-[10px] text-muted uppercase tracking-wider">
            Last {history.length} for {ticker}
          </span>
        </div>
        {history.length === 0 ? (
          <p className="text-xs text-muted italic">No prior evaluations yet — analyze plays to start the trail.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {history.map((row) => (
              <HistoryRow key={row.id} row={row} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function RegimeBadge({ regime }) {
  const map = {
    A: { bg: 'bg-green-950/40', border: 'border-green-800/60', text: 'text-green-400', label: 'Regime A' },
    B: { bg: 'bg-red-950/40', border: 'border-red-800/60', text: 'text-red-400', label: 'Regime B' },
    mixed: { bg: 'bg-amber-950/40', border: 'border-amber-800/60', text: 'text-amber-400', label: 'Mixed' },
  }
  const t = map[regime] || map.mixed
  return (
    <span className={clsx('inline-flex items-center px-2 py-0.5 rounded border text-xs font-bold uppercase tracking-wider', t.bg, t.border, t.text)}>
      {t.label}
    </span>
  )
}

function Metric({ label, value, tone = 'muted' }) {
  const toneClass = ({
    green: 'text-green-400',
    red: 'text-red-400',
    amber: 'text-amber-400',
    muted: 'text-subtle',
  }[tone]) || 'text-subtle'
  return (
    <div className="bg-bg border border-border rounded-lg px-3 py-2 flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-muted">{label}</span>
      <span className={'font-mono-tab tabular-nums text-sm font-semibold ' + toneClass}>
        {value}
      </span>
    </div>
  )
}

function RefreshTimer({ lastAt, pollMs, loading, onRefresh }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  if (!lastAt) return null
  const ageSec = Math.max(0, Math.round((now - lastAt) / 1000))
  const nextSec = Math.max(0, Math.round((pollMs - (now - lastAt)) / 1000))
  return (
    <button
      type="button"
      onClick={onRefresh}
      disabled={loading}
      className="text-[10px] text-muted uppercase tracking-wider inline-flex items-center gap-1.5 hover:text-fg"
      title="Force refresh"
    >
      <RefreshCw size={10} className={loading ? 'animate-spin' : ''} />
      <span>updated {ageSec}s ago · next in {nextSec}s</span>
    </button>
  )
}

function PlayCard({ play }) {
  const popPct = play.entry_pop_bp != null ? (play.entry_pop_bp / 100).toFixed(0) : null
  const evPct = play.ev_edge_bp != null ? (play.ev_edge_bp / 100).toFixed(1) : null
  return (
    <div className="bg-bg border border-border rounded-lg p-3 space-y-2">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <div className="text-sm font-semibold text-fg">
          {play.strategy} · {play.long_strike}/{play.short_strike}
        </div>
        <div className="text-xs text-subtle font-mono-tab">
          {play.expiration} · {play.dte}DTE · R/R {Number(play.risk_reward).toFixed(2)}
        </div>
      </div>
      <p className="text-xs text-subtle leading-relaxed">{play.market_view}</p>
      <p className="text-xs text-muted leading-relaxed italic">{play.rationale}</p>
      <div className="flex items-center gap-3 text-[10px] uppercase tracking-wider">
        {popPct != null && (
          <span className="text-amber-400">PoP {popPct}%</span>
        )}
        {evPct != null && (
          <span className={Number(play.ev_edge_bp) >= 0 ? 'text-green-400' : 'text-red-400'}>
            EV {Number(play.ev_edge_bp) >= 0 ? '+' : ''}{evPct}pp
          </span>
        )}
        {play.gamma_rolloff_risk && (
          <span className="text-yellow-400">⚠ rolloff risk</span>
        )}
      </div>
    </div>
  )
}

function HistoryRow({ row }) {
  const t = new Date(row.computed_at)
  const time = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const conf = row.confidence != null ? Math.round(row.confidence * 100) : null
  return (
    <li className="py-2 flex items-baseline gap-3 text-xs">
      <span className="font-mono-tab text-muted shrink-0 w-12">{time}</span>
      <RegimeBadge regime={row.regime} />
      <span className="flex-1 text-subtle truncate" title={row.regime_explanation}>
        {row.regime_explanation || '—'}
      </span>
      <span className="text-muted shrink-0 font-mono-tab">{row.play_count}p</span>
      {conf != null && (
        <span className={clsx(
          'shrink-0 font-mono-tab tabular-nums',
          conf >= 65 ? 'text-green-400' : conf >= 45 ? 'text-amber-400' : 'text-red-400',
        )}>
          {conf}%
        </span>
      )}
    </li>
  )
}

function TickerPicker({ ticker, onChange }) {
  const [open, setOpen] = useState(false)
  const universe = useMemo(() => HOT_TICKERS.slice(0, 20), [])
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-card border border-border text-sm font-semibold hover:border-amber-400/40"
      >
        {ticker}
        <ChevronDown size={14} className="text-subtle" />
      </button>
      {open && (
        <div className="absolute right-0 mt-1 z-30 bg-card border border-border rounded-lg shadow-lg p-2 w-32 max-h-72 overflow-y-auto">
          {universe.map((sym) => (
            <button
              key={sym}
              onClick={() => {
                onChange(sym)
                setOpen(false)
              }}
              className={clsx(
                'block w-full text-left px-2 py-1 rounded text-xs',
                sym === ticker ? 'bg-amber-400/10 text-amber-400' : 'text-subtle hover:bg-bg-elev',
              )}
            >
              {sym}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// Same A/B/mixed taxonomy the suggest-plays prompt + Glossary use.
// We reproduce the regime decision deterministically here so the
// banner can render without waiting on an LLM call.
function deriveRegime(spot, flip, netGex) {
  if (spot == null || netGex == null) {
    return { code: 'mixed', label: 'Indeterminate', explanation: 'Insufficient data to classify regime.' }
  }
  const aboveFlip = flip == null || spot >= flip
  const positiveGex = netGex >= 0
  if (aboveFlip && positiveGex) {
    return {
      code: 'A',
      label: 'Positive Gamma · Range-Bound',
      explanation: 'Spot above the flip, dealers long gamma → they sell rallies and buy dips. Vol-suppressed regime favors pin trades, short premium, and breakouts AT the call wall.',
    }
  }
  if (!aboveFlip && !positiveGex) {
    return {
      code: 'B',
      label: 'Negative Gamma · Trending',
      explanation: 'Spot below the flip, dealers short gamma → they buy rallies and sell dips. Vol-amplifying regime favors long premium, breakdown puts, and vol-expansion plays.',
    }
  }
  return {
    code: 'mixed',
    label: 'Transition',
    explanation: 'Spot and net GEX disagree on regime. Treat as a transition signal; reduce conviction or wait for the new regime to settle.',
  }
}

function formatNum(v) {
  if (v == null) return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return n.toFixed(2)
}

function formatGex(v) {
  if (v == null) return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  const sign = n >= 0 ? '+' : '−'
  const abs = Math.abs(n)
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`
  return `${sign}$${abs.toFixed(0)}`
}
