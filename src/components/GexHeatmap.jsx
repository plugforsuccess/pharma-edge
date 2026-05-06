import { useMemo } from 'react'

// GexHeatmap — strikes plotted vertically (highest at top), horizontal
// bars sized by |gex_net| and colored by sign. The spot price is drawn
// as a yellow horizontal divider; the zero-gamma flip strike (where
// cumulative GEX crosses zero, scanning from the lowest strike upward)
// gets a cyan marker.
//
// We keep this CSS-only — no Recharts — so the page stays light on
// bundle weight and renders fast on mobile.

export default function GexHeatmap({ data }) {
  const strikes = data?.strikes ?? []
  const spot = data?.spot ?? null
  const flipStrike = data?.zero_gamma_strike ?? null

  const maxAbs = useMemo(() => {
    let m = 0
    for (const s of strikes) {
      const a = Math.abs(s.gex_net)
      if (a > m) m = a
    }
    return m || 1
  }, [strikes])

  // Find the row index where spot would slot in among the strike list
  // (descending order). We render the spot indicator between rows.
  const ordered = useMemo(
    () => [...strikes].sort((a, b) => b.strike - a.strike),
    [strikes],
  )

  if (!data || ordered.length === 0) {
    return (
      <div className="text-center text-subtle text-sm py-8">
        No GEX data to display.
      </div>
    )
  }

  return (
    <div className="space-y-px">
      {ordered.map((row, idx) => {
        const next = ordered[idx + 1]
        const showSpot =
          spot != null && row.strike >= spot && (next == null || next.strike < spot)

        const pct = (Math.abs(row.gex_net) / maxAbs) * 100
        const isPos = row.gex_net >= 0
        const isFlip = flipStrike != null && row.strike === flipStrike

        return (
          <div key={row.strike}>
            <div className="flex items-center gap-2 text-xs">
              <div
                className={
                  'w-16 text-right font-mono-tab tabular-nums shrink-0 ' +
                  (isFlip ? 'text-cyan-400 font-semibold' : 'text-fg')
                }
              >
                {formatStrike(row.strike)}
                {isFlip && (
                  <span className="ml-1 text-[9px] uppercase tracking-wide">
                    flip
                  </span>
                )}
              </div>

              {/* Bars centered around a vertical zero line. Negative GEX
                  bars extend left; positive extends right. */}
              <div className="flex-1 flex items-center h-5 relative">
                <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
                <div className="w-1/2 flex justify-end pr-1">
                  {!isPos && (
                    <div
                      className="h-3 rounded-l-sm"
                      style={{
                        width: `${pct}%`,
                        background: 'linear-gradient(90deg, transparent, var(--color-crimson) 60%)',
                      }}
                    />
                  )}
                </div>
                <div className="w-1/2 flex justify-start pl-1">
                  {isPos && (
                    <div
                      className="h-3 rounded-r-sm"
                      style={{
                        width: `${pct}%`,
                        background: 'linear-gradient(90deg, #00c805 40%, transparent)',
                      }}
                    />
                  )}
                </div>
              </div>

              <div className="w-20 text-right font-mono-tab tabular-nums shrink-0 text-subtle">
                {formatGex(row.gex_net)}
              </div>
            </div>

            {showSpot && (
              <div className="flex items-center gap-2 my-1">
                <div className="w-16 text-right text-[10px] uppercase tracking-wider text-amber-400 font-semibold">
                  spot
                </div>
                <div className="flex-1 h-px bg-amber-400/60 shadow-[0_0_8px_rgba(251,191,36,0.4)]" />
                <div className="w-20 text-right font-mono-tab tabular-nums text-amber-300 text-xs">
                  {formatStrike(spot)}
                </div>
              </div>
            )}
          </div>
        )
      })}

      <Legend />
    </div>
  )
}

function Legend() {
  return (
    <div className="flex items-center gap-3 pt-3 mt-2 border-t border-border text-[10px] text-subtle">
      <div className="flex items-center gap-1">
        <span className="inline-block w-3 h-2 rounded-sm bg-green-600" />
        <span>call OI · positive GEX</span>
      </div>
      <div className="flex items-center gap-1">
        <span className="inline-block w-3 h-2 rounded-sm bg-crimson" />
        <span>put OI · negative</span>
      </div>
      <div className="flex items-center gap-1">
        <span className="inline-block w-3 h-px bg-amber-400" />
        <span>spot</span>
      </div>
    </div>
  )
}

function formatStrike(v) {
  if (v == null) return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return n >= 1000 ? n.toFixed(0) : n.toFixed(1)
}

function formatGex(v) {
  if (v == null) return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  const sign = n >= 0 ? '+' : '−'
  const abs = Math.abs(n)
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(1)}B`
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(0)}K`
  return `${sign}${abs.toFixed(0)}`
}
