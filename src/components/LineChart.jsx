import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'

// Small SVG line chart for holdings: value over time (before / after tax),
// with flat lines (cost, exit targets) and date markers (long-term date,
// roll window). No chart library — colors come from the theme tokens via
// Tailwind stroke / fill classes. Tap or drag across it to read a date;
// the readout above shows the last point otherwise.
//
//   series: [{ id, label, points: [{ t: ms, v }], stroke, text, dashed? }]
//   hLines: [{ v, label, stroke, text }]
//   vLines: [{ t, label }]
//   bands:  [{ from, to, fill }] — a shaded price range (e.g. a spread's profit zone)

const DAY_MS = 86400000
const PAD = { top: 10, right: 8, bottom: 22, left: 8 }

const shortDate = (t) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const axisDate = (t) => new Date(t).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }).replace(' ', " '")

export default function LineChart({ series, hLines = [], vLines = [], bands = [], height = 180, format = String, empty }) {
  const wrap = useRef(null)
  const [width, setWidth] = useState(320)
  const [hover, setHover] = useState(null)

  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return undefined
    const set = () => setWidth(Math.max(200, el.clientWidth))
    set()
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(set)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const all = series.flatMap((s) => s.points)
  const geo = useMemo(() => {
    if (all.length === 0) return null
    const ts = all.map((p) => p.t).concat(vLines.map((l) => l.t))
    let t0 = Math.min(...ts)
    let t1 = Math.max(...ts)
    if (t1 - t0 < DAY_MS) { t0 -= 15 * DAY_MS; t1 += 15 * DAY_MS }
    const vs = all.map((p) => p.v).concat(hLines.map((l) => l.v))
    let v0 = Math.min(...vs)
    let v1 = Math.max(...vs)
    const span = v1 - v0 || Math.abs(v1) || 1
    v0 -= span * 0.08
    v1 += span * 0.08
    const w = width - PAD.left - PAD.right
    const h = height - PAD.top - PAD.bottom
    const x = (t) => PAD.left + ((t - t0) / (t1 - t0)) * w
    const y = (v) => PAD.top + (1 - (v - v0) / (v1 - v0)) * h
    return { t0, t1, x, y, w, h }
  }, [all, vLines, hLines, width, height])

  if (!geo) {
    return <div ref={wrap} className="h-[120px] flex items-center justify-center text-xs text-muted">{empty ?? 'No data yet'}</div>
  }
  const { t0, t1, x, y } = geo

  // Readout: the hovered date, else the last point of the first series.
  const main = series[0]?.points ?? []
  const at = hover ?? main[main.length - 1]?.t
  const valueAt = (pts, t) => {
    let best = null
    for (const p of pts) if (p.t <= t + 1) best = p
    return best ?? pts[0]
  }

  function onPointer(e) {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * width
    const t = t0 + ((px - PAD.left) / (width - PAD.left - PAD.right)) * (t1 - t0)
    // Snap to the nearest point of the first series.
    let best = main[0]
    for (const p of main) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p
    setHover(best?.t ?? null)
  }

  const path = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')
  const ticks = [t0, t0 + (t1 - t0) / 2, t1]

  return (
    <div ref={wrap}>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mb-2 min-h-[22px]">
        <span className="text-xs text-muted">{at != null ? shortDate(at) : ''}</span>
        {series.map((s) => {
          const p = at != null && s.points.length ? valueAt(s.points, at) : null
          return p ? (
            <span key={s.id} className="text-xs text-muted">
              {s.label} <span className={clsx('font-mono-tab font-semibold', s.text)}>{format(p.v)}</span>
            </span>
          ) : null
        })}
      </div>
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img"
        aria-label={series.map((s) => s.label).join(' and ') + ' over time'}
        className="block touch-pan-y select-none"
        onPointerMove={onPointer} onPointerDown={onPointer} onPointerLeave={() => setHover(null)}>
        {bands.map((b) => (
          <rect key={`b-${b.from}-${b.to}`} x={PAD.left} width={width - PAD.left - PAD.right}
            y={y(Math.max(b.from, b.to))} height={Math.abs(y(b.from) - y(b.to))} className={b.fill} />
        ))}
        {hLines.map((l) => (
          <line key={`h-${l.label}-${l.v}`} x1={PAD.left} x2={width - PAD.right} y1={y(l.v)} y2={y(l.v)} className={clsx(l.stroke ?? 'stroke-border')} strokeDasharray="4 4" strokeWidth="1" />
        ))}
        {vLines.map((l) => {
          // Near the right edge the label sits left of its line.
          const flip = x(l.t) > width - 70
          return (
            <g key={`v-${l.label}`}>
              <line x1={x(l.t)} x2={x(l.t)} y1={PAD.top} y2={height - PAD.bottom} className="stroke-faint" strokeDasharray="3 3" strokeWidth="1" />
              <text x={x(l.t) + (flip ? -3 : 3)} y={height - PAD.bottom - 4} textAnchor={flip ? 'end' : 'start'} className="fill-muted text-[10px]">{l.label}</text>
            </g>
          )
        })}
        {series.map((s) => (
          <g key={s.id}>
            <path d={path(s.points)} fill="none" className={s.stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" strokeDasharray={s.dashed ? '5 4' : undefined} />
            {s.points.length <= 40 && s.points.map((p) => (
              <circle key={p.t} cx={x(p.t)} cy={y(p.v)} r="2.5" className={clsx(s.stroke, 'fill-card')} strokeWidth="1.5" />
            ))}
          </g>
        ))}
        {hLines.map((l) => (
          <text key={`ht-${l.label}-${l.v}`} x={width - PAD.right} y={y(l.v) - 4} textAnchor="end"
            className={clsx('text-[10px] stroke-card', l.text ?? 'fill-muted')} strokeWidth="3" style={{ paintOrder: 'stroke' }}>{l.label}</text>
        ))}
        {hover != null && (
          <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={height - PAD.bottom} className="stroke-subtle" strokeWidth="1" />
        )}
        {ticks.map((t, i) => (
          <text key={i} x={x(t)} y={height - 6} textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'} className="fill-muted text-[10px]">{axisDate(t)}</text>
        ))}
      </svg>
    </div>
  )
}
