// Equity curve with period toggle. Wraps the existing Sparkline.
//
// Props:
//   * points — Array<{ at: ISO string, realized_pnl: number }> (one per
//     closed position, in any order; the component sorts chronologically)
//   * className — optional wrapper styling
//
// Computes a cumulative running P&L array, filtered to the selected
// time period. Shows a big P&L number above the chart matching
// Polymarket's style.

import { useMemo, useState } from 'react'
import clsx from 'clsx'
import Sparkline from './Sparkline'

const PERIODS = [
  { key: '1D', label: '1D', ms: 24 * 60 * 60 * 1000 },
  { key: '1W', label: '1W', ms: 7 * 24 * 60 * 60 * 1000 },
  { key: '1M', label: '1M', ms: 30 * 24 * 60 * 60 * 1000 },
  { key: '3M', label: '3M', ms: 90 * 24 * 60 * 60 * 1000 },
  { key: 'ALL', label: 'ALL', ms: null },
]

export default function EquityCurve({ points, className }) {
  const [period, setPeriod] = useState('ALL')

  const { values, periodPnl } = useMemo(() => {
    if (!Array.isArray(points) || points.length === 0) {
      return { values: [], periodPnl: 0 }
    }
    const sorted = points
      .filter((p) => p?.at && Number.isFinite(Number(p.realized_pnl)))
      .map((p) => ({ at: new Date(p.at).getTime(), pnl: Number(p.realized_pnl) }))
      .sort((a, b) => a.at - b.at)

    const periodDef = PERIODS.find((p) => p.key === period)
    const cutoff = periodDef?.ms ? Date.now() - periodDef.ms : 0
    const inWindow = periodDef?.ms ? sorted.filter((p) => p.at >= cutoff) : sorted

    // Cumulative running pnl. If there are positions BEFORE the window
    // started, seed the curve at the pre-window cumulative so the
    // chart shows the period's incremental performance, not the
    // historical total.
    let preWindowCum = 0
    if (periodDef?.ms) {
      for (const p of sorted) {
        if (p.at < cutoff) preWindowCum += p.pnl
        else break
      }
    }
    let cum = preWindowCum
    const out = []
    for (const p of inWindow) {
      cum += p.pnl
      out.push(cum)
    }
    const periodPnl = out.length
      ? out[out.length - 1] - preWindowCum
      : 0
    return { values: out, periodPnl }
  }, [points, period])

  const periodLabel = PERIODS.find((p) => p.key === period)?.label
  const positive = periodPnl >= 0

  return (
    <div className={clsx('bg-card border border-border rounded-xl p-4', className)}>
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <p className="text-muted text-[10px] uppercase tracking-wider">
            {periodLabel} P&amp;L
          </p>
          <p
            className={clsx(
              'font-bold text-2xl font-mono-tab tabular-nums mt-0.5',
              positive ? 'text-green-400' : 'text-red-400',
            )}
          >
            {positive ? '+' : '−'}${Math.abs(periodPnl).toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </p>
        </div>
        <div className="flex gap-1">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setPeriod(p.key)}
              className={clsx(
                'px-2 py-1 rounded-md text-[10px] font-medium transition-colors',
                period === p.key
                  ? 'bg-zinc-800 text-white'
                  : 'text-muted hover:text-subtle',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {values.length >= 2 ? (
        <div className="w-full overflow-hidden">
          <Sparkline
            values={values}
            width={320}
            height={80}
            stroke={positive ? '#22c55e' : '#ef4444'}
          />
        </div>
      ) : (
        <div className="h-20 flex items-center justify-center">
          <p className="text-muted text-xs">
            {values.length === 0
              ? 'No closed trades in this period'
              : 'Need at least 2 trades for a curve'}
          </p>
        </div>
      )}
    </div>
  )
}
