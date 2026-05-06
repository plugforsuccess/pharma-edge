// Tiny inline-SVG sparkline. Pass an array of numeric values; it draws
// a smooth path scaled to fit width × height. Used by TrackRecord
// (cumulative P&L curve) and PublicRecord (shareable shape of the
// record). Renders nothing for empty / single-point arrays.

export default function Sparkline({
  values,
  width = 240,
  height = 48,
  stroke = '#e8b558',
  fillFromZero = true,
}) {
  if (!Array.isArray(values) || values.length < 2) return null
  const n = values.length
  const min = Math.min(0, ...values)
  const max = Math.max(0, ...values)
  const range = max - min || 1
  const stepX = width / (n - 1)

  const toY = (v) => height - ((v - min) / range) * height

  const linePoints = values
    .map((v, i) => `${(i * stepX).toFixed(2)},${toY(v).toFixed(2)}`)
    .join(' L ')

  // Filled area under (or above) the zero line so gain/loss reads
  // visually even on a tiny canvas.
  const zeroY = toY(0)
  const last = values[n - 1]
  const lastTone = last > 0 ? '#00c805' : last < 0 ? '#ef4444' : '#8b8ba6'

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Trend sparkline"
      className="block"
    >
      {fillFromZero && (
        <>
          <path
            d={`M 0,${zeroY.toFixed(2)} L ${linePoints} L ${width.toFixed(2)},${zeroY.toFixed(2)} Z`}
            fill={lastTone}
            opacity="0.12"
          />
          <line
            x1="0"
            x2={width}
            y1={zeroY.toFixed(2)}
            y2={zeroY.toFixed(2)}
            stroke="rgba(255,255,255,0.08)"
            strokeWidth="1"
            strokeDasharray="2 3"
          />
        </>
      )}
      <path
        d={`M ${linePoints}`}
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle
        cx={(width).toFixed(2)}
        cy={toY(last).toFixed(2)}
        r="2.5"
        fill={lastTone}
      />
    </svg>
  )
}
