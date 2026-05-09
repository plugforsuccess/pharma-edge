import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import Spinner from './Spinner'
import { gexColor } from './GexMatrix'

// 3-ticker side-by-side comparison view ("Trinity" mode). Renders the
// three GEX matrices as parallel columns at the same time so the user
// can read SPXW / SPY / QQQ dealer positioning in one glance — that's
// the whole point of the mode.
//
// Each column is a compact strike → summed-GEX list (one row per
// strike, GEX summed across all expirations in the matrix slice), not
// the full multi-expiration grid that the single-ticker view shows.
// Three full grids would each need ~400px of width — they don't fit
// side-by-side on phone. Collapsing to a single per-strike summary
// trades expiration breakdown for simultaneous comparison, which is
// the right trade for this mode.
//
// ATM strike per column is auto-scrolled into view on mount so all
// three land on a useful row instead of pinned to the top of each
// chain.

const DEFAULT_TRIO = ['SPXW', 'SPY', 'QQQ']

export default function TrinityView({ initialTickers }) {
  const [tickers] = useState(initialTickers ?? DEFAULT_TRIO)

  return (
    <div className="space-y-2">
      <div className="text-[11px] text-subtle leading-relaxed px-1">
        <strong className="text-fg">Trinity:</strong> three matrices
        side-by-side. The default trio (SPXW / SPY / QQQ) is the
        index dealer-positioning headline.
      </div>

      {/* Three columns, equal width. -mx-2 lets the cards bleed to
          the edge of the page so we recover horizontal space lost to
          the surrounding Markets padding — same trick the GexMatrix
          uses on mobile. */}
      <div className="grid grid-cols-3 gap-1 -mx-2 sm:mx-0">
        {tickers.map((t) => (
          <TrinityColumn key={t} ticker={t} />
        ))}
      </div>
    </div>
  )
}

function TrinityColumn({ ticker }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  async function load(refresh = false) {
    setLoading(true)
    setError(null)
    try {
      const { data: result, error: err } = await supabase.functions.invoke(
        'compute-gex',
        { body: { ticker, matrix: true, refresh } },
      )
      if (err) throw err
      if (!result?.success) throw new Error(result?.error || 'compute-gex failed')
      setData(result.data)
    } catch (e) {
      setError(e.message || 'failed')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker])

  // Per-strike GEX = sum across all expirations in the matrix slice.
  // The dxlink worker subscribes to front-2 expirations within ATM ±
  // 25%, so this is bounded — we're not hiding tail risk by
  // collapsing.
  const rows = useMemo(() => {
    if (!data) return []
    const strikes = data.strikes ?? []
    const cells = data.cells ?? []
    return strikes.map((strike, i) => {
      const row = cells[i] ?? []
      const gex = row.reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0)
      return { strike, gex }
    })
  }, [data])

  const maxAbs = useMemo(() => {
    let m = 0
    for (const r of rows) {
      const v = Math.abs(r.gex)
      if (Number.isFinite(v) && v > m) m = v
    }
    return m
  }, [rows])

  // Wall = largest absolute cell. Mirrors the ★ marker in the
  // single-ticker matrix.
  const wallStrike = useMemo(() => {
    if (rows.length === 0) return null
    let max = 0
    let s = null
    for (const r of rows) {
      const v = Math.abs(r.gex)
      if (v > max) {
        max = v
        s = r.strike
      }
    }
    return s
  }, [rows])

  // Strike-row index nearest spot. Strikes are sorted descending in the
  // matrix payload; we pick the first one ≤ spot, then nudge up if the
  // strike above is closer (typical when spot lands between $1 strikes).
  const spotIdx = useMemo(() => {
    if (!data?.spot || rows.length === 0) return -1
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].strike <= data.spot) {
        if (
          i > 0 &&
          Math.abs(rows[i - 1].strike - data.spot) <
            Math.abs(rows[i].strike - data.spot)
        ) {
          return i - 1
        }
        return i
      }
    }
    return rows.length - 1
  }, [rows, data?.spot])

  // Auto-scroll the ATM row into view once data arrives. We scroll
  // the per-column container (each column is independently scrollable
  // so all three can land on their own ATM without coupling). One
  // shot — we don't re-center on every spot tick or it becomes a
  // jitter loop.
  const scrollRef = useRef(null)
  const didCenter = useRef(false)
  useEffect(() => {
    if (didCenter.current) return
    if (spotIdx < 0 || !scrollRef.current) return
    const row = scrollRef.current.querySelector(`[data-row="${spotIdx}"]`)
    if (row && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'center', behavior: 'auto' })
      didCenter.current = true
    }
  }, [spotIdx, rows.length])

  const realizedToday = data?.realized_move_today
  const realizedTodayPct = data?.realized_move_today_pct
  const changeColor =
    realizedToday == null
      ? 'text-muted'
      : realizedToday >= 0
        ? 'text-green-400'
        : 'text-crimson'

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden flex flex-col min-h-0">
      <div className="px-1.5 py-1.5 border-b border-border bg-bg-card flex items-baseline justify-between gap-1 sticky top-0 z-10">
        <div className="min-w-0">
          <div className="text-[11px] sm:text-xs font-semibold tracking-tight text-fg truncate">
            {data?.ticker ?? ticker}
          </div>
          <div className="text-[9px] sm:text-[10px] text-subtle font-mono-tab truncate">
            {data?.spot != null ? `$${formatNum(data.spot)}` : '—'}
            {realizedTodayPct != null && (
              <span className={`ml-1 ${changeColor}`}>
                {realizedTodayPct >= 0 ? '+' : ''}
                {(realizedTodayPct * 100).toFixed(2)}%
              </span>
            )}
          </div>
        </div>
        <button
          onClick={() => load(true)}
          disabled={loading}
          className="text-[9px] text-muted hover:text-fg disabled:opacity-50 px-1"
          aria-label={`Refresh ${ticker}`}
        >
          {loading ? '…' : '↻'}
        </button>
      </div>

      <div
        ref={scrollRef}
        className="overflow-y-auto max-h-[70vh] font-mono-tab"
      >
        {loading && !data && (
          <div className="py-6 flex justify-center">
            <Spinner size="sm" />
          </div>
        )}
        {!loading && error && (
          <p className="px-2 py-3 text-[10px] text-crimson leading-snug">
            {error}
          </p>
        )}
        {!loading && !error && rows.length === 0 && data && (
          <p className="px-2 py-3 text-[10px] text-subtle leading-snug">
            No GEX data
          </p>
        )}
        {rows.map((r, i) => {
          const isAtm = i === spotIdx
          const isWall = r.strike === wallStrike && maxAbs > 0
          return (
            <div
              key={r.strike}
              data-row={i}
              className={`grid grid-cols-[40%_60%] items-center text-[10px] sm:text-[11px] ${
                isAtm ? 'bg-bg-elev/60 ring-1 ring-amber-400/30' : ''
              }`}
            >
              <div
                className={`px-1.5 py-1 flex items-center gap-0.5 tabular-nums ${
                  isAtm ? 'text-amber-400 font-semibold' : 'text-fg'
                }`}
              >
                {isAtm && (
                  <span className="text-amber-400 text-[9px]" aria-hidden>
                    ▶
                  </span>
                )}
                {formatStrike(r.strike)}
              </div>
              <div
                className={`px-1.5 py-1 text-right tabular-nums flex items-center justify-end gap-0.5 ${
                  isWall ? 'font-semibold' : ''
                }`}
                style={{ backgroundColor: gexColor(r.gex, maxAbs) }}
              >
                {isWall && <span className="text-[9px]">★</span>}
                <span className={contrastTextClass(r.gex, maxAbs)}>
                  {formatGex(r.gex)}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// White on top of saturated cells, light grey on cold/empty cells.
// Mirrors the contrast logic the single-ticker matrix uses
// implicitly (the saturated viridis colors are dark enough that the
// default Tailwind `text-fg` reads fine — but at the dark-navy /
// transparent end the same color disappears).
function contrastTextClass(gex, maxAbs) {
  if (gex == null || !Number.isFinite(gex) || maxAbs <= 0) {
    return 'text-subtle'
  }
  const t = Math.abs(gex) / maxAbs
  return t < 0.15 ? 'text-subtle' : 'text-white'
}

function formatNum(v) {
  if (v == null) return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return n.toFixed(2)
}

function formatStrike(v) {
  if (v == null) return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  // SPXW strikes run to 4 digits ($6850), SPY/QQQ to 3. The 60%-
  // width cell handles the variance — we just print whole numbers
  // since the sub-dollar resolution doesn't matter here.
  return n >= 1000 ? n.toFixed(0) : n.toFixed(1)
}

function formatGex(v) {
  if (v == null || !Number.isFinite(v) || v === 0) return ''
  const sign = v >= 0 ? '' : '−'
  const abs = Math.abs(v)
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`
  return `${sign}$${abs.toFixed(0)}`
}
