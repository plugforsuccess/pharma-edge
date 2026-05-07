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

function gexColor(gex, maxAbs) {
  if (gex == null || !Number.isFinite(gex) || maxAbs <= 0) {
    return 'transparent'
  }
  const t = Math.min(1, Math.abs(gex) / maxAbs)
  const rgb = gex >= 0 ? lerpStops(POSITIVE_STOPS, t) : lerpStops(NEGATIVE_STOPS, t)
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`
}

export default function GexMatrix({ data }) {
  const expirations = data?.expirations ?? []
  const strikes = data?.strikes ?? []
  const cells = data?.cells ?? []
  const spot = data?.spot ?? null
  const largest = data?.largest ?? null

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
        No GEX data to display.
      </div>
    )
  }

  return (
    <div className="font-mono-tab text-xs">
      {/* Header row — sticky-ish; doesn't actually stick on iOS Safari
          inside an overflow scroll, so we just leave it at the top. */}
      <div className="grid mb-px" style={gridCols(expirations.length)}>
        <div className="px-2 py-1.5 text-fg font-semibold tabular-nums">
          Strike
        </div>
        {expirations.map((e) => (
          <div
            key={e.date}
            className="px-2 py-1.5 text-right text-fg font-semibold leading-tight"
            title={`${e.dte} days to expiration`}
          >
            <div>{formatExpHeader(e.date)}</div>
            <div className="text-[9px] text-subtle font-normal">{e.dte}d</div>
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
                'px-2 py-1.5 font-semibold tabular-nums flex items-center gap-1 ' +
                (isSpotRow
                  ? 'text-amber-400 bg-amber-400/10'
                  : 'text-fg bg-bg-elev/40')
              }
              title={isSpotRow ? `Spot ${formatStrike(spot)}` : undefined}
            >
              {isSpotRow && (
                <span className="text-amber-400 text-[10px]" aria-hidden>
                  ▶
                </span>
              )}
              {formatStrike(strike)}
            </div>
            {cells[i].map((v, j) => {
              const isLargest =
                largest &&
                largest.strike_index === i &&
                largest.expiration_index === j
              return (
                <div
                  key={j}
                  className="px-2 py-1.5 text-right tabular-nums text-fg flex items-center justify-end gap-1"
                  style={{ backgroundColor: gexColor(v, maxAbs) }}
                >
                  {isLargest && <span className="text-[10px]">★</span>}
                  <span>{formatGex(v)}</span>
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

function gridCols(numExpirations) {
  // 60px strike column + equal share for each expiration.
  return {
    gridTemplateColumns: `60px repeat(${numExpirations}, minmax(0, 1fr))`,
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
