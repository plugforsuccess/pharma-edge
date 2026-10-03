import { useEffect, useRef, useState } from 'react'
import {
  createChart, createSeriesMarkers, CandlestickSeries, HistogramSeries, LineSeries, ColorType, CrosshairMode, LineStyle,
} from 'lightweight-charts'
import { snapPin } from '../utils/chartTools'

// Stock price chart for /charts, on TradingView Lightweight Charts.
//
// Attribution notice (Apache-2.0 NOTICE, required by the licence):
//   TradingView Lightweight Charts™
//   Copyright (c) 2025 TradingView, Inc. https://www.tradingview.com/
// The on-chart logo is off and there's no credit on /charts (owner,
// 2026-10-03); the licence's link requirement is met by the
// "Open-source licenses" line at the bottom of Settings — keep it.
// Candlesticks (owner: candles, not a line), a volume band under the price, a magnet
// crosshair, and the trade's levels (strike, break-even, cost, target)
// as dashed price lines with tags on the price axis. Pinch / drag to
// zoom and pan. Colors come from the theme tokens in index.css, read at
// runtime — never hard-coded here.
//
//   bars:    [{ t, o, h, l, c, v }] — t is 'YYYY-MM-DD' (daily) or unix
//            seconds of New York wall-clock time read as UTC (intraday)
//   levels:  [{ price, label, gold? }]
//   fitLevels: widen the price scale so every level stays in view (off for
//            1D / 1W, where it would flatten the candles)
//   onHover: (bar | null) => void — the bar under the crosshair
//   pins:    [{ t, p }] placed Measure pins (A, B) — drawn as markers
//            joined by a line
//   fib:     [{ kind, ratio, price, label, up }] Fibonacci levels (chartTools)
//   picking: when true, a tap calls onPick with a pin snapped to that
//            candle's high or low
//   onPinsChange: (pins) => void — a pin was dragged; called live with the
//            new [{ t, p }] pins (the dragged pin snaps to each candle's
//            high or low). A drag that starts on a pin moves it; anywhere
//            else it pans the chart as usual.
// Pins and Fib levels are drawn on the existing chart (no rebuild), so
// zoom and pan survive setting a pin.

function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}
// "#2fd17c" + 0.3 → "rgba(47, 209, 124, 0.3)" (canvas needs a plain color).
function alpha(hex, a) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return hex
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${a})`
}

// How close (px) a touch has to land to grab a pin.
const GRAB_PX = 24

export default function PriceChart({ bars, levels = [], fitLevels = true, height = 300, onHover, pins, fib, picking = false, onPick, onPinsChange }) {
  const box = useRef(null)
  const hoverRef = useRef(onHover)
  hoverRef.current = onHover
  const pickRef = useRef({ picking, onPick })
  pickRef.current = { picking, onPick }
  const pinsRef = useRef({ pins, onPinsChange })
  pinsRef.current = { pins, onPinsChange }
  // The live chart, for the overlay effect below; a new version after each rebuild.
  const live = useRef(null)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    const el = box.current
    if (!el || !bars?.length) return undefined
    const t = {
      up: token('--color-green-400'), down: token('--color-red-400'), gold: token('--color-amber-400'),
      muted: token('--color-muted'), subtle: token('--color-subtle'), faint: token('--color-faint'),
      card: token('--color-card'), border: token('--color-border'),
    }
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: t.subtle, // axis numbers: secondary-text grey (muted was too dim)
        fontSize: 11,
        fontFamily: getComputedStyle(el).fontFamily,
        attributionLogo: false,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: alpha(t.faint, 0.6) } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.24 } },
      timeScale: {
        borderVisible: false, fixLeftEdge: true, fixRightEdge: true, rightOffset: 0,
        timeVisible: typeof bars[0].t === 'number', secondsVisible: false,
      },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: { color: t.subtle, width: 1, style: LineStyle.Dashed, labelBackgroundColor: t.border },
        horzLine: { color: t.subtle, width: 1, style: LineStyle.Dashed, labelBackgroundColor: t.border },
      },
      handleScale: { axisPressedMouseMove: false },
    })

    const first = bars[0].c
    const last = bars[bars.length - 1].c
    const trend = last >= first ? t.up : t.down
    const price = chart.addSeries(CandlestickSeries, {
      upColor: t.up, downColor: t.down, wickUpColor: t.up, wickDownColor: t.down, borderVisible: false,
      // The library's last-value tag follows the last candle in view, so a
      // panned-back chart showed an old close; tag the latest close instead.
      lastValueVisible: false, priceLineVisible: false,
    })
    price.setData(bars.map((b) => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c })))
    price.createPriceLine({
      price: last, color: trend, lineWidth: 1, lineStyle: LineStyle.Dotted,
      axisLabelVisible: true, axisLabelColor: trend, axisLabelTextColor: t.card,
    })

    // Volume in its own band under the price (its own scale, no axis).
    if (bars.some((b) => b.v > 0)) {
      const vol = chart.addSeries(HistogramSeries, {
        priceScaleId: 'volume', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false,
      })
      chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false })
      vol.setData(bars.map((b) => ({ time: b.t, value: b.v, color: alpha(b.c >= b.o ? t.up : t.down, 0.25) })))
    }

    // Keep every level in view (autoscale ignores price lines otherwise),
    // plus the Fib retracements and first extension while they're on.
    const levelPrices = fitLevels ? levels.map((l) => l.price).filter(Number.isFinite) : []
    const extra = { prices: [] }
    price.applyOptions({
      autoscaleInfoProvider: (base) => {
        const r = base()
        const fitTo = levelPrices.concat(extra.prices)
        if (!r?.priceRange || !fitTo.length) return r
        return {
          ...r,
          priceRange: {
            minValue: Math.min(r.priceRange.minValue, ...fitTo),
            maxValue: Math.max(r.priceRange.maxValue, ...fitTo),
          },
        }
      },
    })
    for (const l of levels) {
      if (!Number.isFinite(l.price)) continue
      price.createPriceLine({
        price: l.price, title: l.label, color: l.gold ? t.gold : t.subtle,
        lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true,
        axisLabelColor: l.gold ? t.gold : t.border, axisLabelTextColor: l.gold ? t.card : t.subtle,
      })
    }
    chart.timeScale().fitContent()

    const byTime = new Map(bars.map((b) => [b.t, b]))
    // The library hands date times back as strings or { year, month, day }.
    const timeKey = (time) => (typeof time === 'string' || typeof time === 'number' ? time
      : time && typeof time === 'object' ? `${time.year}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}`
      : null)
    const onMove = (param) => {
      const key = timeKey(param.time)
      hoverRef.current?.(key != null ? byTime.get(key) ?? null : null)
    }
    chart.subscribeCrosshairMove(onMove)

    // Measure: a tap drops a pin on that candle's high or low.
    const onClick = (param) => {
      const { picking: on, onPick: pick } = pickRef.current
      if (!on || !pick || !param.point) return
      const key = timeKey(param.time)
      const bar = key != null ? byTime.get(key) : null
      if (!bar) return
      pick(snapPin(bar, price.coordinateToPrice(param.point.y)))
    }
    chart.subscribeClick(onClick)

    // Drag a pin: a press within GRAB_PX of one grabs it (the chart's own
    // pan / zoom is held off until release); the pin follows the finger,
    // snapping to the candle under it. Capture-phase listeners run before
    // the chart's, so a grab never pans.
    const ts = chart.timeScale()
    const pinXY = (pin) => ({ x: ts.timeToCoordinate(pin.t), y: price.priceToCoordinate(pin.p) })
    const local = (cx, cy) => { const r = el.getBoundingClientRect(); return { x: cx - r.left, y: cy - r.top } }
    const grabAt = (pt) => {
      const list = pinsRef.current.pins ?? []
      let best = -1
      let bestD = GRAB_PX
      list.forEach((pin, k) => {
        const q = pinXY(pin)
        if (q.x == null || q.y == null) return
        const d = Math.hypot(q.x - pt.x, q.y - pt.y)
        if (d <= bestD) { bestD = d; best = k }
      })
      return best
    }
    const pinAt = (pt) => {
      const logical = ts.coordinateToLogical(pt.x)
      if (logical == null) return null
      const i = Math.max(0, Math.min(bars.length - 1, Math.round(logical)))
      return snapPin(bars[i], price.coordinateToPrice(pt.y))
    }
    let drag = null
    const start = (pt) => {
      if (!pinsRef.current.onPinsChange) return false
      const k = grabAt(pt)
      if (k < 0) return false
      const list = pinsRef.current.pins
      drag = { other: list.length === 2 ? list[1 - k] : null, last: list[k] }
      chart.applyOptions({ handleScroll: false, handleScale: false })
      el.style.cursor = 'grabbing'
      return true
    }
    const moveTo = (pt) => {
      if (!drag) return
      const pin = pinAt(pt)
      if (!pin || (pin.t === drag.last.t && pin.p === drag.last.p)) return
      drag.last = pin
      const other = drag.other ? { t: drag.other.t, p: drag.other.p } : null
      pinsRef.current.onPinsChange?.(other ? [other, pin] : [pin])
    }
    const end = () => {
      if (!drag) return
      drag = null
      chart.applyOptions({ handleScroll: true, handleScale: { axisPressedMouseMove: false } })
      el.style.cursor = ''
    }
    const onTouchStart = (e) => {
      if (e.touches.length !== 1) return
      const tch = e.touches[0]
      if (!start(local(tch.clientX, tch.clientY))) return
      e.preventDefault(); e.stopPropagation()
    }
    const onTouchMove = (e) => {
      if (!drag) return
      const tch = e.touches[0]
      e.preventDefault(); e.stopPropagation()
      if (tch) moveTo(local(tch.clientX, tch.clientY))
    }
    const onTouchEnd = (e) => { if (drag) { e.stopPropagation(); end() } }
    const onMouseDown = (e) => {
      if (e.button !== 0 || !start(local(e.clientX, e.clientY))) return
      e.preventDefault(); e.stopPropagation()
      const mm = (ev) => moveTo(local(ev.clientX, ev.clientY))
      const mu = () => { window.removeEventListener('mousemove', mm); window.removeEventListener('mouseup', mu); end() }
      window.addEventListener('mousemove', mm)
      window.addEventListener('mouseup', mu)
    }
    // A grab cursor over a pin (mouse).
    const onHoverCursor = (e) => {
      if (drag) return
      el.style.cursor = pinsRef.current.onPinsChange && grabAt(local(e.clientX, e.clientY)) >= 0 ? 'grab' : ''
    }
    const cap = { capture: true, passive: false }
    el.addEventListener('touchstart', onTouchStart, cap)
    el.addEventListener('touchmove', onTouchMove, cap)
    el.addEventListener('touchend', onTouchEnd, cap)
    el.addEventListener('touchcancel', onTouchEnd, cap)
    el.addEventListener('mousedown', onMouseDown, cap)
    el.addEventListener('mousemove', onHoverCursor)

    const markers = createSeriesMarkers(price, [])
    live.current = { chart, price, markers, extra, t, line: null, fibLines: [] }
    setVersion((v) => v + 1)
    return () => {
      chart.unsubscribeCrosshairMove(onMove)
      chart.unsubscribeClick(onClick)
      el.removeEventListener('touchstart', onTouchStart, cap)
      el.removeEventListener('touchmove', onTouchMove, cap)
      el.removeEventListener('touchend', onTouchEnd, cap)
      el.removeEventListener('touchcancel', onTouchEnd, cap)
      el.removeEventListener('mousedown', onMouseDown, cap)
      el.removeEventListener('mousemove', onHoverCursor)
      el.style.cursor = ''
      live.current = null
      chart.remove()
    }
  }, [bars, levels, fitLevels])

  // Pins + Fib on the live chart.
  useEffect(() => {
    const L = live.current
    if (!L) return
    const { chart, price, markers, extra, t } = L
    if (L.line) { chart.removeSeries(L.line); L.line = null }
    for (const pl of L.fibLines) price.removePriceLine(pl)
    L.fibLines = []

    const placed = pins ?? []
    markers.setMarkers(placed.map((pin, i) => ({
      time: pin.t, position: 'atPriceMiddle', price: pin.p, shape: 'circle', color: t.gold, size: 1.8, text: i === 0 ? 'A' : 'B',
    })))
    if (placed.length === 2) {
      L.line = chart.addSeries(LineSeries, {
        color: t.gold, lineWidth: 2, lastValueVisible: false, priceLineVisible: false,
        crosshairMarkerVisible: false, pointMarkersVisible: false,
      })
      L.line.setData(placed.map((pin) => ({ time: pin.t, value: pin.p })))
    }

    for (const l of fib ?? []) {
      const strong = l.kind === 'retracement' && (l.ratio === 0.5 || l.ratio === 0.618)
      const edge = l.kind === 'retracement' && (l.ratio === 0 || l.ratio === 1)
      const color = l.kind === 'extension' ? (l.up ? t.up : t.down) : strong ? t.gold : edge ? t.muted : t.subtle
      L.fibLines.push(price.createPriceLine({
        price: l.price, title: `Fib ${l.label}`, color, lineWidth: 1,
        lineStyle: l.kind === 'extension' ? LineStyle.SparseDotted : LineStyle.Dotted,
        axisLabelVisible: true, axisLabelColor: alpha(color, 0.9), axisLabelTextColor: t.card,
      }))
    }
    // Fit the retracements and the first extension; farther targets show when in view.
    extra.prices = (fib ?? []).filter((l) => l.kind === 'retracement' || l.ratio === 1.272).map((l) => l.price)
    price.applyOptions({})
  }, [pins, fib, version])

  return <div ref={box} style={{ height }} className={picking ? 'w-full cursor-crosshair' : 'w-full'} role="img" aria-label="Price chart" />
}
