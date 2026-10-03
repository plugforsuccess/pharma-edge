// Diamond markers for lightweight-charts (it only ships circle / square /
// arrow markers). The signal suite's pillar signals use the suite's own
// standard: blue diamonds for bull, pink for bear (owner, 2026-10-03) —
// styled after TradingView's: a soft fill, a bright outline in the same
// hue, and a thin ring in the background color so they read on any line.
//
//   const d = new DiamondMarkers({ outline: bg, lane: true })
//   series.attachPrimitive(d)
//   d.setPoints([{ time, color, price?, offset?, label?, hollow? }])
//
// lane: true puts every diamond in a strip along the bottom of the pane
// (a faint band, like TradingView's signal row) — give the series a bottom
// scale margin so the line stays above it. Otherwise `price` places the
// diamond on the series' scale and `offset` nudges it in pixels (negative =
// up), e.g. above a candle's high. `label` is drawn inside the diamond
// (one or two letters); `hollow` draws the outline only (exits), so it
// reads apart from the solid signal diamonds.

export const LANE_PX = 30

function rgba(hex, a) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex).trim())
  if (!m) return hex
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${a})`
}
// The hue mixed toward white — the bright outline.
function tint(hex, k) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex).trim())
  if (!m) return hex
  const c = [m[1], m[2], m[3]].map((x) => Math.round(parseInt(x, 16) + (255 - parseInt(x, 16)) * k))
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`
}

function diamond(ctx, x, y, r) {
  ctx.beginPath()
  ctx.moveTo(x, y - r)
  ctx.lineTo(x + r, y)
  ctx.lineTo(x, y + r)
  ctx.lineTo(x - r, y)
  ctx.closePath()
}

export class DiamondMarkers {
  constructor({ outline, lane = false, size = 8 } = {}) {
    this._outline = outline
    this._lane = lane
    this._r = size
    this._points = []
    this._chart = null
    this._series = null
    this._requestUpdate = null
    const self = this
    this._view = {
      zOrder: () => 'top',
      renderer: () => ({
        drawBackground(target) {
          if (!self._lane) return
          target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.025)'
            ctx.fillRect(0, mediaSize.height - LANE_PX, mediaSize.width, LANE_PX)
          })
        },
        draw(target) {
          const chart = self._chart
          const series = self._series
          if (!chart || !series) return
          target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
            const ts = chart.timeScale()
            const r0 = self._r
            ctx.save()
            ctx.lineJoin = 'round'
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            for (const p of self._points) {
              const x = ts.timeToCoordinate(p.time)
              if (x == null) continue
              let y
              if (self._lane) y = mediaSize.height - LANE_PX / 2
              else {
                const yBase = series.priceToCoordinate(p.price)
                if (yBase == null) continue
                y = yBase + (p.offset ?? 0)
              }
              const r = p.label && p.label.length > 1 ? r0 + 2 : r0
              // Ring in the background color, then fill, then the bright outline.
              diamond(ctx, x, y, r + 1.5)
              ctx.fillStyle = self._outline
              ctx.fill()
              diamond(ctx, x, y, r)
              ctx.fillStyle = p.hollow ? self._outline : rgba(p.color, 0.78)
              ctx.fill()
              ctx.lineWidth = p.hollow ? 1.75 : 2
              ctx.strokeStyle = p.hollow ? p.color : tint(p.color, 0.45)
              ctx.stroke()
              if (p.label) {
                ctx.font = `700 ${p.label.length > 1 ? 8 : 9}px ui-sans-serif, system-ui, sans-serif`
                ctx.fillStyle = p.hollow ? tint(p.color, 0.2) : '#ffffff'
                ctx.fillText(p.label, x, y + 0.5)
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
