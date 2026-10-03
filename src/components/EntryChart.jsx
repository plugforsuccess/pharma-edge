import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  createChart, createSeriesMarkers, BaselineSeries, CandlestickSeries, HistogramSeries, LineSeries,
  ColorType, CrosshairMode, LineStyle, LineType,
} from 'lightweight-charts'

// LEAPS entry chart for /charts/entry/:ticker, on TradingView Lightweight
// Charts (attribution notice + licence link: see PriceChart.jsx and the
// "Open-source licenses" line in Settings).
//
// One chart, one time scale, stacked panes (so the crosshair and zoom
// stay in sync):
//   price     candles, 200-day SMA (bold; green while its 20-day slope is
//             up, red while down), 50-day SMA, weekly 50 EMA (dashed),
//             golden / death cross markers, buy-signal triangles under the
//             candle, lighter MACD-confirmation dots, buy-zone shading
//   dist      % from the 200-day, shaded ±band
//   rsi       RSI(14), lines at 30 / the RSI level / 70
//   macd      MACD(12, 26, 9) line, signal, histogram
//   ivr       IV Rank (252), line at the cutoff
//   ivhv      IV vs 20-day historical vol
//   echo      Echo momentum (signal suite) with its adaptive rails + diamonds
//   tango     Tango money flow, same layout
// Price layers (`layers`): Bravo's envelope + fast EMA, Hardening ★ signals
// (gold ▲ under the candle = bull, red ▼ above = bear) and Exit Meta exits
// (small red squares, E / T / B).
// `model` comes from entryModel() in utils/indicators.js, `suite` from
// suiteModel() in utils/signalSuite.js; `panes` lists the sub-panes to
// show. Colors are the theme tokens, read at runtime.

function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}
function alpha(hex, a) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return hex
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${a})`
}

export const SUB_PANES = [
  ['dist', '200-day'],
  ['rsi', 'RSI'],
  ['macd', 'MACD'],
  ['ivr', 'IV Rank'],
  ['ivhv', 'IV / HV'],
  ['echo', 'Echo'],
  ['tango', 'Tango'],
]
export const LAYERS = [
  ['hardening', 'Hardening ★'],
  ['exits', 'Exits'],
  ['bravo', 'Bravo band'],
]
const PRICE_H = 320
const SUB_H = 96
const SHOW_DAYS = 504 // two years of trading days in view by default

const fmt = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }))
const pct = (v, d = 1) => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}%`)

export default function EntryChart({ bars, model, suite, panes, layers = [], onHover }) {
  const box = useRef(null)
  const hoverRef = useRef(onHover)
  hoverRef.current = onHover
  const rangeRef = useRef(null)      // keeps zoom / pan across rebuilds
  const chartRef = useRef(null)
  const [hover, setHover] = useState(null)
  const [tops, setTops] = useState([])
  const shown = ['price', ...SUB_PANES.map(([k]) => k).filter((k) => panes.includes(k))]
  const height = PRICE_H + (shown.length - 1) * SUB_H
  const key = `${shown.join(',')}|${layers.join(',')}`

  useEffect(() => {
    const el = box.current
    if (!el || !bars?.length || !model) return undefined
    const on = (k) => layers.includes(k) && suite
    const t = {
      up: token('--color-green-400'), down: token('--color-red-400'), gold: token('--color-amber-400'),
      goldHi: token('--color-amber-200'), fg: token('--color-fg'), muted: token('--color-muted'),
      subtle: token('--color-subtle'), faint: token('--color-faint'), border: token('--color-border'),
    }
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: t.muted, fontSize: 10, fontFamily: getComputedStyle(el).fontFamily,
        attributionLogo: false,
        panes: { separatorColor: t.border, separatorHoverColor: alpha(t.gold, 0.3), enableResize: false },
      },
      grid: { vertLines: { visible: false }, horzLines: { color: alpha(t.faint, 0.55) } },
      rightPriceScale: { borderVisible: false, minimumWidth: 56 },
      timeScale: { borderVisible: false, rightOffset: 4, minBarSpacing: 0.5 },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: { color: t.subtle, width: 1, style: LineStyle.Dashed, labelBackgroundColor: t.border },
        horzLine: { color: t.subtle, width: 1, style: LineStyle.Dashed, labelBackgroundColor: t.border },
      },
      // Let the page scroll on a vertical swipe; horizontal drag pans.
      handleScroll: { vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: false },
    })
    chartRef.current = chart
    const time = bars.map((b) => b.t)
    const line = (arr, i0 = 0) => arr.map((v, i) => (v == null ? { time: time[i] } : { time: time[i], value: v })).slice(i0)
    const quiet = { lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false }
    const paneOf = (k) => shown.indexOf(k)

    // Price pane ---------------------------------------------------------
    // Buy-zone shading: full-height columns on signal days, its own scale.
    const zone = chart.addSeries(HistogramSeries, { ...quiet, priceScaleId: 'zone', base: 0 }, 0)
    chart.priceScale('zone', 0).applyOptions({ visible: false, scaleMargins: { top: 0, bottom: 0 } })
    zone.setData(bars.map((b, i) => (model.cond[i]?.all
      ? { time: b.t, value: 1, color: alpha(t.up, 0.13) }
      : { time: b.t })))

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: t.up, downColor: t.down, wickUpColor: t.up, wickDownColor: t.down, borderVisible: false,
      priceLineColor: t.subtle, priceLineStyle: LineStyle.Dotted,
    }, 0)
    candles.setData(bars.map((b) => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c })))
    chart.priceScale('right', 0).applyOptions({ scaleMargins: { top: 0.06, bottom: 0.08 } })

    const wema = chart.addSeries(LineSeries, { ...quiet, color: alpha(t.fg, 0.7), lineWidth: 1, lineStyle: LineStyle.Dashed }, 0)
    wema.setData(line(model.wema))
    const s50 = chart.addSeries(LineSeries, { ...quiet, color: t.gold, lineWidth: 1.5 }, 0)
    s50.setData(line(model.s50))
    const s200 = chart.addSeries(LineSeries, { ...quiet, color: t.up, lineWidth: 3 }, 0)
    s200.setData(model.s200.map((v, i) => (v == null ? { time: time[i] }
      : { time: time[i], value: v, color: model.slope200[i] == null ? t.subtle : model.slope200[i] > 0 ? t.up : t.down })))

    if (on('bravo')) {
      const band = { ...quiet, color: alpha(t.subtle, 0.45), lineWidth: 1 }
      chart.addSeries(LineSeries, band, 0).setData(line(suite.bravo.upperBand))
      chart.addSeries(LineSeries, band, 0).setData(line(suite.bravo.lowerBand))
      chart.addSeries(LineSeries, { ...quiet, color: alpha(t.subtle, 0.6), lineWidth: 1, lineStyle: LineStyle.Dotted }, 0).setData(line(suite.bravo.basis))
      chart.addSeries(LineSeries, { ...quiet, color: t.goldHi, lineWidth: 1.5 }, 0).setData(line(suite.bravo.fast))
    }

    const signalSet = new Set(model.signals)
    const markers = []
    const stars = (n) => '★'.repeat(n)
    if (on('hardening')) {
      for (const sg of suite.signals) {
        markers.push(sg.side === 'bull'
          ? { time: time[sg.i], position: 'belowBar', shape: 'arrowUp', color: t.gold, size: 1.5, text: stars(sg.stars) }
          : { time: time[sg.i], position: 'aboveBar', shape: 'arrowDown', color: t.down, size: 1.5, text: stars(sg.stars) })
      }
    }
    if (on('exits')) {
      for (const x of suite.exits) markers.push({ time: time[x.i], position: 'aboveBar', shape: 'square', color: alpha(t.down, 0.6), size: 0.6, text: x.why.join('') })
    }
    for (const i of model.golden) markers.push({ time: time[i], position: 'aboveBar', shape: 'circle', color: t.gold, text: 'Golden cross', size: 1 })
    for (const i of model.death) markers.push({ time: time[i], position: 'aboveBar', shape: 'circle', color: t.down, text: 'Death cross', size: 1 })
    for (const i of model.confirms) {
      if (!signalSet.has(i)) markers.push({ time: time[i], position: 'belowBar', shape: 'circle', color: alpha(t.up, 0.45), size: 0.6 })
    }
    for (const i of model.signals) {
      markers.push({ time: time[i], position: 'belowBar', shape: 'arrowUp', color: t.up, size: signalSet.has(i - 1) ? 0.8 : 1.2 })
    }
    markers.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))
    createSeriesMarkers(candles, markers)

    // Sub-panes ----------------------------------------------------------
    const fixed = (lo, hi) => () => ({ priceRange: { minValue: lo, maxValue: hi } })
    const p = model.params
    if (paneOf('dist') > 0) {
      const pi = paneOf('dist')
      // The ±band: a flat line at +band filled down to a baseline at −band.
      chart.addSeries(BaselineSeries, {
        ...quiet, baseValue: { type: 'price', price: -p.bandPct }, lineWidth: 1, lineStyle: LineStyle.Dotted,
        topLineColor: alpha(t.up, 0.35), topFillColor1: alpha(t.up, 0.08), topFillColor2: alpha(t.up, 0.08),
        bottomLineColor: 'transparent', bottomFillColor1: 'transparent', bottomFillColor2: 'transparent',
      }, pi).setData(bars.map((b) => ({ time: b.t, value: p.bandPct })))
      const d = chart.addSeries(BaselineSeries, {
        ...quiet, lastValueVisible: true, baseValue: { type: 'price', price: 0 }, lineWidth: 1.5,
        topLineColor: t.up, topFillColor1: alpha(t.up, 0.22), topFillColor2: alpha(t.up, 0.02),
        bottomLineColor: t.down, bottomFillColor1: alpha(t.down, 0.02), bottomFillColor2: alpha(t.down, 0.22),
        priceFormat: { type: 'custom', formatter: (v) => `${v.toFixed(0)}%` },
      }, pi)
      d.setData(line(model.dist))
    }
    if (paneOf('rsi') > 0) {
      const r = chart.addSeries(LineSeries, {
        ...quiet, lastValueVisible: true, color: t.fg, lineWidth: 1.5, autoscaleInfoProvider: fixed(0, 100),
        priceFormat: { type: 'custom', formatter: (v) => v.toFixed(0) },
      }, paneOf('rsi'))
      r.setData(line(model.rsi))
      r.createPriceLine({ price: 70, color: alpha(t.down, 0.6), lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false })
      r.createPriceLine({ price: 30, color: alpha(t.up, 0.6), lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false })
      r.createPriceLine({ price: p.rsiLevel, color: t.gold, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, axisLabelColor: alpha(t.gold, 0.85), axisLabelTextColor: '#000' })
    }
    if (paneOf('macd') > 0) {
      const pi = paneOf('macd')
      chart.addSeries(HistogramSeries, { ...quiet, base: 0 }, pi)
        .setData(model.macd.hist.map((v, i) => (v == null ? { time: time[i] }
          : { time: time[i], value: v, color: alpha(v >= 0 ? t.up : t.down, (model.macd.hist[i - 1] != null && Math.abs(v) < Math.abs(model.macd.hist[i - 1])) ? 0.35 : 0.7) })))
      chart.addSeries(LineSeries, { ...quiet, lastValueVisible: true, color: t.gold, lineWidth: 1.5 }, pi).setData(line(model.macd.line))
      chart.addSeries(LineSeries, { ...quiet, color: t.subtle, lineWidth: 1 }, pi).setData(line(model.macd.signal))
    }
    if (paneOf('ivr') > 0) {
      const s = chart.addSeries(LineSeries, {
        ...quiet, lastValueVisible: true, color: t.gold, lineWidth: 1.5, autoscaleInfoProvider: fixed(0, 100),
        priceFormat: { type: 'custom', formatter: (v) => v.toFixed(0) },
      }, paneOf('ivr'))
      s.setData(line(model.ivRank))
      s.createPriceLine({ price: p.ivRankMax, color: t.up, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, axisLabelColor: alpha(t.up, 0.85), axisLabelTextColor: '#000' })
    }
    if (paneOf('ivhv') > 0) {
      const pi = paneOf('ivhv')
      const pf = { type: 'custom', formatter: (v) => `${(v * 100).toFixed(0)}%` }
      chart.addSeries(LineSeries, { ...quiet, lastValueVisible: true, color: t.subtle, lineWidth: 1.5, priceFormat: pf }, pi).setData(line(model.hv))
      chart.addSeries(LineSeries, {
        ...quiet, lastValueVisible: true, color: t.gold, lineWidth: 1.5, priceFormat: pf,
        pointMarkersVisible: model.iv.filter((x) => x != null).length < 60, pointMarkersRadius: 2,
      }, pi).setData(line(model.iv))
    }

    // Echo / Tango: the line around zero, the adaptive rails as steps, and
    // the pillar's diamonds (dots) on the rail they crossed.
    const osc = (k, o) => {
      if (!suite || paneOf(k) <= 0) return
      const pi = paneOf(k)
      const rail = { ...quiet, color: alpha(t.subtle, 0.55), lineWidth: 1, lineType: LineType.WithSteps, lineStyle: LineStyle.Dashed }
      chart.addSeries(LineSeries, rail, pi).setData(line(o.upper))
      chart.addSeries(LineSeries, rail, pi).setData(line(o.lower))
      const ln = chart.addSeries(BaselineSeries, {
        ...quiet, lastValueVisible: true, baseValue: { type: 'price', price: 0 }, lineWidth: 1.5,
        topLineColor: t.up, topFillColor1: alpha(t.up, 0.2), topFillColor2: alpha(t.up, 0.02),
        bottomLineColor: t.down, bottomFillColor1: alpha(t.down, 0.02), bottomFillColor2: alpha(t.down, 0.2),
        priceFormat: { type: 'custom', formatter: (v) => v.toFixed(0) },
      }, pi)
      ln.setData(line(o.line))
      const dots = []
      o.bull.forEach((f, i) => { if (f) dots.push({ time: time[i], position: 'atPriceMiddle', price: o.lower[i], shape: 'circle', color: t.up, size: 0.7 }) })
      o.bear.forEach((f, i) => { if (f) dots.push({ time: time[i], position: 'atPriceMiddle', price: o.upper[i], shape: 'circle', color: t.down, size: 0.7 }) })
      dots.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))
      createSeriesMarkers(ln, dots)
    }
    osc('echo', suite?.echo)
    osc('tango', suite?.tango)

    // Pane heights: price first, the rest equal.
    const all = chart.panes()
    all.forEach((pane, i) => pane.setStretchFactor(i === 0 ? PRICE_H / SUB_H : 1))

    // Zoom: keep the last view on rebuilds; default to the last two years.
    const n = bars.length
    chart.timeScale().setVisibleLogicalRange(rangeRef.current ?? { from: Math.max(0, n - SHOW_DAYS), to: n - 1 + 4 })
    const keep = (r) => { if (r) rangeRef.current = r }
    chart.timeScale().subscribeVisibleLogicalRangeChange(keep)

    const index = new Map(time.map((x, i) => [x, i]))
    const timeKey = (x) => (x && typeof x === 'object' ? `${x.year}-${String(x.month).padStart(2, '0')}-${String(x.day).padStart(2, '0')}` : x)
    const move = (param) => {
      const i = param.time != null ? index.get(timeKey(param.time)) : undefined
      const v = i == null ? null : i
      setHover(v)
      hoverRef.current?.(v)
    }
    chart.subscribeCrosshairMove(move)

    // Legend positions (each pane's top edge).
    const measure = () => {
      let y = 0
      setTops(chart.panes().map((pane) => { const top = y; y += pane.getHeight() + 1; return top }))
    }
    const raf = requestAnimationFrame(measure)
    const ro = new ResizeObserver(() => requestAnimationFrame(measure))
    ro.observe(el)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      chart.unsubscribeCrosshairMove(move)
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(keep)
      chart.remove()
      chartRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, model, suite, key])

  useLayoutEffect(() => { setHover(null) }, [bars])

  // Legends follow the crosshair; off the chart they show the latest day.
  const i = hover ?? (bars?.length ? bars.length - 1 : null)
  const v = (arr) => (i == null ? null : arr?.[i] ?? null)
  const slope = v(model?.slope200)
  const legends = {
    price: [
      { label: '200', value: fmt(v(model?.s200)), cls: slope == null ? 'text-subtle' : slope > 0 ? 'text-green-400' : 'text-rose-300', swatch: slope > 0 ? 'bg-green-400' : 'bg-red-400', thick: true },
      { label: '50', value: fmt(v(model?.s50)), cls: 'text-amber-300', swatch: 'bg-amber-400' },
      { label: 'W50', value: fmt(v(model?.wema)), cls: 'text-subtle', swatch: 'bg-fg/70', dashed: true },
    ],
    dist: [{ label: 'vs 200-day', value: pct(v(model?.dist)), cls: v(model?.dist) < 0 ? 'text-rose-300' : 'text-green-400' }, { label: `±${model?.params.bandPct}% band`, value: '', cls: 'text-muted' }],
    rsi: [{ label: 'RSI 14', value: fmt(v(model?.rsi), 1), cls: 'text-fg' }],
    macd: [
      { label: 'MACD', value: fmt(v(model?.macd.line)), cls: 'text-amber-300', swatch: 'bg-amber-400' },
      { label: 'Signal', value: fmt(v(model?.macd.signal)), cls: 'text-subtle', swatch: 'bg-subtle' },
      { label: 'Hist', value: fmt(v(model?.macd.hist)), cls: v(model?.macd.hist) < 0 ? 'text-rose-300' : 'text-green-400' },
    ],
    ivr: [{ label: model?.ivSource === 'iv' ? 'IV Rank' : 'IV Rank (HV)', value: fmt(v(model?.ivRank), 0), cls: v(model?.ivRank) < model?.params.ivRankMax ? 'text-green-400' : 'text-amber-300' }],
    echo: [
      { label: 'Echo', value: fmt(v(suite?.echo.line), 1), cls: v(suite?.echo.line) < 0 ? 'text-rose-300' : 'text-green-400' },
      { label: 'rails', value: `${fmt(v(suite?.echo.upper), 0)} / ${fmt(v(suite?.echo.lower), 0)}`, cls: 'text-subtle' },
    ],
    tango: [
      { label: 'Tango', value: fmt(v(suite?.tango.line), 1), cls: v(suite?.tango.line) < 0 ? 'text-rose-300' : 'text-green-400' },
      { label: 'rails', value: `${fmt(v(suite?.tango.upper), 0)} / ${fmt(v(suite?.tango.lower), 0)}`, cls: 'text-subtle' },
    ],
    ivhv: [
      { label: 'IV', value: v(model?.iv) == null ? '—' : `${(v(model?.iv) * 100).toFixed(1)}%`, cls: 'text-amber-300', swatch: 'bg-amber-400' },
      { label: 'HV 20', value: v(model?.hv) == null ? '—' : `${(v(model?.hv) * 100).toFixed(1)}%`, cls: 'text-subtle', swatch: 'bg-subtle' },
    ],
  }

  return (
    <div className="relative" style={{ height }}>
      <div ref={box} className="absolute inset-0" />
      {shown.map((k, pi) => (
        <div key={k} className="absolute left-3 right-16 pointer-events-none flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10.5px] leading-4 font-mono-tab"
          style={{ top: (tops[pi] ?? 0) + 6 }}>
          {legends[k].map((l) => (
            <span key={l.label} className="inline-flex items-center gap-1.5 bg-bg/70 rounded px-1 -mx-1">
              {l.swatch && <span className={`inline-block w-2.5 rounded-full ${l.thick ? 'h-[3px]' : 'h-[2px]'} ${l.swatch} ${l.dashed ? 'opacity-70' : ''}`} aria-hidden />}
              <span className="text-muted">{l.label}</span>
              {l.value !== '' && <span className={l.cls}>{l.value}</span>}
            </span>
          ))}
        </div>
      ))}
    </div>
  )
}
