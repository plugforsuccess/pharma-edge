import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, RefreshCw, Activity, Star, Lock } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useSubscription } from '../hooks/useSubscription'
import GexHeatmap from '../components/GexHeatmap'
import UpgradeNotice from '../components/UpgradeNotice'

// Curated ticker set — index ETFs and the most-liquid single names
// where dealer hedging flows actually matter, plus a few large-cap
// biotechs so the page stays connected to the original strategy.
// Keeping the list short on first ship; users can't add custom tickers
// from the UI yet (would need a saved-tickers table).
const TICKERS = [
  { symbol: 'SPY', label: 'S&P 500' },
  { symbol: 'QQQ', label: 'Nasdaq-100' },
  { symbol: 'IWM', label: 'Russell 2000' },
  { symbol: 'AAPL', label: 'Apple' },
  { symbol: 'NVDA', label: 'Nvidia' },
  { symbol: 'TSLA', label: 'Tesla' },
  { symbol: 'MSFT', label: 'Microsoft' },
  { symbol: 'AMD', label: 'AMD' },
  { symbol: 'AMZN', label: 'Amazon' },
  { symbol: 'META', label: 'Meta' },
  { symbol: 'GOOGL', label: 'Alphabet' },
  { symbol: 'LLY', label: 'Eli Lilly' },
  { symbol: 'NVO', label: 'Novo Nordisk' },
  { symbol: 'MRK', label: 'Merck' },
  { symbol: 'PFE', label: 'Pfizer' },
]

export default function Markets() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { isPro, limits } = useSubscription()
  const [ticker, setTicker] = useState(TICKERS[0].symbol)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  // User's watchlist tickers, shown as a separate section in the picker
  // so a biotech a user is tracking shows up here without needing to be
  // hardcoded into TICKERS.
  const [watchlist, setWatchlist] = useState([])

  // Free tier sees the first N curated tickers and no watchlist
  // section; pro sees everything. The Set drives a `gated` flag we
  // pass into each pill so the lock affordance is visible (better than
  // hiding the pills entirely — users should see what they'd unlock).
  const visibleCuratedTickers = useMemo(() => {
    if (isPro) return TICKERS
    return TICKERS.slice(0, limits.marketsTickerCap)
  }, [isPro, limits.marketsTickerCap])
  const gatedTickers = useMemo(() => {
    if (isPro) return new Set()
    return new Set(TICKERS.slice(limits.marketsTickerCap).map((t) => t.symbol))
  }, [isPro, limits.marketsTickerCap])

  useEffect(() => {
    if (!user) return
    let cancelled = false
    supabase
      .from('watchlist')
      .select('ticker')
      .eq('user_id', user.id)
      .then(({ data }) => {
        if (cancelled || !data) return
        const seen = new Set(TICKERS.map((t) => t.symbol))
        const unique = []
        for (const row of data) {
          const sym = String(row.ticker || '').toUpperCase()
          if (sym && !seen.has(sym)) {
            seen.add(sym)
            unique.push(sym)
          }
        }
        setWatchlist(unique)
      })
    return () => {
      cancelled = true
    }
  }, [user?.id])

  async function load(sym, { refresh = false } = {}) {
    setLoading(true)
    setError(null)
    setData(null)
    try {
      const { data: result, error: invokeErr } = await supabase.functions.invoke(
        'compute-gex',
        { body: { ticker: sym, refresh } },
      )
      if (invokeErr) {
        const parsed = await readErrorBody(invokeErr)
        throw Object.assign(
          new Error(parsed?.error || invokeErr.message || 'request failed'),
          { diagnostics: parsed?.diagnostics ?? null },
        )
      }
      if (!result?.success) {
        throw Object.assign(
          new Error(result?.error || 'compute-gex returned no data'),
          { diagnostics: result?.diagnostics ?? null },
        )
      }
      setData(result.data)
    } catch (err) {
      console.error('compute-gex error', err, err?.diagnostics)
      const diag = err?.diagnostics
      const diagText = Array.isArray(diag) && diag.length > 0
        ? '\n' + diag.map((d) => `  ${d.endpointTried} → ${d.status} (${d.bodyShape})`).join('\n')
        : ''
      setError((err.message || String(err)) + diagText)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load(ticker)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker])

  return (
    <div className="px-4 py-5 space-y-4 max-w-md mx-auto">
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate(-1)}
          className="p-2 -ml-2 text-subtle hover:text-fg"
          aria-label="Back"
        >
          <ArrowLeft size={20} />
        </button>
        <div className="flex-1">
          <h1 className="text-lg font-semibold leading-tight">Gamma Exposure</h1>
          <p className="text-xs text-subtle">
            Where dealer hedging flow concentrates by strike.
          </p>
        </div>
        <button
          onClick={() => load(ticker, { refresh: true })}
          disabled={loading}
          className="p-2 text-subtle hover:text-fg disabled:opacity-50"
          aria-label="Refresh"
        >
          <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Ticker picker — horizontal scroll keeps the grid mobile-friendly.
          Watchlist tickers come first (with a star) so the user's own picks
          are reachable without scrolling past the curated list. Pro-only
          tickers render with a lock affordance so free users see what
          they'd unlock rather than the list silently being shorter. */}
      <div className="-mx-4 px-4 overflow-x-auto">
        <div className="flex gap-2 pb-1">
          {isPro &&
            watchlist.map((sym) => (
              <button
                key={`wl-${sym}`}
                onClick={() => setTicker(sym)}
                className={
                  'shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-full border text-xs font-medium transition ' +
                  (ticker === sym
                    ? 'bg-brand text-bg border-brand'
                    : 'bg-card text-fg border-amber-400/40 hover:border-amber-400/70')
                }
              >
                <Star size={11} className="fill-current" />
                {sym}
              </button>
            ))}
          {isPro && watchlist.length > 0 && (
            <div className="shrink-0 w-px bg-border mx-1" aria-hidden />
          )}
          {(isPro ? TICKERS : [...visibleCuratedTickers, ...TICKERS.slice(limits.marketsTickerCap)]).map((t) => {
            const gated = gatedTickers.has(t.symbol)
            const active = ticker === t.symbol
            return (
              <button
                key={t.symbol}
                onClick={() => (gated ? navigate('/settings') : setTicker(t.symbol))}
                className={
                  'shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-full border text-xs font-medium transition ' +
                  (active
                    ? 'bg-brand text-bg border-brand'
                    : gated
                      ? 'bg-card text-muted border-border hover:text-subtle'
                      : 'bg-card text-subtle border-border hover:text-fg hover:border-border-hover')
                }
                title={gated ? 'Upgrade to Pro to unlock' : t.label}
              >
                {gated && <Lock size={10} />}
                {t.symbol}
              </button>
            )
          })}
        </div>
      </div>

      {!isPro && (
        <UpgradeNotice
          message={`Free tier: ${limits.marketsTickerCap} tickers. Pro unlocks the full list, watchlist tickers, scanner queue, and broker execution.`}
          cta="Go Pro"
        />
      )}

      {/* Header stats */}
      {data && (
        <div className="bg-card border border-border rounded-xl p-4 space-y-3">
          <div className="flex items-baseline justify-between">
            <div>
              <div className="text-2xl font-display tracking-tight">
                {data.ticker}
              </div>
              <div className="text-xs text-subtle">
                exp {data.expiration} · {data.days_to_expiration}d
                {data.from_cache && (
                  <span className="ml-2 text-muted">
                    · cached {formatCacheAge(data.cache_age_ms)} ago
                  </span>
                )}
              </div>
            </div>
            <div className="text-right">
              <div className="text-xl font-mono-tab tabular-nums">
                ${formatNumber(data.spot)}
              </div>
              <div className="text-[10px] uppercase tracking-wider text-subtle">
                spot
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 text-xs">
            <Stat
              label="Net GEX"
              value={formatGex(data.total_gex)}
              tone={data.total_gex >= 0 ? 'pos' : 'neg'}
            />
            <Stat
              label="Flip"
              value={
                data.zero_gamma_strike != null
                  ? `$${formatNumber(data.zero_gamma_strike)}`
                  : '—'
              }
              tone="neutral"
            />
            <Stat
              label="Largest call"
              value={`$${formatNumber(data.largest_positive_strike)}`}
              tone="pos"
            />
          </div>
        </div>
      )}

      {/* Heatmap card */}
      <div className="bg-card border border-border rounded-xl p-4 min-h-[280px]">
        <div className="flex items-center gap-2 mb-3">
          <Activity size={14} className="text-brand" />
          <h2 className="text-sm font-semibold">GEX by strike</h2>
        </div>

        {loading && (
          <div className="text-center py-8 text-subtle text-sm">
            Computing gamma exposure for {ticker}…
          </div>
        )}

        {!loading && error && (
          <div className="text-sm">
            <div className="text-crimson font-medium mb-1">
              Couldn't compute GEX.
            </div>
            <div className="text-subtle whitespace-pre-line font-mono text-[10px] leading-relaxed">
              {error}
            </div>
            <button
              onClick={() => load(ticker, { refresh: true })}
              className="mt-3 text-xs underline text-fg"
            >
              Try again
            </button>
          </div>
        )}

        {!loading && !error && data && <GexHeatmap data={data} />}
      </div>

      <p className="text-[10px] text-muted leading-relaxed px-1">
        Self-computed from Tastytrade option chains using Black-Scholes
        gamma at the front-month expiry. Convention: dealers are net short
        calls / long puts to retail, so call-side OI shows positive (green)
        and put-side OI shows negative (red).
      </p>
    </div>
  )
}

function Stat({ label, value, tone }) {
  const toneClass =
    tone === 'pos'
      ? 'text-green-400'
      : tone === 'neg'
        ? 'text-red-400'
        : 'text-fg'
  return (
    <div className="bg-bg-elev border border-border rounded-lg px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted">
        {label}
      </div>
      <div
        className={`font-mono-tab tabular-nums text-sm font-medium ${toneClass}`}
      >
        {value}
      </div>
    </div>
  )
}

function formatNumber(v) {
  if (v == null) return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return n.toFixed(2)
}

function formatCacheAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'just now'
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.round(sec / 60)
  return `${min}m`
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

// supabase-js wraps non-2xx responses in a generic FunctionsHttpError;
// the actual error body lives on `context`. We return the parsed body
// (or null) so the caller can read diagnostics fields too.
async function readErrorBody(invokeErr) {
  try {
    const ctx = invokeErr?.context
    if (ctx && typeof ctx.json === 'function') {
      return await ctx.json()
    }
    if (ctx && typeof ctx.text === 'function') {
      const text = await ctx.text()
      try { return JSON.parse(text) } catch { return { error: text } }
    }
  } catch {
    /* ignore */
  }
  return null
}
