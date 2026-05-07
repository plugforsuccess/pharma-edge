import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, RefreshCw, Activity, Star, Lock, ChevronDown, Clock, BookOpen, Search } from 'lucide-react'
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

// Heatmap density presets. compact mirrors the Skylit default. wide
// and extra trade horizontal/vertical scroll for more strikes and
// further-out expirations. Bounded server-side by *_LIMIT constants
// in compute-gex.
const DENSITY_PRESETS = {
  compact: { maxExpirations: 4, maxStrikes: 30, strikeWindowPct: 0.05, label: 'Compact' },
  wide:    { maxExpirations: 6, maxStrikes: 50, strikeWindowPct: 0.10, label: 'Wide' },
  extra:   { maxExpirations: 8, maxStrikes: 80, strikeWindowPct: 0.20, label: 'Extra' },
}

export default function Markets() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { isPro, limits } = useSubscription()
  const [ticker, setTicker] = useState(TICKERS[0].symbol)
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
  // Matrix density: 'compact' is the Skylit default (4×30 strikes,
  // ATM ±5%); 'wide' and 'extra' progressively expand both axes for
  // users who want to see further-OTM strikes or more expirations.
  const [density, setDensity] = useState('compact')
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

  async function load(sym, { refresh = false, withDensity = density } = {}) {
    setLoading(true)
    setError(null)
    setData(null)
    try {
      // matrix:true asks compute-gex for the strikes×expirations grid
      // (Skylit-style heatmap) instead of the single-expiration shape.
      const dims = DENSITY_PRESETS[withDensity] ?? DENSITY_PRESETS.compact
      const body = {
        ticker: sym,
        refresh,
        matrix: true,
        matrix_max_expirations: dims.maxExpirations,
        matrix_max_strikes: dims.maxStrikes,
        matrix_strike_window_pct: dims.strikeWindowPct,
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
    load(ticker, { withDensity: density })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker, density])

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
        {/* Density picker — controls how many strikes/expirations the
            heatmap fetches. Compact = Skylit-default (4×30); Wide = 6×50;
            Extra = 8×80. Visible on mobile too — users on the Gamma Map
            page on phones need this lever as much as desktop users. */}
        <div className="flex items-center gap-1 border border-border rounded-lg p-0.5 bg-card shrink-0">
          {(['compact', 'wide', 'extra']).map((d) => (
            <button
              key={d}
              onClick={() => setDensity(d)}
              className={
                'px-2 md:px-2.5 py-1 text-[10px] font-semibold rounded-md transition uppercase tracking-wider ' +
                (density === d
                  ? 'bg-amber-400 text-bg'
                  : 'text-subtle hover:text-fg')
              }
              title={`${DENSITY_PRESETS[d].maxExpirations} expirations · ${DENSITY_PRESETS[d].maxStrikes} strikes · ATM ±${Math.round(DENSITY_PRESETS[d].strikeWindowPct * 100)}%`}
            >
              {DENSITY_PRESETS[d].label}
            </button>
          ))}
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

      {/* Ticker picker — horizontal scroll keeps the grid mobile-friendly.
          Watchlist tickers come first (with a star) so the user's own picks
          are reachable without scrolling past the curated list. Pro-only
          tickers render with a lock affordance so free users see what
          they'd unlock rather than the list silently being shorter. */}
      <div className="lg:hidden -mx-4 px-4 overflow-x-auto">
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
          {/* Search-anything pill — same drawer the title button opens.
              Sits at the end of the curated chip row so users in the
              chip-tapping mental model still discover the full-universe
              search. */}
          <button
            onClick={() => setDrawerOpen(true)}
            className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-full border border-dashed border-border text-xs font-medium text-subtle hover:text-fg hover:border-border-hover transition"
          >
            <Search size={11} />
            Search any ticker
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
              <div className="text-xs text-subtle flex items-center gap-2 flex-wrap">
                <span>
                  {data.expirations?.length ?? 0} expirations · {data.strikes?.length ?? 0} strikes
                </span>
                <SourceBadge source={data.source} />
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
          <SourceBadge source={data.source} />
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

function SourceBadge({ source }) {
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
  return null
}

function isWithinRth() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  })
  const parts = fmt.formatToParts(new Date())
  const wd = parts.find((p) => p.type === 'weekday')?.value
  const hour = Number(parts.find((p) => p.type === 'hour')?.value)
  const minute = Number(parts.find((p) => p.type === 'minute')?.value)
  if (wd === 'Sat' || wd === 'Sun') return false
  const t = hour * 60 + minute
  return t >= 9 * 60 + 30 && t < 16 * 60
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
