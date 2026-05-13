import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, RefreshCw, Activity, Star, Lock, ChevronDown, Clock, BookOpen, Search, Sparkles } from 'lucide-react'
import clsx from 'clsx'
import { isWithinRth } from '../utils/marketHours'
import { useNavigate, useSearchParams } from 'react-router-dom'
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
import PullToRefreshIndicator from '../components/PullToRefreshIndicator'
import usePullToRefresh from '../hooks/usePullToRefresh'
import useLiveSpot from '../hooks/useLiveSpot'

// HOT_TICKERS = the ~50 names the dxlink-worker actually streams
// (see dxlink-worker/src/tickers.ts). The pill row at the top of the
// page shows only these so users see the "live" subset at a glance.
// The drawer surfaces the full TICKER_UNIVERSE — S&P 500 + SOXX +
// memory names — for searching anything else (which falls back to
// Yahoo's 15-min delayed feed via compute-gex's fallback path).
const TICKERS = HOT_TICKERS

// Single-ticker exposure views — all render the same matrix but
// pivot to a different cells field. Trinity is the only non-
// single-ticker view (3 tickers side-by-side), so it falls outside
// this list.
const SINGLE_TICKER_VIEWS = ['gex', 'vex', 'cex', 'dex', 'velocity']

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
  const [searchParams, setSearchParams] = useSearchParams()
  const { user } = useAuth()
  const { isPro, limits } = useSubscription()
  // Persisted ticker — survives navigation away (e.g. user clicks
  // "Log Signal" on a suggested play, then back-navs here). Without
  // this we'd snap to TICKERS[0] and lose the user's place, which
  // also blanks SuggestedPlays since its localStorage cache is keyed
  // by ticker.
  // Resolution priority: URL ?ticker=… (deep links from Tape's
  // "Open in Markets" win) → localStorage (the user's last-viewed
  // ticker) → TICKERS[0]. Without the URL check, deep-linking from
  // Tape would silently snap to whatever the user previously
  // viewed on Markets.
  const [ticker, setTicker] = useState(() => {
    if (typeof window === 'undefined') return TICKERS[0].symbol
    try {
      const params = new URLSearchParams(window.location.search)
      const fromUrl = params.get('ticker')
      if (fromUrl && /^[A-Z][A-Z0-9.\-]{0,9}$/.test(fromUrl.toUpperCase())) {
        return fromUrl.toUpperCase()
      }
    } catch { /* */ }
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

  // Watch the URL ?ticker= for changes after mount — covers the case
  // where the user is already on /markets and the Tape pushes them
  // here with a different ticker. Skip the case where the URL ticker
  // matches local state to avoid feedback loops.
  useEffect(() => {
    const fromUrl = searchParams.get('ticker')
    if (!fromUrl) return
    const upper = fromUrl.toUpperCase()
    if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(upper)) return
    if (upper !== ticker) setTicker(upper)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  // Mirror the active ticker back into the URL so refresh / share
  // preserves the view. Replace (not push) so we don't pollute the
  // back-button stack with one entry per ticker click.
  useEffect(() => {
    if (!ticker) return
    const current = searchParams.get('ticker')
    if (current === ticker) return
    const next = new URLSearchParams(searchParams)
    next.set('ticker', ticker)
    setSearchParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker])
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  // View switcher. Single-ticker exposure tabs (GEX/VEX/CEX/DEX/
  // Velocity) all reuse the same matrix fetch — the tab just picks
  // which cells field gets rendered. Trinity is the only non-
  // single-ticker view (3 tickers side-by-side).
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
      // Optimistic remove. If the delete fails (network, RLS), the
      // next mount's load will repopulate from DB so the UI corrects
      // itself.
      setWatchlist((cur) => cur.filter((t) => t !== symbol))
      const { error } = await supabase
        .from('watchlist')
        .delete()
        .eq('user_id', user.id)
        .eq('ticker', symbol)
      if (error) {
        console.error('[watchlist] delete failed', error)
        // Roll back optimistic update so the star reflects DB truth
        setWatchlist((cur) => (cur.includes(symbol) ? cur : [...cur, symbol]))
      }
    } else {
      setWatchlist((cur) => [...cur, symbol])
      // Look up the human-readable label from the universe so the
      // row is more than a bare symbol when it lands in DB. Falls
      // back to the symbol itself if the ticker isn't in our
      // universe (custom search).
      const label =
        TICKER_UNIVERSE.find((t) => t.symbol === symbol)?.label || symbol
      const { error } = await supabase
        .from('watchlist')
        .insert({ user_id: user.id, ticker: symbol, company_name: label })
      if (error) {
        console.error('[watchlist] insert failed', error)
        // Roll back so the UI doesn't lie about being saved
        setWatchlist((cur) => cur.filter((t) => t !== symbol))
      }
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
        // Velocity Mode renders ∆GEX vs the most recent prior snapshot
        // — backend skips the diff query unless we ask for it. The
        // payload size delta is small but it's an extra DB roundtrip,
        // so only opt in when the user is actually viewing it.
        include_velocity: view === 'velocity',
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

  // Switching to/from Velocity Mode requires a fetch that asks for
  // include_velocity. Don't reload between non-velocity tabs — the
  // matrix already carries vex/cex/dex cells, so those are free
  // pivots. Only velocity needs the round-trip.
  useEffect(() => {
    if (view === 'velocity' && data && !data.velocity_cells) {
      load(ticker)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])

  // Pull-to-refresh: dragging from the top of the page calls the
  // same `refresh: true` path as the manual refresh button. Disabled
  // in replay mode so the user can't accidentally clobber the
  // historical snapshot they're inspecting.
  const { pullDistance, refreshing, threshold } = usePullToRefresh(
    () => load(ticker, { refresh: true }),
    { disabled: replayActive },
  )

  // Live spot polling. The matrix snapshot's `spot` is server-cached
  // for 5 min; without this the GEX cursor row sits stuck on whatever
  // spot was when compute-gex last ran. Polls dxlink_quotes for the
  // equity row every 2s; null in replay mode (we want the historical
  // cursor to stay where it was at snapshot time).
  const { spot: liveSpot } = useLiveSpot(replayActive ? null : ticker)

  return (
    <div className="px-4 lg:px-6 py-5 space-y-4 max-w-md mx-auto lg:max-w-7xl">
      <PullToRefreshIndicator
        pullDistance={pullDistance}
        refreshing={refreshing}
        threshold={threshold}
      />
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate(-1)}
          className="lg:hidden p-2 -ml-2 text-subtle hover:text-fg"
          aria-label="Back"
        >
          <ArrowLeft size={20} />
        </button>
        <div className="flex-1">
          <h1 className="text-lg lg:text-2xl font-semibold leading-tight">HeatPulse™</h1>
          <p className="text-xs lg:text-sm text-subtle">
            Where dealer hedging flow concentrates by strike.
          </p>
        </div>
        <button
          onClick={() => setReplayActive((v) => !v)}
          className={clsx(
            'p-2 transition',
            replayActive
              ? 'text-amber-400 hover:text-amber-300'
              : 'text-subtle hover:text-fg',
          )}
          aria-label={replayActive ? 'Exit replay' : 'Enter replay mode'}
          aria-pressed={replayActive}
          title={replayActive ? 'Showing historical snapshot — tap to return to live' : "Scrub today's GEX evolution"}
        >
          <Clock size={18} />
        </button>
        <button
          onClick={() => navigate(`/reasoning?t=${ticker}`)}
          className="p-2 text-subtle hover:text-amber-400"
          aria-label="Open Reasoning"
          title="Open the live inference engine for this ticker"
        >
          <Sparkles size={18} />
        </button>
        <button
          onClick={() => navigate('/learn/glossary')}
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

      {/* View tabs — single-ticker matrix supports five exposure
          views (GEX, VEX, CEX, DEX, Velocity), plus Trinity for the
          3-ticker side-by-side. The single-ticker tabs all share the
          same fetch + matrix render — the tab just picks which cells
          array (gex_cells / vex_cells / etc.) gets visualized. */}
      <div className="flex gap-1 border border-border rounded-lg p-1 bg-card overflow-x-auto">
        <TabButton active={view === 'gex'} onClick={() => setView('gex')}>
          GEX
        </TabButton>
        <TabButton active={view === 'vex'} onClick={() => setView('vex')}>
          VEX
        </TabButton>
        <TabButton active={view === 'cex'} onClick={() => setView('cex')}>
          CEX
        </TabButton>
        <TabButton active={view === 'dex'} onClick={() => setView('dex')}>
          DEX
        </TabButton>
        <TabButton active={view === 'velocity'} onClick={() => setView('velocity')}>
          Velocity
        </TabButton>
        <TabButton active={view === 'trinity'} onClick={() => setView('trinity')}>
          Trinity
        </TabButton>
      </div>

      {view === 'trinity' && <TrinityView />}

      {SINGLE_TICKER_VIEWS.includes(view) && (<>

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
        </div>
      </div>

      {!isPro && (
        <UpgradeNotice
          message={`Free tier: ${limits.marketsTickerCap} tickers. Pro unlocks the full HeatPulse™ list, Tracking, Suggested Plays, and broker execution.`}
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
          <h2 className="text-sm font-semibold">{exposureLabel(view)} by strike</h2>
          {view === 'velocity' && data?.velocity_window_minutes != null && (
            <span className="text-[10px] text-muted uppercase tracking-wider">
              · last {data.velocity_window_minutes}m
            </span>
          )}
        </div>

        {/* Inference strip. The leftmost stat is per-tab — Net GEX on
            the gamma view, Net VEX/CEX/DEX on those tabs, ΔGEX on
            Velocity — so the headline number always matches what the
            heatmap below is showing. Wall + Pin prob + Expected ±
            stay gamma-anchored on every tab because those concepts
            only mean something in gamma terms (there's no "vanna
            wall"). */}
        {!loading && !error && data && (() => {
          const headline = headlineMetric(view, data)
          return (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 mb-4 text-xs">
              <Metric label={headline.label} value={headline.value} tone={headline.tone} />
              <Metric label="Expected ±" value={data.expected_move ? `$${data.expected_move.toFixed(2)} (${(data.expected_move_pct * 100).toFixed(1)}%)` : '—'} tone="amber" />
              <Metric label="Pin prob." value={data.pinning_probability != null ? `${Math.round(data.pinning_probability * 100)}%` : '—'} tone={data.pinning_probability >= 0.6 ? 'green' : data.pinning_probability >= 0.3 ? 'amber' : 'muted'} />
              <Metric label="Wall" value={data.largest ? `$${formatNumber(data.largest.strike)}` : '—'} tone={data.largest && data.largest.gex_net >= 0 ? 'green' : 'red'} />
            </div>
          )
        })()}

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
          <GexMatrix
            data={replayActive && replaySnapshot ? replaySnapshot : data}
            liveSpot={replayActive ? null : liveSpot}
            exposureType={view}
          />
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
          /* Discoverable hint card on BOTH mobile and desktop now —
             previously hidden behind lg:flex. The replay feature is
             non-obvious; without surfacing it on the page itself,
             nobody finds the clock-icon entry. */
          <button
            type="button"
            onClick={() => setReplayActive(true)}
            className="tap-spring w-full flex items-center gap-2 px-4 py-3 bg-card border border-border rounded-xl text-left hover:border-amber-400/40 transition group"
          >
            <Clock size={14} className="text-amber-400/80 group-hover:text-amber-400" />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-semibold text-fg">Replay today's GEX</div>
              <div className="text-[10px] text-muted">
                Scrub 5-min snapshots from open → now to see how the
                wall built up.
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

// Short heading for the heatmap card per exposure tab — drives both
// the H2 ("GEX by strike", "VEX by strike", …) and the empty-state
// copy in GexMatrix.
function exposureLabel(view) {
  return ({
    gex: 'GEX',
    vex: 'VEX',
    cex: 'CEX',
    dex: 'DEX',
    velocity: '∆GEX',
  }[view]) || 'GEX'
}

// Inference-strip metric pill. Tone maps to one of the design-system
// accent colors so the badge matches the same regime cues used
// elsewhere on the page.
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

function SourceBadge({ source, eodAt }) {
  // dxlink data outside RTH means the worker streamed earlier and the
  // Greeks/OI snapshot is now frozen at the close. Label that distinctly
  // so users don't think 16:30 ET data is "live".
  const afterHours = source === 'dxlink' && !isWithinRth()
  if (source === 'dxlink' && !afterHours) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-green-950 border border-green-800 text-green-400 text-[10px] uppercase tracking-wider font-semibold">
        <span className="w-1 h-1 rounded-full bg-green-400 animate-pulse" />
        live
      </span>
    )
  }
  if (source === 'dxlink' && afterHours) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-950 border border-amber-800 text-amber-400 text-[10px] uppercase tracking-wider font-semibold">
        after hours
      </span>
    )
  }
  if (source === 'yahoo') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-yellow-950 border border-yellow-800 text-yellow-400 text-[10px] uppercase tracking-wider font-semibold">
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
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-yellow-950 border border-yellow-800 text-yellow-400 text-[10px] uppercase tracking-wider font-semibold"
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

// Per-tab headline number for the inference strip. Falls back to net
// GEX when the per-Greek aggregate is missing (older compute-gex
// snapshots cached before this field shipped — drop this fallback
// after the cache TTL has rotated).
function headlineMetric(view, data) {
  switch (view) {
    case 'vex':
      return { label: 'Net VEX', value: formatGex(data.net_vex), tone: (data.net_vex ?? 0) >= 0 ? 'green' : 'red' }
    case 'cex':
      return { label: 'Net CEX', value: formatGex(data.net_cex), tone: (data.net_cex ?? 0) >= 0 ? 'green' : 'red' }
    case 'dex':
      return { label: 'Net DEX', value: formatGex(data.net_dex), tone: (data.net_dex ?? 0) >= 0 ? 'green' : 'red' }
    case 'velocity':
      return { label: 'ΔGEX (window)', value: formatGex(data.net_velocity), tone: (data.net_velocity ?? 0) >= 0 ? 'green' : 'red' }
    case 'gex':
    default:
      return { label: 'Net GEX', value: formatGex(data.net_gex), tone: (data.net_gex ?? 0) >= 0 ? 'green' : 'red' }
  }
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
