// Diamond markers for lightweight-charts (it only ships circle / square /
// arrow markers). The signal suite's pillar signals use the suite's own
// standard: blue diamonds for bull, pink for bear (owner, 2026-10-03).
//
//   const d = new DiamondMarkers(bgColor)
//   series.attachPrimitive(d)
//   d.setPoints([{ time, price, color, offset?, text? }])
//
// `price` places the diamond on the series' scale; `offset` nudges it in
// pixels (negative = up), e.g. above a candle's high. `text` is a small
// label drawn just beyond the diamond, on the same side as the offset.

const HALF = 5 // half the diagonal, px

export class DiamondMarkers {
  constructor(outline) {
    this._outline = outline
    this._points = []
    this._chart = null
    this._series = null
    this._requestUpdate = null
    const self = this
    this._view = {
      zOrder: () => 'top',
      renderer: () => ({
        draw(target) {
          const chart = self._chart
          const series = self._series
          if (!chart || !series) return
          target.useMediaCoordinateSpace(({ context: ctx }) => {
            const ts = chart.timeScale()
            ctx.save()
            ctx.lineWidth = 1.5
            ctx.strokeStyle = self._outline
            ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif'
            ctx.textAlign = 'center'
            for (const p of self._points) {
              const x = ts.timeToCoordinate(p.time)
              const yBase = series.priceToCoordinate(p.price)
              if (x == null || yBase == null) continue
              const y = yBase + (p.offset ?? 0)
              ctx.beginPath()
              ctx.moveTo(x, y - HALF)
              ctx.lineTo(x + HALF, y)
              ctx.lineTo(x, y + HALF)
              ctx.lineTo(x - HALF, y)
              ctx.closePath()
              ctx.fillStyle = p.color
              ctx.fill()
              ctx.stroke()
              if (p.text) {
                const up = (p.offset ?? 0) <= 0
                ctx.textBaseline = up ? 'bottom' : 'top'
                ctx.fillText(p.text, x, up ? y - HALF - 2 : y + HALF + 2)
              }
            }
            ctx.restore()
          })
        },
      }),
    }
  }

  attached({ chart, series, requestUpdate }) {
    this._chart = chart
    this._series = series
    this._requestUpdate = requestUpdate
  }

  detached() {
    this._chart = null
    this._series = null
    this._requestUpdate = null
  }

  setPoints(points) {
    this._points = points ?? []
    this._requestUpdate?.()
  }

  paneViews() {
    return [this._view]
  }
}
