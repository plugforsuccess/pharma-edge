import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, RefreshCw, Activity, Star, Lock, ChevronDown, ChevronLeft, ChevronRight, Clock, BookOpen, Search, Sparkles, Maximize2, Minimize2 } from 'lucide-react'
import clsx from 'clsx'
import { isWithinRth } from '../utils/marketHours'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useSubscription } from '../hooks/useSubscription'
import { HOT_TICKERS, TICKER_UNIVERSE } from '../lib/tickerUniverse'
import GexMatrix from '../components/GexMatrix'
import EarningsBadge from '../components/EarningsBadge'
import EarningsCard from '../components/EarningsCard'
import MatrixSummaryCard from '../components/MatrixSummaryCard'
import TickerDrawer from '../components/TickerDrawer'
import ReplaySlider from '../components/ReplaySlider'
import SuggestedPlays from '../components/SuggestedPlays'
import SuggestedWheel from '../components/SuggestedWheel'
import WheelAnalyze from '../components/WheelAnalyze'
import TrinityView from '../components/TrinityView'
import UpgradeNotice from '../components/UpgradeNotice'
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

// Per-ticker matrix overrides. NOW (ServiceNow) is high-priced with
// wide strike spacing, so the default 7% window clips the chain. Owner
// wants ~10 strikes either side of spot across the front 4 expirations:
// maxStrikes 21 = 10 below + ATM + 10 above (compute-gex centers the
// cap on spot); the 15% window is wide enough that the strike COUNT —
// not the window — is the binding constraint for NOW.
const MATRIX_OPTS_BY_TICKER = {
  NOW: { maxExpirations: 4, maxStrikes: 21, strikeWindowPct: 0.15 },
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

  // Immersive expand mode for the heatmap card — overlay that hides
  // site chrome so the matrix fills the viewport (and gets even wider
  // in landscape now that the PWA manifest no longer locks portrait).
  const [matrixExpanded, setMatrixExpanded] = useState(false)
  useEffect(() => {
    if (!matrixExpanded) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e) => { if (e.key === 'Escape') setMatrixExpanded(false) }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [matrixExpanded])

  // Auto-engage the immersive overlay when the device rotates to
  // landscape on a small viewport — phones in landscape have ~330px
  // of vertical space after the bottom nav + page chrome, which
  // squeezes the matrix to a few rows. The overlay hides ALL chrome
  // (z-[100] fixed inset-0) so the matrix gets the full viewport.
  // User can still tap Minimize2 / press Escape to exit.
  //
  // Triggers: orientation=landscape AND innerHeight <= 500 (phone in
  // landscape — tablets have plenty of vertical space, so they stay
  // in normal layout). We don't auto-collapse on portrait return —
  // if the user explicitly expanded, that's a separate intent.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(orientation: landscape) and (max-height: 500px)')
    const sync = () => {
      if (mq.matches) setMatrixExpanded(true)
      // On rotation back to portrait we deliberately do NOT force
      // collapse — if user explicitly tapped Maximize, they keep
      // the overlay until they Minimize.
    }
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  // User-controlled matrix density. null = "use the per-ticker default
  // from MATRIX_OPTS / MATRIX_OPTS_BY_TICKER". When non-null, the
  // values override the defaults for every ticker — that's what the
  // strikes/expirations pickers in the heatmap toolbar drive. The
  // walls-only toggle is a presentation filter only (doesn't re-fetch).
  const [userMaxStrikes, setUserMaxStrikes] = useState(() => {
    if (typeof window === 'undefined') return null
    try {
      const v = window.localStorage.getItem('pe_markets_max_strikes')
      return v ? Number(v) : null
    } catch { return null }
  })
  const [userMaxExpirations, setUserMaxExpirations] = useState(() => {
    if (typeof window === 'undefined') return null
    try {
      const v = window.localStorage.getItem('pe_markets_max_expirations')
      return v ? Number(v) : null
    } catch { return null }
  })
  const [wallsOnly, setWallsOnly] = useState(() => {
    if (typeof window === 'undefined') return false
    try { return window.localStorage.getItem('pe_markets_walls_only') === '1' } catch { return false }
  })
  // Expiration window offset for the < > stepper. Always reset to 0 on
  // ticker change so the user sees the front of the new chain. Not
  // persisted in localStorage — it's a transient navigation state.
  const [expirationOffset, setExpirationOffset] = useState(0)
  useEffect(() => { setExpirationOffset(0) }, [ticker])
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      if (userMaxStrikes != null) window.localStorage.setItem('pe_markets_max_strikes', String(userMaxStrikes))
      else window.localStorage.removeItem('pe_markets_max_strikes')
    } catch { /* */ }
  }, [userMaxStrikes])
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      if (userMaxExpirations != null) window.localStorage.setItem('pe_markets_max_expirations', String(userMaxExpirations))
      else window.localStorage.removeItem('pe_markets_max_expirations')
    } catch { /* */ }
  }, [userMaxExpirations])
  useEffect(() => {
    if (typeof window === 'undefined') return
    try { window.localStorage.setItem('pe_markets_walls_only', wallsOnly ? '1' : '0') } catch { /* */ }
  }, [wallsOnly])

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
  // viewMode: 'summary' = MatrixSummaryCard (regime + narrative);
  // 'raw' = the existing heatmap + tabs. Persisted in localStorage
  // so a power user who flipped to 'raw' once doesn't get reset to
  // the summary view on next visit. New users default to summary.
  const [viewMode, setViewMode] = useState(() => {
    if (typeof window === 'undefined') return 'summary'
    try {
      const v = window.localStorage.getItem('pe_markets_view_mode')
      return v === 'raw' ? 'raw' : 'summary'
    } catch { return 'summary' }
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    try { window.localStorage.setItem('pe_markets_view_mode', viewMode) } catch { /* */ }
  }, [viewMode])
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
      const baseMopts = {
        ...MATRIX_OPTS,
        ...(MATRIX_OPTS_BY_TICKER[String(sym).toUpperCase()] || {}),
      }
      // User overrides from the heatmap toolbar pickers win over the
      // per-ticker defaults. Null = use the default.
      const displayMaxExpirations = userMaxExpirations ?? baseMopts.maxExpirations
      // Always fetch enough expirations to leave room for the < >
      // stepper to slide the display window forward without re-fetching.
      // 12 is the hard cap (matches the picker's highest option).
      const fetchMaxExpirations = Math.max(displayMaxExpirations, 12)
      // When the user picks an explicit strike count, also widen
      // strikeWindowPct so the COUNT becomes the binding constraint
      // (otherwise the default 7% window silently clamps the picker
      // — e.g. WMT @ $131 only has ~18 strikes inside ATM ± 7%, so
      // asking for 50 returns 18). 0.30 = ATM ± 30% which covers
      // up to ~60 $1-spaced strikes on a $100 underlying. For very
      // low-priced names the chain may still be the bottleneck and
      // we'll deliver fewer than requested — that's expected.
      const mopts = {
        ...baseMopts,
        ...(userMaxStrikes != null
          ? {
              maxStrikes: userMaxStrikes,
              strikeWindowPct: Math.max(0.30, baseMopts.strikeWindowPct),
            }
          : {}),
        maxExpirations: fetchMaxExpirations,
      }
      const body = {
        ticker: sym,
        refresh,
        matrix: true,
        matrix_max_expirations: mopts.maxExpirations,
        matrix_max_strikes: mopts.maxStrikes,
        matrix_strike_window_pct: mopts.strikeWindowPct,
        // Always request velocity_cells so the gamma view can render
        // inline ∆GEX% chips next to each cell value (Skylit parity).
        // Adds one DB roundtrip per fetch; tradeoff worth it for the
        // signal density it gives the heatmap.
        include_velocity: true,
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

  // Reload when the user changes strike/expiry density. The pickers
  // mutate the request payload, so the server has to recompute.
  // Skipped on initial mount via ref so we don't double-fetch alongside
  // the ticker-effect above.
  const densityMountRef = useRef(true)
  useEffect(() => {
    if (densityMountRef.current) { densityMountRef.current = false; return }
    load(ticker)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userMaxStrikes, userMaxExpirations])

  // (Was: velocity re-fetch effect. Now obsolete — include_velocity is
  // always true so every matrix response already carries velocity_cells.)

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

  // Check whether the current viewer has an open position on this
  // ticker. If yes, surface a chip in the header that jumps to the
  // position page — the inverse of the "View matrix →" link on
  // PositionDetail. Re-queries whenever the ticker changes or the
  // user signs in/out; cheap (single indexed row by user_id + ticker).
  const [openPositionId, setOpenPositionId] = useState(null)
  useEffect(() => {
    if (!user?.id || !ticker) {
      setOpenPositionId(null)
      return
    }
    let cancelled = false
    ;(async () => {
      const { data } = await supabase
        .from('open_positions')
        .select('id')
        .eq('user_id', user.id)
        .eq('ticker', ticker.toUpperCase())
        .eq('status', 'open')
        .order('entry_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (!cancelled) setOpenPositionId(data?.id ?? null)
    })()
    return () => { cancelled = true }
  }, [user?.id, ticker])

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
                {openPositionId && (
                  <Link
                    to={`/position/${openPositionId}`}
                    className="text-[10px] uppercase tracking-wider text-amber-400 hover:text-amber-300 border border-amber-400/30 hover:border-amber-300/60 rounded px-1.5 py-1 leading-none"
                  >
                    View position →
                  </Link>
                )}
              </div>
              <div className="text-xs text-subtle flex items-center gap-2 flex-wrap">
                <span>
                  {data.expirations?.length ?? 0} expirations · {data.strikes?.length ?? 0} strikes
                </span>
                <SourceBadge source={data.source} eodAt={data.eod_snapshot_at} />
                <SessionBadge session={data.session} />
                <OpexBadge opex={data.opex} />
                {data.from_cache && (
                  <span className="text-muted">
                    · cached {formatCacheAge(data.cache_age_ms)} ago
                  </span>
                )}
              </div>
              <ExtendedHoursDivergenceBanner data={data} liveSpot={liveSpot} />
            </div>
            <div className="text-right">
              <div className="text-xl font-mono-tab tabular-nums">
                ${formatNumber(liveSpot ?? data.spot)}
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
          {/* Earnings calendar slot — always visible per ticker. When
              there's nothing scheduled in the next 60 days, the card
              says so explicitly rather than hiding (which would leave
              the user wondering whether the absence means 'safe' or
              'unknown'). */}
          <EarningsCard ticker={data.ticker} />
        </div>
      )}

      {/* Heatmap card — full width on desktop, fills most of viewport.
          The min-h-[calc(100vh-13rem)] reserves vertical space for the
          top toolbar + bottom ticker bar so the matrix dominates the
          screen the way it does in Skylit. */}
      <div className={clsx(
        matrixExpanded
          ? 'fixed inset-0 z-[100] bg-bg overflow-auto p-3 pt-safe pb-safe'
          : 'bg-card border border-border rounded-xl p-4 min-h-[280px] lg:min-h-[calc(100vh-15rem)]',
      )}>
        <div className="flex items-center gap-2 mb-3">
          <Activity size={14} className="text-brand" />
          <h2 className="text-sm font-semibold">{exposureLabel(view)} by strike</h2>
          {view === 'velocity' && data?.velocity_window_minutes != null && (
            <span className="text-[10px] text-muted uppercase tracking-wider">
              · last {data.velocity_window_minutes}m
            </span>
          )}
          <button
            type="button"
            onClick={() => setMatrixExpanded((v) => !v)}
            aria-label={matrixExpanded ? 'Collapse matrix' : 'Expand matrix to full screen'}
            title={matrixExpanded ? 'Collapse (Esc)' : 'Expand matrix'}
            className="ml-auto p-1.5 -mr-1 text-muted hover:text-fg rounded hover:bg-bg-elev/60 transition"
          >
            {matrixExpanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
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

        {!loading && !error && (() => {
          const matrixData = replayActive && replaySnapshot ? replaySnapshot : data
          // Client-side window over the fetched expirations so the < >
          // stepper can slide instantly without round-tripping the
          // server. displayCount is what the user picked (or the
          // per-ticker default); matrixData carries up to
          // FETCH_EXPIRATIONS_CAP. Largest gets re-indexed into the
          // window, or nulled out when its column is off-screen.
          const baseMoptsForView = {
            ...MATRIX_OPTS,
            ...(MATRIX_OPTS_BY_TICKER[String(ticker).toUpperCase()] || {}),
          }
          const displayCount = userMaxExpirations ?? baseMoptsForView.maxExpirations
          const totalExpirations = matrixData?.expirations?.length ?? 0
          const offset = Math.max(0, Math.min(expirationOffset, Math.max(0, totalExpirations - displayCount)))
          const canStepBack = offset > 0
          const canStepForward = offset + displayCount < totalExpirations
          const sliceCols = (arr) => Array.isArray(arr) ? arr.map((row) => row.slice(offset, offset + displayCount)) : arr
          const slicedMatrixData = matrixData && totalExpirations > displayCount
            ? {
                ...matrixData,
                expirations: matrixData.expirations.slice(offset, offset + displayCount),
                cells: sliceCols(matrixData.cells),
                vex_cells: sliceCols(matrixData.vex_cells),
                cex_cells: sliceCols(matrixData.cex_cells),
                dex_cells: sliceCols(matrixData.dex_cells),
                velocity_cells: sliceCols(matrixData.velocity_cells),
                largest: matrixData.largest
                  && matrixData.largest.expiration_index >= offset
                  && matrixData.largest.expiration_index < offset + displayCount
                  ? { ...matrixData.largest, expiration_index: matrixData.largest.expiration_index - offset }
                  : null,
              }
            : matrixData
          return (
            <div className="space-y-3">
              {/* Matrix toolbar — Summary/Raw mode on the left, then
                  the Skylit-style density + walls controls on the
                  right. flex-wrap so the controls drop to a second
                  line on narrow viewports rather than overflowing. */}
              <div className="flex items-center gap-2 flex-wrap">
                <div className="flex items-center gap-1 bg-card border border-border rounded-lg p-1 w-fit">
                  <button
                    type="button"
                    onClick={() => setViewMode('summary')}
                    className={clsx(
                      'px-3 py-1 text-[11px] font-medium rounded transition-colors',
                      viewMode === 'summary'
                        ? 'bg-bg text-white'
                        : 'text-zinc-500 hover:text-zinc-300',
                    )}
                  >
                    Summary
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewMode('raw')}
                    className={clsx(
                      'px-3 py-1 text-[11px] font-medium rounded transition-colors',
                      viewMode === 'raw'
                        ? 'bg-bg text-white'
                        : 'text-zinc-500 hover:text-zinc-300',
                    )}
                  >
                    Raw cells
                  </button>
                </div>
                {viewMode === 'raw' && (
                  <div className="flex items-center gap-2 ml-auto">
                    <label className="flex items-center gap-1 text-[10px] text-subtle">
                      <span className="uppercase tracking-wider">Strikes</span>
                      <select
                        value={userMaxStrikes ?? ''}
                        onChange={(e) => {
                          const v = e.target.value
                          setUserMaxStrikes(v === '' ? null : Number(v))
                        }}
                        className="bg-card border border-border rounded px-1.5 py-0.5 text-[11px] text-fg font-mono-tab focus:outline-none focus:ring-1 focus:ring-brand/40"
                      >
                        <option value="">{baseMoptsForView.maxStrikes}</option>
                        {[11, 21, 31, 41, 51]
                          .filter((n) => n !== baseMoptsForView.maxStrikes)
                          .map((n) => (
                            <option key={n} value={n}>{n}</option>
                          ))}
                      </select>
                    </label>
                    <label className="flex items-center gap-1 text-[10px] text-subtle">
                      <span className="uppercase tracking-wider">Exp</span>
                      <select
                        value={userMaxExpirations ?? ''}
                        onChange={(e) => {
                          const v = e.target.value
                          setUserMaxExpirations(v === '' ? null : Number(v))
                        }}
                        className="bg-card border border-border rounded px-1.5 py-0.5 text-[11px] text-fg font-mono-tab focus:outline-none focus:ring-1 focus:ring-brand/40"
                      >
                        <option value="">{baseMoptsForView.maxExpirations}</option>
                        {[2, 4, 6, 8, 10, 12]
                          .filter((n) => n !== baseMoptsForView.maxExpirations)
                          .map((n) => (
                            <option key={n} value={n}>{n}</option>
                          ))}
                      </select>
                    </label>
                    <div className="flex items-center gap-1 bg-card border border-border rounded-lg p-1">
                      <button
                        type="button"
                        onClick={() => setWallsOnly(false)}
                        title="Show all strikes"
                        aria-pressed={!wallsOnly}
                        className={clsx(
                          'px-2 py-0.5 text-[11px] rounded transition-colors',
                          !wallsOnly ? 'bg-bg text-white' : 'text-zinc-500 hover:text-zinc-300',
                        )}
                      >
                        All
                      </button>
                      <button
                        type="button"
                        onClick={() => setWallsOnly(true)}
                        title="Show walls only (top-3 per expiration)"
                        aria-pressed={wallsOnly}
                        className={clsx(
                          'px-2 py-0.5 text-[11px] rounded transition-colors',
                          wallsOnly ? 'bg-bg text-amber-300' : 'text-zinc-500 hover:text-zinc-300',
                        )}
                      >
                        Walls
                      </button>
                    </div>
                    {totalExpirations > displayCount && (
                      <div className="flex items-center gap-1 bg-card border border-border rounded-lg p-1">
                        <button
                          type="button"
                          onClick={() => setExpirationOffset((o) => Math.max(0, o - displayCount))}
                          disabled={!canStepBack}
                          aria-label="Previous expirations"
                          title="Step expiration window back"
                          className="p-1 text-zinc-500 hover:text-zinc-300 disabled:opacity-30 disabled:hover:text-zinc-500 disabled:cursor-not-allowed"
                        >
                          <ChevronLeft size={14} />
                        </button>
                        <span className="px-1 text-[10px] tabular-nums text-subtle whitespace-nowrap">
                          {totalExpirations === 0
                            ? '—'
                            : `${offset + 1}–${Math.min(offset + displayCount, totalExpirations)} / ${totalExpirations}`}
                        </span>
                        <button
                          type="button"
                          onClick={() => setExpirationOffset((o) => Math.min(Math.max(0, totalExpirations - displayCount), o + displayCount))}
                          disabled={!canStepForward}
                          aria-label="Next expirations"
                          title="Step expiration window forward"
                          className="p-1 text-zinc-500 hover:text-zinc-300 disabled:opacity-30 disabled:hover:text-zinc-500 disabled:cursor-not-allowed"
                        >
                          <ChevronRight size={14} />
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
              {viewMode === 'summary' && matrixData ? (
                <MatrixSummaryCard matrix={matrixData} variant="full" liveSpot={replayActive ? null : liveSpot} />
              ) : (
                <GexMatrix
                  data={slicedMatrixData}
                  liveSpot={replayActive ? null : liveSpot}
                  exposureType={view}
                  wallsOnly={wallsOnly}
                />
              )}
            </div>
          )
        })()}
      </div>

      {/* Mobile persistent spot pill — fixed above the bottom nav so
          spot context is always visible while scrolling the matrix
          (Skylit parity). Hidden in matrixExpanded mode (the overlay
          already shows spot via the in-card metric strip and the
          bottom nav is hidden under the overlay anyway). */}
      {data && !matrixExpanded && (() => {
        const cur = Number.isFinite(liveSpot) && liveSpot > 0 ? liveSpot : data.spot
        const prev = data.prev_close
        const pct = (Number.isFinite(cur) && Number.isFinite(prev) && prev > 0)
          ? ((cur - prev) / prev) * 100
          : null
        const pctTone = pct == null ? 'text-subtle' : pct >= 0 ? 'text-green-400' : 'text-red-400'
        return (
          <div
            className="lg:hidden fixed left-1/2 -translate-x-1/2 z-40
                       bottom-[calc(5.5rem+env(safe-area-inset-bottom))]
                       flex items-center gap-2 bg-card/95 backdrop-blur
                       border border-border rounded-full px-3 py-1.5
                       shadow-[0_4px_16px_rgba(0,0,0,0.4)] pointer-events-auto"
          >
            <span className="text-[9px] uppercase tracking-wider text-muted font-semibold">NOW</span>
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="text-fg text-sm font-semibold tabular-nums leading-none hover:text-amber-400 transition-colors"
              aria-label="Pick a different ticker"
            >
              {data.ticker}
            </button>
            <span className="text-fg font-mono-tab tabular-nums text-sm leading-none">
              ${Number.isFinite(cur) ? Number(cur).toFixed(2) : '—'}
            </span>
            {pct != null && (
              <span className={`${pctTone} text-xs tabular-nums leading-none`}>
                {pct >= 0 ? '+' : ''}{pct.toFixed(2)}%
              </span>
            )}
            <EarningsBadge ticker={data.ticker} compact withTime />
          </div>
        )
      })()}

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
          {openPositionId && (
            <Link
              to={`/position/${openPositionId}`}
              className="text-[10px] uppercase tracking-wider text-amber-400 hover:text-amber-300 border border-amber-400/30 hover:border-amber-300/60 rounded px-1.5 py-1 leading-none"
            >
              View position →
            </Link>
          )}
          <div className="text-2xl font-mono-tab tabular-nums text-fg">
            ${formatNumber(liveSpot ?? data.spot)}
          </div>
          <SourceBadge source={data.source} eodAt={data.eod_snapshot_at} />
          <EarningsBadge ticker={data.ticker} withTime />
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

      {/* Replay slider — flows below the ticker bar. Only rendered
          once the user explicitly enters replay via the clock icon in
          the top toolbar; no persistent hint/entry card. */}
      {replayActive && (
        <div className="lg:max-w-md lg:mx-auto">
          <ReplaySlider
            ticker={ticker}
            active={replayActive}
            onSnapshot={setReplaySnapshot}
            onClose={() => {
              setReplayActive(false)
              setReplaySnapshot(null)
            }}
          />
        </div>
      )}

      {/* Suggested plays */}
      <div className="lg:max-w-2xl lg:mx-auto">
        <SuggestedPlays ticker={ticker} isPro={isPro} />
      </div>

      {/* On-demand wheel CSP analysis for THIS matrix ticker —
          click-to-run, same deterministic engine as the batch scan. */}
      <div className="lg:max-w-2xl lg:mx-auto">
        <WheelAnalyze ticker={ticker} />
      </div>

      {/* Wheel CSPs — universe-wide batch feed, alongside the
          ticker-scoped Claude spreads above. Same feed as /wheel. */}
      <div className="lg:max-w-2xl lg:mx-auto">
        <SuggestedWheel />
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

// Small session chip — 'rth' renders nothing (no signal); extended
// sessions render a colored pill so the user knows the matrix's spot
// is a frozen RTH-close value while live price is moving underneath.
function SessionBadge({ session }) {
  if (!session || session === 'rth') return null
  const config = {
    'pre-market':  { label: 'PRE-MARKET',  cls: 'bg-blue-950 text-blue-300 border-blue-800' },
    'after-hours': { label: 'AFTER-HOURS', cls: 'bg-amber-950 text-amber-300 border-amber-800' },
    'overnight':   { label: 'OVERNIGHT',   cls: 'bg-zinc-900 text-zinc-300 border-zinc-700' },
    'weekend':     { label: 'WEEKEND',     cls: 'bg-zinc-900 text-zinc-300 border-zinc-700' },
  }[session] ?? { label: session.toUpperCase(), cls: 'bg-zinc-900 text-zinc-300 border-zinc-700' }
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider font-semibold border ${config.cls}`}>
      {config.label}
    </span>
  )
}

// OPEX chip. "OPEX TODAY" (red, quarterly = brighter) when the
// monthly/quarterly expiration is today — the day the largest gamma
// cluster of the month dies and pin theses anchored to it evaporate.
// "OPEX 3d" muted countdown otherwise. Nothing if no opex context or
// it's > 7 days out (not yet decision-relevant).
function OpexBadge({ opex }) {
  if (!opex || !opex.next_date) return null
  if (opex.is_today) {
    const cls = opex.is_quarterly
      ? 'bg-red-900 text-red-200 border-red-600'
      : 'bg-red-950 text-red-300 border-red-800'
    return (
      <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider font-semibold border ${cls}`}>
        {opex.is_quarterly ? 'TRIPLE-WITCH TODAY' : 'OPEX TODAY'}
      </span>
    )
  }
  if (opex.days_until == null || opex.days_until > 7) return null
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider font-semibold border bg-zinc-900 text-zinc-400 border-zinc-700">
      OPEX {opex.days_until}d{opex.is_quarterly ? ' (Q)' : ''}
    </span>
  )
}

// Banner that fires when (a) we're outside RTH and (b) live equity
// price has diverged ≥0.2% from the matrix's spot (RTH close). The
// matrix's cells/walls/Greeks are frozen at the close — accurate —
// but the wall-distance math relative to the user's actual entry
// point changes when price has moved overnight. Tells the user what
// the matrix doesn't say.
function ExtendedHoursDivergenceBanner({ data, liveSpot }) {
  const session = data?.session
  if (!session || session === 'rth') return null
  const close = Number(data?.spot)
  // A live spot of 0 / non-positive means "no live quote" (weekend,
  // holiday, feed down) — NOT that the stock printed zero. Treat it as
  // absent, same guard deriveSummary uses for the headline. Without
  // the `> 0` on the data.live_spot fallback, a weekend (live 0) makes
  // deltaPct = (0 - close)/close = -100% and renders a bogus
  // "Weekend gap down -100.00%" banner.
  const live = Number.isFinite(liveSpot) && liveSpot > 0
    ? liveSpot
    : (Number.isFinite(Number(data?.live_spot)) && Number(data?.live_spot) > 0)
      ? Number(data.live_spot)
      : NaN
  if (!Number.isFinite(close) || !Number.isFinite(live) || close <= 0) return null
  const deltaPct = ((live - close) / close) * 100
  if (Math.abs(deltaPct) < 0.2) return null   // below threshold, hide
  const direction = deltaPct >= 0 ? 'gap up' : 'gap down'
  const tone = Math.abs(deltaPct) >= 0.5 ? 'amber-400' : 'amber-300'
  const sessionLabel = {
    'pre-market': 'Pre-market',
    'after-hours': 'After-hours',
    'overnight': 'Overnight',
    'weekend': 'Weekend',
  }[session] ?? session
  return (
    <div className={`mt-1.5 rounded border border-amber-800/60 bg-amber-950/30 px-2 py-1.5 text-[10px] leading-relaxed text-${tone}`}>
      {sessionLabel} {direction} {deltaPct >= 0 ? '+' : ''}{deltaPct.toFixed(2)}%
      <span className="text-subtle"> · matrix spot ${close.toFixed(2)} is RTH close; live ${live.toFixed(2)}. Cells/walls/Greeks are frozen — re-read wall distances against live spot, not close.</span>
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
