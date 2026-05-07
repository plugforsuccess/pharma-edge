import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, RefreshCw, Activity, Star, Lock, ChevronDown, Clock, BookOpen, Search } from 'lucide-react'
import clsx from 'clsx'
import { isWithinRth } from '../utils/marketHours'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useSubscription } from '../hooks/useSubscription'
import { HOT_TICKERS, TICKER_UNIVERSE } from '../lib/tickerUniverse'
import GexMatrix from '../components/GexMatrix'
import TickerDrawer from '../components/TickerDrawer'
import ReplaySlider from '../components/ReplaySlider'
import SuggestedPlays from '../components/SuggestedPlays'
import TrinityView from '../components/TrinityView'
import UpgradeNotice from '../components/UpgradeNotice'
import LiveDataStatus from '../components/LiveDataStatus'

// HOT_TICKERS = the ~50 names the dxlink-worker actually streams
// (see dxlink-worker/src/tickers.ts). The pill row at the top of the
// page shows only these so users see the "live" subset at a glance.
// The drawer surfaces the full TICKER_UNIVERSE — S&P 500 + SOXX +
// memory names — for searching anything else (which falls back to
// Yahoo's 15-min delayed feed via compute-gex's fallback path).
const TICKERS = HOT_TICKERS

// Single matrix shape — wide enough to expose ~2 weeks of expirations
// and meaningful walls (ATM ±7%). The user navigates further-out
// expirations by horizontal-scrolling/swiping the matrix itself
// instead of clicking a density toggle.
const MATRIX_OPTS = {
  maxExpirations: 10,
  maxStrikes: 50,
  strikeWindowPct: 0.07,
}

export default function Markets() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { isPro, limits } = useSubscription()
  // Persisted ticker — survives navigation away (e.g. user clicks
  // "Log Signal" on a suggested play, then back-navs here). Without
  // this we'd snap to TICKERS[0] and lose the user's place, which
  // also blanks SuggestedPlays since its localStorage cache is keyed
  // by ticker.
  const [ticker, setTicker] = useState(() => {
    if (typeof window === 'undefined') return TICKERS[0].symbol
    try {
      const saved = window.localStorage.getItem('pe_markets_ticker')
      if (saved && /^[A-Z][A-Z0-9.\-]{0,9}$/.test(saved)) return saved
    } catch { /* private mode */ }
    return TICKERS[0].symbol
  })
  useEffect(() => {
    if (typeof window === 'undefined' || !ticker) return
    try { window.localStorage.setItem('pe_markets_ticker', ticker) } catch { /* */ }
  }, [ticker])
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  // Internal view switcher: GEX (single-ticker matrix, default),
  // Trinity (3-ticker comparison), VEX (vega exposure — backend math
  // pending; tab is a teaser placeholder for now).
  const [view, setView] = useState('gex')
  // Replay mode: when active, the time slider feeds historical
  // snapshot payloads to the matrix instead of the live data fetched
  // by load(). Toggling off clears the snapshot and we go back to live.
  const [replayActive, setReplayActive] = useState(false)
  const [replaySnapshot, setReplaySnapshot] = useState(null)
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
        const unique = []
        const seen = new Set()
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

  // Toggle the current ticker's favorite status. Watchlist table is
  // RLS-scoped to user_id so any signed-in user can only touch their
  // own row. Optimistic update on success — keeps the star UI snappy
  // even on a slow connection. Silent failure on the network call;
  // refresh restores canonical state from the DB.
  async function toggleFavorite(sym) {
    if (!user || !sym) return
    const symbol = sym.toUpperCase()
    const isCurrentlyFav = watchlist.includes(symbol)
    if (isCurrentlyFav) {
      setWatchlist((cur) => cur.filter((t) => t !== symbol))
      await supabase
        .from('watchlist')
        .delete()
        .eq('user_id', user.id)
        .eq('ticker', symbol)
    } else {
      setWatchlist((cur) => [...cur, symbol])
      await supabase
        .from('watchlist')
        .insert({ user_id: user.id, ticker: symbol })
    }
  }

  async function load(sym, { refresh = false } = {}) {
    setLoading(true)
    setError(null)
    setData(null)
    try {
      // matrix:true asks compute-gex for the strikes×expirations grid
      // (Skylit-style heatmap) instead of the single-expiration shape.
      const body = {
        ticker: sym,
        refresh,
        matrix: true,
        matrix_max_expirations: MATRIX_OPTS.maxExpirations,
        matrix_max_strikes: MATRIX_OPTS.maxStrikes,
        matrix_strike_window_pct: MATRIX_OPTS.strikeWindowPct,
      }
      const { data: result, error: invokeErr } = await supabase.functions.invoke(
        'compute-gex',
        { body },
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
    <div className="px-4 lg:px-6 py-5 space-y-4 max-w-md mx-auto lg:max-w-7xl">
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate(-1)}
          className="lg:hidden p-2 -ml-2 text-subtle hover:text-fg"
          aria-label="Back"
        >
          <ArrowLeft size={20} />
        </button>
        <div className="flex-1">
          <h1 className="text-lg lg:text-2xl font-semibold leading-tight">Gamma Map</h1>
          <p className="text-xs lg:text-sm text-subtle">
            Where dealer hedging flow concentrates by strike.
          </p>
        </div>
        <button
          onClick={() => setReplayActive((v) => !v)}
          className={
            'p-2 transition ' +
            (replayActive
              ? 'text-amber-400'
              : 'text-subtle hover:text-fg')
          }
          aria-label="Replay mode"
          title="Replay today's GEX"
        >
          <Clock size={18} />
        </button>
        <button
          onClick={() => navigate('/glossary')}
          className="p-2 text-subtle hover:text-fg"
          aria-label="Glossary"
          title="GEX glossary"
        >
          <BookOpen size={18} />
        </button>
        <button
          onClick={() => load(ticker, { refresh: true })}
          disabled={loading}
          className="p-2 text-subtle hover:text-fg disabled:opacity-50"
          aria-label="Refresh"
        >
          <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <LiveDataStatus />

      {/* View tabs — switches between single-ticker matrix, 3-ticker
          comparison, and (placeholder) vega exposure. Trinity tab
          hides the ticker picker since it has its own per-column
          tickers. VEX is a stub until the Black-Scholes vega path
          ships in the next push. */}
      <div className="flex gap-1 border border-border rounded-lg p-1 bg-card">
        <TabButton active={view === 'gex'} onClick={() => setView('gex')}>
          GEX
        </TabButton>
        <TabButton active={view === 'trinity'} onClick={() => setView('trinity')}>
          Trinity
        </TabButton>
        <TabButton active={view === 'vex'} onClick={() => setView('vex')}>
          VEX <span className="text-[8px] uppercase opacity-60 ml-1">soon</span>
        </TabButton>
      </div>

      {view === 'trinity' && <TrinityView />}

      {view === 'vex' && (
        <div className="bg-card border border-border rounded-xl p-6 text-center space-y-2">
          <p className="text-sm text-fg font-semibold">NetVEX coming soon</p>
          <p className="text-xs text-subtle leading-relaxed">
            Net Vega Exposure — same matrix structure as GEX but
            measuring sensitivity to IV moves instead of spot moves.
            The dxlink-worker is already streaming vega; backend math
            for the Yahoo fallback ships in the next push.
          </p>
        </div>
      )}

      {view === 'gex' && (<>

      {/* Ticker picker — favorites-only chip row. The full ~500-name
          universe lives in the search drawer; the chip row is just the
          user's curated set. Empty state surfaces a hint to star a
          ticker. The "+ Add" pill at the end opens the same search
          drawer the title-button opens. */}
      <div className="lg:hidden -mx-4 px-4 overflow-x-auto">
        <div className="flex gap-2 pb-1 items-center">
          {watchlist.length === 0 && (
            <span className="shrink-0 text-[10px] text-muted px-2 py-1.5">
              ⭐ Tap the star next to a ticker to favorite it
            </span>
          )}
          {watchlist.map((sym) => {
            const active = ticker === sym
            return (
              <button
                key={`fav-${sym}`}
                onClick={() => setTicker(sym)}
                className={
                  'tap-spring chip-pop-in shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-full border text-xs font-medium ' +
                  (active
                    ? 'bg-amber-400 text-bg border-amber-400'
                    : 'bg-card text-fg border-amber-400/40 hover:border-amber-400/70')
                }
              >
                <Star size={11} className="fill-current" />
                {sym}
              </button>
            )
          })}
          <button
            onClick={() => setDrawerOpen(true)}
            className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-full border border-dashed border-border text-xs font-medium text-subtle hover:text-fg hover:border-border-hover transition"
          >
            <Search size={11} />
            Add ticker
          </button>
        </div>
      </div>

      {!isPro && (
        <UpgradeNotice
          message={`Free tier: ${limits.marketsTickerCap} tickers. Pro unlocks the full list, watchlist tickers, scanner queue, and broker execution.`}
          cta="Go Pro"
        />
      )}

      {/* Mobile: stats card stacks above heatmap. Desktop: stats are
          inlined into the centered bottom ticker bar instead, so the
          heatmap can fill the available viewport (Skylit-style). */}
      {data && (
        <div className="lg:hidden bg-card border border-border rounded-xl p-4 space-y-3">
          <div className="flex items-baseline justify-between">
            <div>
              {/* Title-as-search-trigger. The chip carousel above already
                  switches between streamed tickers; the magnifying-glass
                  here signals that tapping opens the full ~500-name
                  universe search drawer, not just the chip set. */}
              <div className="inline-flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setDrawerOpen(true)}
                  className="inline-flex items-baseline gap-1.5 text-2xl font-display tracking-tight
                             hover:text-amber-400 transition-colors"
                  aria-label="Search any ticker"
                >
                  {data.ticker}
                  <Search size={14} className="text-subtle self-center" />
                </button>
                <button
                  type="button"
                  onClick={() => toggleFavorite(data.ticker)}
                  aria-label={
                    watchlist.includes(data.ticker.toUpperCase())
                      ? `Remove ${data.ticker} from favorites`
                      : `Favorite ${data.ticker}`
                  }
                  className={clsx(
                    'p-1 rounded-full transition',
                    watchlist.includes(data.ticker.toUpperCase())
                      ? 'text-amber-400 hover:text-amber-300'
                      : 'text-subtle hover:text-amber-400',
                  )}
                >
                  <Star
                    size={16}
                    className={
                      watchlist.includes(data.ticker.toUpperCase())
                        ? 'fill-current'
                        : ''
                    }
                  />
                </button>
              </div>
              <div className="text-xs text-subtle flex items-center gap-2 flex-wrap">
                <span>
                  {data.expirations?.length ?? 0} expirations · {data.strikes?.length ?? 0} strikes
                </span>
                <SourceBadge source={data.source} eodAt={data.eod_snapshot_at} />
                {data.from_cache && (
                  <span className="text-muted">
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

          {data.largest && (
            <div className="grid grid-cols-2 gap-2 text-xs">
              <Stat
                label="Largest wall"
                value={`$${formatNumber(data.largest.strike)}`}
                tone={data.largest.gex_net >= 0 ? 'pos' : 'neg'}
              />
              <Stat
                label="Wall expires"
                value={data.largest.expiration}
                tone="neutral"
              />
            </div>
          )}
        </div>
      )}

      {/* Heatmap card — full width on desktop, fills most of viewport.
          The min-h-[calc(100vh-13rem)] reserves vertical space for the
          top toolbar + bottom ticker bar so the matrix dominates the
          screen the way it does in Skylit. */}
      <div className="bg-card border border-border rounded-xl p-4 min-h-[280px] lg:min-h-[calc(100vh-15rem)]">
        <div className="flex items-center gap-2 mb-3">
          <Activity size={14} className="text-brand" />
          <h2 className="text-sm font-semibold">GEX by strike</h2>
        </div>

          {loading && (
            <div className="space-y-2 py-2 animate-pulse" aria-label="Loading GEX matrix">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="flex items-center gap-2">
                  <div className="h-3 w-12 rounded bg-white/[0.04]" />
                  <div
                    className="h-2 rounded bg-white/[0.04]"
                    style={{ width: `${30 + ((i * 11) % 60)}%` }}
                  />
                  <div className="h-3 w-10 rounded bg-white/[0.04] ml-auto" />
                </div>
              ))}
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

        {!loading && !error && (
          <GexMatrix data={replayActive && replaySnapshot ? replaySnapshot : data} />
        )}
      </div>

      {/* Desktop-only bottom ticker bar — centered Skylit-style. Click
          the ticker name to open the full ticker drawer. Source badge
          (LIVE / 15M DELAYED / AFTER HOURS) sits inline. */}
      {data && (
        <div className="hidden lg:flex items-center justify-center gap-4 bg-card border border-border rounded-xl px-6 py-3">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="inline-flex items-baseline gap-1.5 text-xl font-display tracking-tight
                       hover:text-amber-400 transition-colors"
            aria-label="Pick a different ticker"
          >
            {data.ticker}
            <ChevronDown size={14} className="text-subtle" />
          </button>
          <div className="text-2xl font-mono-tab tabular-nums text-fg">
            ${formatNumber(data.spot)}
          </div>
          <SourceBadge source={data.source} eodAt={data.eod_snapshot_at} />
          {data.largest && (
            <div className="text-xs text-subtle">
              <span className="text-muted uppercase tracking-wider mr-1">Wall</span>
              <span className={data.largest.gex_net >= 0 ? 'text-green-400' : 'text-red-400'}>
                ${formatNumber(data.largest.strike)}
              </span>
              <span className="text-muted ml-1">· {data.largest.expiration}</span>
            </div>
          )}
        </div>
      )}

      {/* Replay slider — flows below the ticker bar. Inactive state
          shows a discoverable hint card on desktop so users know it
          exists; the clock icon in the top toolbar still works. */}
      <div className="lg:max-w-md lg:mx-auto">
        {replayActive ? (
          <ReplaySlider
            ticker={ticker}
            active={replayActive}
            onSnapshot={setReplaySnapshot}
            onClose={() => {
              setReplayActive(false)
              setReplaySnapshot(null)
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setReplayActive(true)}
            className="hidden lg:flex w-full items-center gap-2 px-4 py-3 bg-card border border-border rounded-xl text-left hover:border-amber-400/40 transition group"
          >
            <Clock size={14} className="text-amber-400/80 group-hover:text-amber-400" />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-semibold text-fg">Replay today's GEX</div>
              <div className="text-[10px] text-muted">
                Scrub through 5-min snapshots
              </div>
            </div>
          </button>
        )}
      </div>

      {/* Suggested plays */}
      <div className="lg:max-w-2xl lg:mx-auto">
        <SuggestedPlays ticker={ticker} isPro={isPro} />
      </div>

      <p className="text-[10px] text-muted leading-relaxed px-1 lg:text-center">
        Live data via Tastytrade DXLink streaming when available; falls
        back to delayed Yahoo data otherwise. Convention: dealers are
        net short calls / long puts to retail, so call-side OI shows
        positive (green) and put-side OI shows negative (red).
      </p>
      </>)}

      <TickerDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        curated={TICKER_UNIVERSE}
        watchlist={isPro ? watchlist : []}
        gatedSet={gatedTickers}
        selected={ticker}
        onSelect={(sym) => setTicker(sym)}
        onUpgrade={() => navigate('/settings')}
      />
    </div>
  )
}

function TabButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={
        'flex-1 px-3 py-1.5 rounded-md text-xs font-semibold transition ' +
        (active
          ? 'bg-amber-400 text-bg'
          : 'text-subtle hover:text-fg hover:bg-bg-elev')
      }
    >
      {children}
    </button>
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

function SourceBadge({ source, eodAt }) {
  // dxlink data outside RTH means the worker streamed earlier and the
  // Greeks/OI snapshot is now frozen at the close. Label that distinctly
  // so users don't think 16:30 ET data is "live".
  const afterHours = source === 'dxlink' && !isWithinRth()
  if (source === 'dxlink' && !afterHours) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-green-950 border border-green-800 text-green-400 text-[9px] uppercase tracking-wider font-semibold">
        <span className="w-1 h-1 rounded-full bg-green-400 animate-pulse" />
        live
      </span>
    )
  }
  if (source === 'dxlink' && afterHours) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-950 border border-amber-800 text-amber-400 text-[9px] uppercase tracking-wider font-semibold">
        after hours
      </span>
    )
  }
  if (source === 'yahoo') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-yellow-950 border border-yellow-800 text-yellow-400 text-[9px] uppercase tracking-wider font-semibold">
        15m delayed
      </span>
    )
  }
  if (source === 'eod') {
    // Yesterday's close, used overnight + weekends + when both live
    // paths fail. Show the snapshot date so the user knows exactly
    // how stale this is — "EOD · Tue 4:30 PM" not just "EOD".
    const label = eodAt
      ? new Date(eodAt).toLocaleString([], {
          weekday: 'short',
          hour: 'numeric',
          minute: '2-digit',
        })
      : 'close'
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-yellow-950 border border-yellow-800 text-yellow-400 text-[9px] uppercase tracking-wider font-semibold"
        title={`Showing the most recent end-of-day snapshot. Live data resumes when the dxlink worker reconnects at the next session open.`}
      >
        eod · {label}
      </span>
    )
  }
  return null
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
