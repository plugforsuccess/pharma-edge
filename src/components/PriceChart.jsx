import { useEffect, useRef } from 'react'
import {
  createChart, CandlestickSeries, HistogramSeries, ColorType, CrosshairMode, LineStyle,
} from 'lightweight-charts'

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

function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}
// "#2fd17c" + 0.3 → "rgba(47, 209, 124, 0.3)" (canvas needs a plain color).
function alpha(hex, a) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return hex
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${a})`
}

export default function PriceChart({ bars, levels = [], fitLevels = true, height = 300, onHover }) {
  const box = useRef(null)
  const hoverRef = useRef(onHover)
  hoverRef.current = onHover

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
        textColor: t.muted,
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
      priceLineColor: trend, priceLineStyle: LineStyle.Dotted,
    })
    price.setData(bars.map((b) => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c })))

    // Volume in its own band under the price (its own scale, no axis).
    if (bars.some((b) => b.v > 0)) {
      const vol = chart.addSeries(HistogramSeries, {
        priceScaleId: 'volume', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false,
      })
      chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false })
      vol.setData(bars.map((b) => ({ time: b.t, value: b.v, color: alpha(b.c >= b.o ? t.up : t.down, 0.25) })))
    }

    // Keep every level in view (autoscale ignores price lines otherwise).
    const levelPrices = levels.map((l) => l.price).filter(Number.isFinite)
    if (fitLevels && levelPrices.length) {
      price.applyOptions({
        autoscaleInfoProvider: (base) => {
          const r = base()
          if (!r?.priceRange) return r
          return {
            ...r,
            priceRange: {
              minValue: Math.min(r.priceRange.minValue, ...levelPrices),
              maxValue: Math.max(r.priceRange.maxValue, ...levelPrices),
            },
          }
        },
      })
    }
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
    const onMove = (param) => {
      const key = typeof param.time === 'string' || typeof param.time === 'number' ? param.time
        : param.time && typeof param.time === 'object' ? `${param.time.year}-${String(param.time.month).padStart(2, '0')}-${String(param.time.day).padStart(2, '0')}`
        : null
      hoverRef.current?.(key ? byTime.get(key) ?? null : null)
    }
    chart.subscribeCrosshairMove(onMove)
    return () => {
      chart.unsubscribeCrosshairMove(onMove)
      chart.remove()
    }
  }, [bars, levels, fitLevels])

  return <div ref={box} style={{ height }} className="w-full" role="img" aria-label="Price chart" />
}
