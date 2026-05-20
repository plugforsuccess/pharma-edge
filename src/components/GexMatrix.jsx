import { useMemo } from 'react'

// 2D heatmap: strikes (rows) × expirations (columns).
//
// Each cell's background color encodes its GEX magnitude on a viridis
// gradient (positive) or magenta-purple gradient (negative). Color
// scale uses the absolute max across the whole matrix so cells are
// visually comparable. Spot row gets a black bg + ▶ marker; the
// largest absolute cell gets a ★.
//
// Mobile constraint: max-w-md (~448px) means we can fit ~4 expiration
// columns + a 60px strike column. Wider screens just look spacier.

const POSITIVE_STOPS = [
  // dark navy → blue → teal → green → lime → yellow
  { at: 0.0, rgb: [21, 41, 94] },
  { at: 0.2, rgb: [58, 93, 160] },
  { at: 0.4, rgb: [45, 173, 187] },
  { at: 0.6, rgb: [61, 168, 86] },
  { at: 0.8, rgb: [163, 230, 53] },
  { at: 1.0, rgb: [250, 204, 21] },
]

const NEGATIVE_STOPS = [
  // dark navy → indigo → purple → magenta
  { at: 0.0, rgb: [21, 41, 94] },
  { at: 0.4, rgb: [76, 29, 149] },
  { at: 0.7, rgb: [134, 25, 143] },
  { at: 1.0, rgb: [217, 46, 155] },
]

function lerpStops(stops, t) {
  if (t <= 0) return stops[0].rgb
  if (t >= 1) return stops[stops.length - 1].rgb
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]
    const b = stops[i + 1]
    if (t >= a.at && t <= b.at) {
      const localT = (t - a.at) / (b.at - a.at)
      return [
        Math.round(a.rgb[0] + localT * (b.rgb[0] - a.rgb[0])),
        Math.round(a.rgb[1] + localT * (b.rgb[1] - a.rgb[1])),
        Math.round(a.rgb[2] + localT * (b.rgb[2] - a.rgb[2])),
      ]
    }
  }
  return stops[stops.length - 1].rgb
}

export function gexColor(gex, maxAbs) {
  if (gex == null || !Number.isFinite(gex) || maxAbs <= 0) {
    return 'transparent'
  }
  const t = Math.min(1, Math.abs(gex) / maxAbs)
  const rgb = gex >= 0 ? lerpStops(POSITIVE_STOPS, t) : lerpStops(NEGATIVE_STOPS, t)
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`
}

// Map an exposureType prop to the cells array on the matrix payload.
// 'gex' is the default and reads `data.cells` for back-compat with
// older snapshot payloads that pre-date the multi-exposure response.
const CELLS_FIELD = {
  gex: 'cells',
  vex: 'vex_cells',
  cex: 'cex_cells',
  dex: 'dex_cells',
  velocity: 'velocity_cells',
}

export default function GexMatrix({ data, liveSpot = null, exposureType = 'gex', wallsOnly = false }) {
  const expirations = data?.expirations ?? []
  const strikes = data?.strikes ?? []
  const cellsField = CELLS_FIELD[exposureType] ?? 'cells'
  const cells = data?.[cellsField] ?? []
  // Velocity overlay (Skylit-style ∆% chips on gamma cells). Always
  // pulled from data.velocity_cells regardless of active view — used
  // by the gamma layer; ignored by velocity layer itself (where the
  // delta IS the value being colored).
  const velocityCells = exposureType === 'gex' ? (data?.velocity_cells ?? null) : null

  // Walls-only filter: per-expiration top-3 by abs value. Encoded as
  // (i * 10000 + j) so we can use a flat Set instead of a 2D bitmap —
  // strikes never exceed 5000 rows in practice. When wallsOnly is off
  // the set is null and the predicate short-circuits to "show all".
  const wallSet = useMemo(() => {
    if (!wallsOnly || cells.length === 0) return null
    const N = 3
    const set = new Set()
    for (let j = 0; j < expirations.length; j++) {
      const colCells = []
      for (let i = 0; i < strikes.length; i++) {
        const v = cells[i]?.[j]
        if (v != null && Number.isFinite(v)) {
          colCells.push({ i, abs: Math.abs(v) })
        }
      }
      colCells.sort((a, b) => b.abs - a.abs)
      for (let k = 0; k < Math.min(N, colCells.length); k++) {
        set.add(colCells[k].i * 10000 + j)
      }
    }
    return set
  }, [wallsOnly, cells, strikes.length, expirations.length])
  // The matrix snapshot's `spot` is from when compute-gex ran (cached
  // 5 min server-side). For the cursor row to actually look live the
  // way the LIVE badge implies, we accept an optional `liveSpot`
  // override polled from dxlink_quotes — falls back to snapshot spot.
  const spot = Number.isFinite(liveSpot) && liveSpot > 0 ? liveSpot : data?.spot ?? null
  // The `largest` highlight is only meaningful for the GEX layer —
  // it's the single most important strike for dealer hedging. The
  // other exposure layers have their own peaks but the backend
  // doesn't track them; the star marker stays GEX-only by design.
  const largest = exposureType === 'gex' ? (data?.largest ?? null) : null

  const maxAbs = useMemo(() => {
    let m = 0
    for (const row of cells) {
      for (const v of row) {
        if (v != null && Number.isFinite(v) && Math.abs(v) > m) m = Math.abs(v)
      }
    }
    return m
  }, [cells])

  // Find the index of the strike closest to spot. Strikes are sorted
  // descending, so we pick the first one at or below spot — that's the
  // row Skylit-style highlights with a ▶ marker. Falls back to the
  // closest absolute distance if the list is unusual.
  // Strikes are integer-spaced ($1) but spot ticks in pennies. We
  // compute the row index AND the fractional position between two
  // adjacent strikes so the cursor line can interpolate between rows
  // and visibly move as spot moves sub-dollar.
  const spotStrikeIndex = useMemo(() => {
    if (spot == null || strikes.length === 0) return -1
    for (let i = 0; i < strikes.length; i++) {
      if (strikes[i] <= spot) {
        if (i > 0 && Math.abs(strikes[i - 1] - spot) < Math.abs(strikes[i] - spot)) {
          return i - 1
        }
        return i
      }
    }
    return strikes.length - 1
  }, [strikes, spot])

  if (strikes.length === 0 || expirations.length === 0) {
    return (
      <div className="text-center text-subtle text-sm py-8">
        No {exposureType.toUpperCase()} data to display.
      </div>
    )
  }

  // Velocity requires a prior snapshot to diff against. When the
  // backend couldn't find one in the 5min–4hr window, velocity_cells
  // comes back null and we render a clear empty state instead of an
  // unstyled blank grid.
  if (exposureType === 'velocity' && (cells == null || cells.length === 0 || cells.every((row) => row.every((v) => v == null)))) {
    return (
      <div className="text-center text-subtle text-sm py-12 px-6 leading-relaxed">
        <div className="font-semibold text-fg mb-1">Not enough history yet</div>
        <div className="text-xs">
          Velocity Mode needs at least one prior snapshot 5+ min old to
          diff against. Come back in a few minutes — the 5-min archive
          cron will fill the gap.
        </div>
      </div>
    )
  }

  return (
    // Horizontal scroll container — when the matrix has more
    // expirations than fit in the viewport (10+ on mobile), the user
    // swipes left/right. Strike column is sticky-left so it stays
    // visible during swipe, which is essential for reading rows.
    // touch-pan-x explicitly opts the container into horizontal
    // gestures so iOS doesn't interpret a left-swipe as back-nav.
    <div className="font-mono-tab text-xs overflow-x-auto -mx-4 px-4 lg:mx-0 lg:px-0 touch-pan-x">
      <div className="min-w-max">
        <div className="grid mb-px" style={gridCols(expirations.length)}>
          <div className="px-2 py-1.5 text-fg font-semibold tabular-nums sticky left-0 z-10 bg-bg-card">
            Strike
          </div>
          {expirations.map((e) => (
            <div
              key={e.date}
              className="px-2 py-1.5 text-right text-fg font-semibold leading-tight"
              title={`${e.dte} days to expiration`}
            >
              <div>{formatExpHeader(e.date)}</div>
              <div className="text-[10px] text-subtle font-normal">{e.dte}d</div>
            </div>
          ))}
        </div>

        {strikes.map((strike, i) => {
          const isSpotRow = i === spotStrikeIndex
          return (
            <div
              key={strike}
              className={
                'grid ' +
                (isSpotRow
                  ? 'ring-1 ring-amber-400/40 bg-amber-400/5'
                  : '')
              }
              style={gridCols(expirations.length)}
            >
              <div
                className={
                  'px-2 py-1.5 font-semibold tabular-nums flex items-center gap-1 sticky left-0 z-10 ' +
                  (isSpotRow
                    ? 'text-amber-400 bg-amber-400/10'
                    : 'text-fg bg-bg-elev/40')
                }
                title={isSpotRow && Number.isFinite(liveSpot) ? `Spot $${Number(liveSpot).toFixed(2)}` : isSpotRow ? `Spot ${formatStrike(spot)}` : undefined}
              >
                {isSpotRow && (
                  <span className="text-amber-400 text-[10px]" aria-hidden>
                    ▶
                  </span>
                )}
                <span>{formatStrike(strike)}</span>
              </div>
              {cells[i].map((v, j) => {
                const isLargest =
                  largest &&
                  largest.strike_index === i &&
                  largest.expiration_index === j
                const isWall = wallSet == null || wallSet.has(i * 10000 + j)
                // Velocity chip: ∆GEX as a % of the cell's current GEX,
                // only rendered on the gamma view (other layers have no
                // velocity_cells parity). Hidden entirely when wallsOnly
                // is on but the cell isn't a wall — keeps the dimmed
                // grid clean.
                //
                // Two noise filters:
                //   * Magnitude floor: |v| must be ≥1% of the chart's
                //     maxAbs. Below that the cell is too quiet for the
                //     ratio to mean anything (∆ / tiny denominator
                //     produces triple-digit nonsense chips on far-OTM
                //     strikes).
                //   * Cap at ±99% so chips stay 2-digit. Anything past
                //     the cap clamps and reads as "+99%" / "-99%".
                let velocityChip = null
                if (
                  exposureType === 'gex' &&
                  velocityCells &&
                  isWall &&
                  v != null && Number.isFinite(v) && v !== 0 &&
                  Math.abs(v) >= maxAbs * 0.01
                ) {
                  const vVel = velocityCells[i]?.[j]
                  if (vVel != null && Number.isFinite(vVel)) {
                    const pct = (vVel / Math.abs(v)) * 100
                    if (Number.isFinite(pct) && Math.abs(pct) >= 2) {
                      const capped = Math.max(-99, Math.min(99, pct))
                      const sign = capped >= 0 ? '+' : ''
                      const tone = capped >= 0
                        ? 'bg-emerald-500/25 text-emerald-200'
                        : 'bg-rose-500/25 text-rose-200'
                      velocityChip = (
                        <span
                          className={`text-[8px] leading-none font-semibold px-1 py-0.5 rounded ${tone}`}
                          title={`${pct.toFixed(0)}% vs prior 5m snapshot (clamped to ±99%)`}
                        >
                          {sign}{Math.round(capped)}%
                        </span>
                      )
                    }
                  }
                }
                return (
                  <div
                    key={j}
                    className={
                      'px-2 py-1.5 text-right tabular-nums flex items-center justify-end gap-1 ' +
                      (isWall ? 'text-fg' : 'text-subtle opacity-20')
                    }
                    style={{ backgroundColor: isWall ? gexColor(v, maxAbs) : 'transparent' }}
                  >
                    {velocityChip}
                    {isLargest && <span className="text-[10px]">★</span>}
                    <span>{formatGex(v)}</span>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function gridCols(numExpirations) {
  // Strike column has a hard 64px width so the sticky-left position
  // works predictably; expiration columns get a minimum 72px so they
  // don't squeeze unreadable when 10+ are visible. Total grid width
  // exceeds container on mobile, which is what triggers the
  // overflow-x-auto scroll. Desktop with fewer expirations: still
  // expands to 1fr per column thanks to the minmax upper bound.
  return {
    gridTemplateColumns: `64px repeat(${numExpirations}, minmax(72px, 1fr))`,
  }
}

function formatStrike(v) {
  if (v == null) return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return n >= 1000 ? n.toFixed(0) : n.toFixed(1)
}

function formatGex(v) {
  if (v == null) return ''
  const n = Number(v)
  if (!Number.isFinite(n) || n === 0) return ''
  const sign = n >= 0 ? '' : '−'
  const abs = Math.abs(n)
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`
  return `${sign}$${abs.toFixed(0)}`
}

// "2025-11-12" → "11-12" so the column header stays narrow on mobile.
function formatExpHeader(date) {
  if (!date) return ''
  const parts = date.split('-')
  if (parts.length !== 3) return date
  return `${parts[1]}-${parts[2]}`
}
