import { useEffect, useRef } from 'react'
import { createChart, createSeriesMarkers, CandlestickSeries, HistogramSeries, LineSeries, ColorType, CrosshairMode, LineStyle } from 'lightweight-charts'

// NIGHTFLOW chart: price candles, volume (coloured by net aggressor side)
// and cumulative volume delta, in three panes on one time axis. Data is
// pushed with setData on every update — the chart itself is built once,
// so zoom / pan survive the live stream.

function token(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() }
function alpha(hex, a) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  return m ? `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${a})` : hex
}
const ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
// Chart time = New York wall clock read as UTC, so the axis shows ET.
export function etWall(ms) {
  const p = Object.fromEntries(ET.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) / 1000
}

// 10-second buckets → 1-minute bars (CVD = the last bucket's).
export function rollUp(buckets, ms) {
  if (ms <= 10_000) return buckets
  const out = []
  for (const b of buckets) {
    const t = Math.floor(b.t / ms) * ms
    const cur = out[out.length - 1]
    if (cur && cur.t === t && cur.session === b.session) {
      cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c
      cur.v += b.v; cur.buy += b.buy; cur.sell += b.sell; cur.cvd = b.cvd
    } else out.push({ ...b, t })
  }
  return out
}

export default function OrderFlowChart({ buckets, alerts = [], height = 420 }) {
  const box = useRef(null)
  const api = useRef(null)

  useEffect(() => {
    const el = box.current
    if (!el) return undefined
    const t = { up: token('--color-green-400'), down: token('--color-red-400'), gold: token('--color-amber-400'), subtle: token('--color-subtle'), faint: token('--color-faint'), border: token('--color-border'), violet: token('--color-confluence') }
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: t.subtle, fontSize: 11, fontFamily: getComputedStyle(el).fontFamily, attributionLogo: false, panes: { separatorColor: t.border } },
      grid: { vertLines: { visible: false }, horzLines: { color: alpha(t.faint, 0.5) } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: true, rightOffset: 2 },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: t.subtle, style: LineStyle.Dashed, labelBackgroundColor: t.border }, horzLine: { color: t.subtle, style: LineStyle.Dashed, labelBackgroundColor: t.border } },
    })
    chart.addPane(true); chart.addPane(true)
    const price = chart.addSeries(CandlestickSeries, { upColor: t.up, downColor: t.down, wickUpColor: t.up, wickDownColor: t.down, borderVisible: false }, 0)
    const vol = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false }, 1)
    const cvd = chart.addSeries(LineSeries, { color: t.violet, lineWidth: 2, priceFormat: { type: 'volume' }, lastValueVisible: true, priceLineVisible: false }, 2)
    cvd.createPriceLine({ price: 0, color: alpha(t.subtle, 0.5), lineStyle: LineStyle.Dotted, lineWidth: 1, axisLabelVisible: false })
    const markers = createSeriesMarkers(price, [])
    const panes = chart.panes()
    panes[0].setStretchFactor(3); panes[1].setStretchFactor(1); panes[2].setStretchFactor(1.4)
    api.current = { chart, price, vol, cvd, markers, t, fitted: false }
    return () => { chart.remove(); api.current = null }
  }, [])

  useEffect(() => {
    const a = api.current
    if (!a) return
    const seen = new Set()
    const rows = (buckets ?? []).filter((b) => { const k = etWall(b.t); if (seen.has(k)) return false; seen.add(k); return true })
    a.price.setData(rows.map((b) => ({ time: etWall(b.t), open: b.o, high: b.h, low: b.l, close: b.c })))
    a.vol.setData(rows.map((b) => ({ time: etWall(b.t), value: b.v, color: alpha(b.buy >= b.sell ? a.t.up : a.t.down, 0.55) })))
    a.cvd.setData(rows.map((b) => ({ time: etWall(b.t), value: b.cvd })))
    const first = rows[0]?.t ?? 0
    const sev = (s) => (s >= 3 ? a.t.down : s === 2 ? a.t.gold : a.t.subtle)
    a.markers.setMarkers(alerts.filter((x) => x.t >= first).map((x) => ({
      time: etWall(Math.floor(x.t / 10_000) * 10_000), position: x.type === 'bullish_accumulation' ? 'belowBar' : 'aboveBar',
      shape: x.type === 'bullish_accumulation' ? 'arrowUp' : 'arrowDown', color: x.type === 'bullish_accumulation' ? a.t.up : sev(x.severity), size: 1,
    })).sort((p, q) => p.time - q.time))
    if (!a.fitted && rows.length > 5) { a.chart.timeScale().fitContent(); a.fitted = true }
  }, [buckets, alerts])

  return <div ref={box} style={{ height }} className="w-full" />
}
