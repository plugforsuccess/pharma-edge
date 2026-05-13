// ConvictionDots — 5-dot conviction display.
//
// Inputs:
//   ev_edge_bp — EV edge in basis points over breakeven PoP (can be null).
// Output:
//   A 5-dot row where filled-dot count reflects conviction strength:
//     5 dots = LOUD top (ev >= 2000 bp)
//     4 dots = LOUD
//     3 dots = CLEAR top
//     2 dots = CLEAR
//     1 dot  = FAINT top
//     0 dots = FAINT bottom
//   Null/unknown edge = 0 dots, muted color.
//
// Used in the feed (within-tier ranking) and the detail page header.

const TIER_COLORS = {
  LOUD:  { fill: '#5ad19a', empty: '#1f3a2c' },  // emerald
  CLEAR: { fill: '#f4cf8e', empty: '#3a2f1c' },  // amber
  FAINT: { fill: '#8a8a99', empty: '#2a2a36' },  // zinc
}

export function tierFor(edge) {
  const e = Number(edge ?? 0)
  if (e >= 1500) return 'LOUD'
  if (e >= 500) return 'CLEAR'
  return 'FAINT'
}

function dotsFor(edge) {
  const e = Number(edge ?? -Infinity)
  if (!Number.isFinite(e)) return 0
  if (e >= 2000) return 5
  if (e >= 1500) return 4
  if (e >= 1000) return 3
  if (e >= 500) return 2
  if (e >= 0) return 1
  return 0
}

export default function ConvictionDots({ edge, size = 'sm' }) {
  const tier = tierFor(edge)
  const filled = dotsFor(edge)
  const color = TIER_COLORS[tier]
  const dotSize = size === 'lg' ? 8 : 6

  return (
    <div className="flex items-center gap-[3px]" aria-label={`${tier} conviction, ${filled}/5`}>
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className="rounded-full block"
          style={{
            width: dotSize,
            height: dotSize,
            background: i < filled ? color.fill : color.empty,
          }}
        />
      ))}
    </div>
  )
}
