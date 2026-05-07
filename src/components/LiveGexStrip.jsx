import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowDownRight, ArrowUpRight, Activity } from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../lib/supabase'

// Live GEX strip on The Tape. One card per watched ticker, each showing
// spot, Flip (zero-gamma), Wall (largest |gex_net|), and the dealer-positioning
// regime (positive = dealers stabilize, negative = dealers amplify).
//
// Calls compute-gex non-matrix mode per ticker (5-min cached server-side via
// gex_snapshots, so a refresh of the Tape is cheap). Tapping a card jumps
// straight into Markets focused on that ticker.

const TAPE_TICKERS = ['SPY', 'QQQ', 'IWM', 'NVDA', 'TSLA']

export default function LiveGexStrip() {
  const navigate = useNavigate()
  const [rows, setRows] = useState(() =>
    TAPE_TICKERS.map((t) => ({ ticker: t, status: 'loading' })),
  )

  useEffect(() => {
    let cancelled = false
    async function loadAll() {
      // Fetch in parallel — each call is cheap (cached) and they're
      // independent. Order is preserved by index.
      const results = await Promise.all(
        TAPE_TICKERS.map(async (ticker) => {
          try {
            const { data: result, error } = await supabase.functions.invoke(
              'compute-gex',
              { body: { ticker, preferred_dte: 7 } },
            )
            if (error || !result?.success) {
              return { ticker, status: 'error' }
            }
            return { ticker, status: 'ok', payload: result.data }
          } catch {
            return { ticker, status: 'error' }
          }
        }),
      )
      if (!cancelled) setRows(results)
    }
    loadAll()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section className="mb-5">
      <div className="flex items-end justify-between mb-2.5">
        <div>
          <p className="eyebrow">Dealer Positioning</p>
          <h2 className="font-display text-base text-fg mt-0.5">The Tape</h2>
        </div>
        <button
          onClick={() => navigate('/markets')}
          className="text-[11px] text-subtle hover:text-fg transition-colors"
        >
          All markets →
        </button>
      </div>

      {/* Horizontal scroll on mobile, grid on desktop. Snap-x keeps the
          mobile scroll feeling deliberate rather than free. */}
      <div
        className="flex gap-2 overflow-x-auto snap-x snap-mandatory pb-1 -mx-1 px-1
                   lg:grid lg:grid-cols-5 lg:gap-2 lg:overflow-visible lg:px-0 lg:mx-0"
      >
        {rows.map((row) => (
          <GexCard
            key={row.ticker}
            row={row}
            onClick={() => navigate(`/markets?ticker=${row.ticker}`)}
          />
        ))}
      </div>
    </section>
  )
}

function GexCard({ row, onClick }) {
  if (row.status === 'loading') {
    return (
      <div className="surface rounded-xl px-3 py-2.5 min-w-[145px] snap-start animate-pulse">
        <div className="h-3 w-10 bg-white/[0.05] rounded mb-2" />
        <div className="h-5 w-16 bg-white/[0.05] rounded mb-2" />
        <div className="h-2 w-20 bg-white/[0.04] rounded" />
      </div>
    )
  }
  if (row.status === 'error') {
    return (
      <button
        onClick={onClick}
        className="surface surface-hover rounded-xl px-3 py-2.5 min-w-[145px] snap-start text-left"
      >
        <div className="text-fg font-mono-tab text-[13px] font-semibold">
          {row.ticker}
        </div>
        <div className="text-muted text-[10px] mt-1">no data</div>
      </button>
    )
  }

  const d = row.payload
  const flip = d.zero_gamma_strike
  // The "Wall" = the dominant dealer position. In a positive-gamma regime
  // the call wall (largest positive strike) is acting as resistance; in a
  // negative regime the put wall (largest negative strike) is the floor.
  const positiveRegime = d.total_gex >= 0
  const wallStrike = positiveRegime
    ? d.largest_positive_strike
    : d.largest_negative_strike
  const aboveFlip = flip != null && d.spot >= flip
  const TrendIcon = aboveFlip ? ArrowUpRight : ArrowDownRight
  const spotTone = aboveFlip ? 'text-green-400' : 'text-[#f25068]'

  return (
    <button
      onClick={onClick}
      className="surface surface-hover rounded-xl px-3 py-2.5 min-w-[145px] snap-start text-left
                 group transition-transform active:scale-[0.98]"
    >
      <div className="flex items-center justify-between mb-1.5">
        <span className="font-mono-tab text-fg font-semibold text-[13px] tracking-tight">
          {row.ticker}
        </span>
        <span
          className={clsx(
            'inline-flex items-center gap-0.5 text-[9px] uppercase tracking-wider font-semibold',
            positiveRegime ? 'text-green-400/80' : 'text-[#f25068]/80',
          )}
          title={
            positiveRegime
              ? 'Net positive gamma — dealers dampen moves'
              : 'Net negative gamma — dealers amplify moves'
          }
        >
          <Activity size={9} strokeWidth={2.5} />
          {positiveRegime ? '+γ' : '−γ'}
        </span>
      </div>

      <div className={clsx('font-display text-[18px] leading-none num-tab flex items-baseline gap-1', spotTone)}>
        <TrendIcon size={11} strokeWidth={2.5} className="opacity-80 self-center" />
        ${formatPrice(d.spot)}
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-muted">
        <span className="truncate">
          <span className="text-subtle">Flip </span>
          <span className="font-mono-tab text-fg/80">
            {flip != null ? `$${formatPrice(flip)}` : '—'}
          </span>
        </span>
        <span className="truncate text-right">
          <span className="text-subtle">Wall </span>
          <span className="font-mono-tab text-fg/80">
            {wallStrike != null ? `$${formatPrice(wallStrike)}` : '—'}
          </span>
        </span>
      </div>
    </button>
  )
}

function formatPrice(n) {
  if (n == null || !Number.isFinite(n)) return '—'
  return n >= 1000 ? n.toFixed(0) : n.toFixed(2).replace(/\.?0+$/, '')
}
