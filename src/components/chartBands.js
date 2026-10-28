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

//   FibLevels      Fibonacci levels drawn like TradingView's tool (owner,
//                  2026-10-16: "the fib line needs to be restyled"): thin
//                  lines from point A to the right edge, a small label at
//                  the left end ("61.8% · 144.76"), faint bands between
//                  retracement levels and the 50–61.8% pocket in gold.
//                  Clipped to the pane's plot area (inside its scale
//                  margins) so nothing spills into the header or the dates.
//                    const fl = new FibLevels(); candles.attachPrimitive(fl)
//                    fl.setLevels({ from: time, levels: [{ price, label, color, kind, ratio }], gold })
export class FibLevels {
  constructor() {
    this._data = null
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
          const d = self._data
          if (!chart || !series || !d?.levels?.length) return
          target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
            const m = series.priceScale().options().scaleMargins ?? { top: 0, bottom: 0 }
            const top = m.top * mediaSize.height
            const bottom = mediaSize.height * (1 - m.bottom)
            ctx.save()
            ctx.beginPath()
            ctx.rect(0, top, mediaSize.width, bottom - top)
            ctx.clip()
            const ts = chart.timeScale()
            let x0 = d.from != null ? ts.timeToCoordinate(d.from) : null
            if (x0 == null) x0 = 0
            const x1 = mediaSize.width
            const pts = d.levels.map((l) => ({ ...l, y: series.priceToCoordinate(l.price) })).filter((l) => l.y != null)
            // Bands between neighbouring retracement levels; the pocket in gold.
            const ret = pts.filter((l) => l.kind === 'retracement').sort((a, b) => a.ratio - b.ratio)
            for (let k = 0; k < ret.length - 1; k++) {
              const a = ret[k], b = ret[k + 1]
              const pocket = a.ratio === 0.5 && b.ratio === 0.618
              ctx.fillStyle = pocket ? d.goldFill : d.bandFill
              ctx.fillRect(x0, Math.min(a.y, b.y), x1 - x0, Math.abs(b.y - a.y))
            }
            for (const l of pts) {
              ctx.strokeStyle = l.color
              ctx.lineWidth = l.width ?? 1
              ctx.setLineDash(l.dash ?? (l.kind === 'extension' ? [4, 4] : []))
              // A level may start at its own time (rejection levels start at their first rejection).
              const lx = l.from != null ? Math.max(0, ts.timeToCoordinate(l.from) ?? 0) : x0
              ctx.beginPath()
              ctx.moveTo(lx, Math.round(l.y) + 0.5)
              ctx.lineTo(x1, Math.round(l.y) + 0.5)
              ctx.stroke()
            }
            ctx.restore()
          })
        },
      }),
    }
    // Labels above the candles, at the right end of each line on a dark
    // backing, skipping one that would overlap the label above it.
    this._labels = {
      zOrder: () => 'top',
      renderer: () => ({
        draw(target) {
          const series = self._series
          const d = self._data
          if (!series || !d?.levels?.length) return
          target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
            const m = series.priceScale().options().scaleMargins ?? { top: 0, bottom: 0 }
            const top = m.top * mediaSize.height
            const bottom = mediaSize.height * (1 - m.bottom)
            ctx.font = '600 10px ' + (d.font ?? 'sans-serif')
            ctx.textBaseline = 'middle'
            const pts = d.levels.map((l) => ({ ...l, y: series.priceToCoordinate(l.price) }))
              .filter((l) => l.y != null && l.y >= top + 7 && l.y <= bottom - 7)
              .sort((a, b) => a.y - b.y)
            let last = -Infinity
            for (const l of pts) {
              if (l.y - last < 13) continue
              last = l.y
              const w = ctx.measureText(l.text).width + 8
              const x = mediaSize.width - w - 4
              ctx.fillStyle = d.labelBg
              ctx.beginPath()
              if (ctx.roundRect) ctx.roundRect(x, l.y - 7, w, 14, 3); else ctx.rect(x, l.y - 7, w, 14)
              ctx.fill()
              ctx.fillStyle = l.labelColor ?? l.color
              ctx.fillText(l.text, x + 4, l.y + 0.5)
            }
          })
        },
      }),
    }
  }
  attached({ chart, series, requestUpdate }) { this._chart = chart; this._series = series; this._requestUpdate = requestUpdate }
  detached() { this._chart = null; this._series = null; this._requestUpdate = null }
  setLevels(data) { this._data = data; this._requestUpdate?.() }
  paneViews() { return [this._view, this._labels] }
}
