// Two more series primitives for lightweight-charts (owner, 2026-10-05):
//
//   VerticalBands  full-height columns at given times — the Triple event's
//                  highlight. Attach one to a series in every pane so the
//                  band runs through all of them.
//                    const vb = new VerticalBands(); series.attachPrimitive(vb)
//                    vb.setBands([{ time, color, width? }])   // width in bars (default 1)
//
//   ZoneFill       the area between two price series on the attached series'
//                  scale — Bravo's basis ± ½ ATR drawn as the "reclaim zone".
//                    const zf = new ZoneFill({ fill, edge }); candles.attachPrimitive(zf)
//                    zf.setPoints([{ time, lo, hi }])        // nulls skipped
//
// Both draw under the series (zOrder 'bottom') so candles stay readable.

export class VerticalBands {
  constructor() {
    this._bands = []
    this._chart = null
    this._series = null
    this._requestUpdate = null
    const self = this
    this._view = {
      zOrder: () => 'bottom',
      renderer: () => ({
        draw(target) {
          const chart = self._chart
          if (!chart || !self._bands.length) return
          target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
            const ts = chart.timeScale()
            const spacing = ts.options().barSpacing || 6
            for (const b of self._bands) {
              const x = ts.timeToCoordinate(b.time)
              if (x == null) continue
              const w = Math.max(3, spacing * (b.width ?? 1))
              ctx.fillStyle = b.color
              ctx.fillRect(x - w / 2, 0, w, mediaSize.height)
            }
          })
        },
      }),
    }
  }
  attached({ chart, series, requestUpdate }) { this._chart = chart; this._series = series; this._requestUpdate = requestUpdate }
  detached() { this._chart = null; this._series = null; this._requestUpdate = null }
  setBands(bands) { this._bands = bands ?? []; this._requestUpdate?.() }
  paneViews() { return [this._view] }
}

export class ZoneFill {
  constructor({ fill = 'rgba(77, 141, 255, 0.10)', edge = 'rgba(77, 141, 255, 0.45)' } = {}) {
    this._fill = fill
    this._edge = edge
    this._points = []
    this._chart = null
    this._series = null
    this._requestUpdate = null
    const self = this
    this._view = {
      zOrder: () => 'bottom',
      renderer: () => ({
        draw(target) {
          const chart = self._chart
          const series = self._series
          if (!chart || !series || self._points.length < 2) return
          target.useMediaCoordinateSpace(({ context: ctx }) => {
            const ts = chart.timeScale()
            const r = ts.getVisibleLogicalRange()
            // Only the visible slice, with one bar of slack either side.
            const pts = []
            for (let i = 0; i < self._points.length; i++) {
              const p = self._points[i]
              if (r && (i < r.from - 2 || i > r.to + 2)) continue
              if (p.lo == null || p.hi == null) { pts.push(null); continue }
              const x = ts.timeToCoordinate(p.time)
              if (x == null) { pts.push(null); continue }
              pts.push({ x, lo: series.priceToCoordinate(p.lo), hi: series.priceToCoordinate(p.hi) })
            }
            // Draw each unbroken run as one polygon (steps: hold the value to the next bar).
            let run = []
            const flush = () => {
              if (run.length < 1) { run = []; return }
              const half = (ts.options().barSpacing || 6) / 2
              ctx.beginPath()
              run.forEach((p, k) => { const x0 = p.x - half; const x1 = p.x + half; if (k === 0) ctx.moveTo(x0, p.hi); else ctx.lineTo(x0, p.hi); ctx.lineTo(x1, p.hi) })
              for (let k = run.length - 1; k >= 0; k--) { const p = run[k]; ctx.lineTo(p.x + half, p.lo); ctx.lineTo(p.x - half, p.lo) }
              ctx.closePath()
              ctx.fillStyle = self._fill
              ctx.fill()
              ctx.lineWidth = 1
              ctx.strokeStyle = self._edge
              ctx.stroke()
              run = []
            }
            for (const p of pts) { if (!p || p.lo == null || p.hi == null) flush(); else run.push(p) }
            flush()
          })
        },
      }),
    }
  }
  attached({ chart, series, requestUpdate }) { this._chart = chart; this._series = series; this._requestUpdate = requestUpdate }
  detached() { this._chart = null; this._series = null; this._requestUpdate = null }
  setPoints(points) { this._points = points ?? []; this._requestUpdate?.() }
  paneViews() { return [this._view] }
}
