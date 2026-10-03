import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { FEATURES } from '../lib/features'
import { Maximize2 } from 'lucide-react'
import { DiamondMarkers, LANE_PX } from './chartDiamonds'
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
// show. Each pane has a violet title and, when `onExpand` is passed, a
// maximize button (top right) — `onExpand(key)`; the page then renders
// <EntryChart focus={key} fill={px} /> full screen with that pane alone.
// Colors are the theme tokens, read at runtime.

function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}
function alpha(hex, a) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return hex
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${a})`
}

// Echo and Tango right under the price (owner, 2026-10-03).
export const SUB_PANES = [
  ['echo', 'Echo'],
  ['tango', 'Tango'],
  ['conf', 'Confluence'],
  ['dist', '200-day'],
  ['rsi', 'RSI'],
  ['macd', 'MACD'],
  ['ivr', 'IV Rank'],
  ['ivhv', 'IV / HV'],
]
// The Bravo band is gone (owner, 2026-10-03: not needed — the diamonds
// carry the signal and the suite card shows the trend).
export const LAYERS = [
  ['bravoSignals', 'Bravo ◆'],
  ['exits', 'Exits'],
  ['swings', 'Swing lows'],
  ...(FEATURES.hardening ? [['hardening', 'Hardening ★']] : []),
]
const PRICE_H = 340
const SUB_H = 112
// Header strip above each pane's data (title + live values), px.
const HEADER_PRICE = 46
const HEADER_SUB = 30
export const PANE_TITLES = {
  price: 'Price', dist: '% vs 200-day', rsi: 'RSI 14', macd: 'MACD 12·26·9', ivr: 'IV Rank',
  ivhv: 'IV vs HV 20', echo: 'Echo', tango: 'Tango', conf: 'Confluence',
}
const CONF_NAMES = { zone: 'Zone', bravo: 'Bravo', echo: 'Echo', tango: 'Tango', macd: 'MACD', ext: 'Extended',
  'bravo↓': 'Bravo↓', 'echo↓': 'Echo↓', 'tango↓': 'Tango↓', 'macd↓': 'MACD↓' }
const SHOW_DAYS = 504 // two years of trading days in view by default
// "% vs 200-day" reads "% vs 200-week" on weekly bars, etc.
export function paneTitle(k, tf = '1d') {
  if (k === 'dist' && tf === '1wk') return '% vs 200-week'
  if (k === 'dist' && tf === '1mo') return '% vs 200-month'
  return PANE_TITLES[k]
}

const fmt = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }))
const pct = (v, d = 1) => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}%`)

// Bar intervals the chart can draw. Weekly / monthly (owner, 2026-10-03:
// the candles follow the Signal suite's timeframe) run the same indicator
// math on those bars — 50 / 200-week averages, weekly RSI and MACD — and
// drop what only exists daily: the buy-zone shading and arrows, the IV
// panes and the weekly-50-on-days line.
export const INTERVALS = {
  '1d': { unit: '', show: SHOW_DAYS, jump: 63 },
  '1wk': { unit: 'W', show: 260, jump: 26 },
  '1mo': { unit: 'M', show: 120, jump: 12 },
}
export const DAILY_ONLY_PANES = new Set(['ivr', 'ivhv', 'conf'])
// A date row under every pane but the last (which has the chart's own axis).
const DATE_ROW = 16

export default function EntryChart({ bars, model, suite, conf = null, suiteLabel = null, panes, layers = [], onHover, onExpand, focus = null, fill = null, jump = null, tf = '1d' }) {
  const iv = INTERVALS[tf] ?? INTERVALS['1d']
  const daily = tf === '1d'
  const box = useRef(null)
  const hoverRef = useRef(onHover)
  hoverRef.current = onHover
  const rangeRef = useRef(null)      // keeps zoom / pan across rebuilds
  const chartRef = useRef(null)
  const holdRef = useRef(0)
  const [hover, setHover] = useState(null)
  const [tops, setTops] = useState([])
  const [ticks, setTicks] = useState([])
  const shown = focus ? [focus] : ['price', ...SUB_PANES.map(([k]) => k).filter((k) => panes.includes(k) && (daily || !DAILY_ONLY_PANES.has(k)))]
  const showPrice = shown[0] === 'price'
  const height = fill ?? (showPrice ? PRICE_H : 0) + (shown.length - (showPrice ? 1 : 0)) * SUB_H
  const key = `${shown.join(',')}|${layers.join(',')}|${tf}`

  useEffect(() => {
    const el = box.current
    if (!el || !bars?.length || !model) return undefined
    const on = (k) => layers.includes(k) && suite
    const t = {
      up: token('--color-green-400'), down: token('--color-red-400'), gold: token('--color-amber-400'),
      suiteBull: token('--color-suite-bull'), suiteBear: token('--color-suite-bear'), bg: token('--color-bg'),
      goldHi: token('--color-amber-200'), fg: token('--color-fg'), muted: token('--color-muted'),
      subtle: token('--color-subtle'), faint: token('--color-faint'), border: token('--color-border'), borderHi: token('--color-border-hover'),
      violet: token('--color-confluence'),
    }
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        // Axis numbers in the secondary-text grey (muted was too dim on phones).
        textColor: t.subtle, fontSize: 11, fontFamily: getComputedStyle(el).fontFamily,
        attributionLogo: false,
        panes: { separatorColor: t.borderHi, separatorHoverColor: t.borderHi, enableResize: false },
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
    // Create every pane up front, in order: the library appends a pane when
    // a series asks for an index past the last one, so adding a lower pane's
    // series first would land it in the wrong slot.
    for (let k = 1; k < shown.length; k++) chart.addPane(true)

    // Price pane ---------------------------------------------------------
    if (showPrice) {
    // Buy-zone shading: full-height columns on signal days, its own scale.
    const zone = chart.addSeries(HistogramSeries, { ...quiet, priceScaleId: 'zone', base: 0 }, 0)
    chart.priceScale('zone', 0).applyOptions({ visible: false, scaleMargins: { top: 0, bottom: 0 } })
    zone.setData(bars.map((b, i) => (daily && model.cond[i]?.all
      ? { time: b.t, value: 1, color: alpha(t.up, 0.13) }
      : { time: b.t })))

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: t.up, downColor: t.down, wickUpColor: t.up, wickDownColor: t.down, borderVisible: false,
      priceLineColor: t.subtle, priceLineStyle: LineStyle.Dotted,
    }, 0)
    candles.setData(bars.map((b) => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c })))
    chart.priceScale('right', 0).applyOptions({ scaleMargins: { top: 0.06, bottom: 0.08 } })

    if (daily) {
      const wema = chart.addSeries(LineSeries, { ...quiet, color: alpha(t.fg, 0.7), lineWidth: 1, lineStyle: LineStyle.Dashed }, 0)
      wema.setData(line(model.wema))
    }
    const s50 = chart.addSeries(LineSeries, { ...quiet, color: t.gold, lineWidth: 1.5 }, 0)
    s50.setData(line(model.s50))
    const s200 = chart.addSeries(LineSeries, { ...quiet, color: t.up, lineWidth: 3 }, 0)
    s200.setData(model.s200.map((v, i) => (v == null ? { time: time[i] }
      : { time: time[i], value: v, color: model.slope200[i] == null ? t.subtle : model.slope200[i] > 0 ? t.up : t.down })))

    if (on('bravo')) {
      const band = { ...quiet, color: alpha(t.subtle, 0.45), lineWidth: 1, lineType: LineType.WithSteps }
      chart.addSeries(LineSeries, band, 0).setData(line(suite.bravo.upperBand))
      chart.addSeries(LineSeries, band, 0).setData(line(suite.bravo.lowerBand))
      chart.addSeries(LineSeries, { ...quiet, color: alpha(t.subtle, 0.6), lineWidth: 1, lineStyle: LineStyle.Dotted, lineType: LineType.WithSteps }, 0).setData(line(suite.bravo.basis))
      chart.addSeries(LineSeries, { ...quiet, color: t.goldHi, lineWidth: 1.5, lineType: LineType.WithSteps }, 0).setData(line(suite.bravo.fast))
    }

    const signalSet = new Set(daily ? model.signals : [])
    const markers = []
    const stars = (n) => '★'.repeat(n)
    if (FEATURES.hardening && on('hardening')) {
      for (const sg of suite.signals) {
        if (sg.i < 0) continue // before the daily bars (weekly / monthly history)
        markers.push(sg.side === 'bull'
          ? { time: time[sg.i], position: 'belowBar', shape: 'arrowUp', color: t.gold, size: 1.5, text: stars(sg.stars) }
          : { time: time[sg.i], position: 'aboveBar', shape: 'arrowDown', color: t.down, size: 1.5, text: stars(sg.stars) })
      }
    }
    // Bravo signals: solid diamonds with a B — blue under the candle when its
    // bull trend turns on, pink above when the bear one does. Exits: hollow
    // pink diamonds above the candle with the reason inside (E / T / B),
    // stacked over a Bravo bear diamond on the same day.
    const priceDiamonds = []
    const bravoBearDays = new Set()
    if (on('bravoSignals')) {
      suite.bravo.bullOn.forEach((f, i) => { if (f) priceDiamonds.push({ time: time[i], price: bars[i].l, offset: 15, color: t.suiteBull, label: 'B' }) })
      suite.bravo.bearOn.forEach((f, i) => { if (f) { bravoBearDays.add(i); priceDiamonds.push({ time: time[i], price: bars[i].h, offset: -15, color: t.suiteBear, label: 'B' }) } })
    }
    if (on('exits')) {
      for (const x of suite.exits) {
        if (x.i < 0) continue
        priceDiamonds.push({ time: time[x.i], price: bars[x.i].h, offset: bravoBearDays.has(x.i) ? -36 : -15, color: t.suiteBear, label: x.why.join(''), hollow: true })
      }
    }
    if (priceDiamonds.length) {
      const pd = new DiamondMarkers({ outline: t.bg, size: 7 })
      candles.attachPrimitive(pd)
      pd.setPoints(priceDiamonds)
    }
    for (const i of model.golden) markers.push({ time: time[i], position: 'aboveBar', shape: 'circle', color: t.gold, text: 'Golden cross', size: 1 })
    for (const i of model.death) markers.push({ time: time[i], position: 'aboveBar', shape: 'circle', color: t.down, text: 'Death cross', size: 1 })
    // Buy-zone arrows and MACD confirmations: daily only.
    if (daily) {
      for (const i of model.confirms) {
        if (!signalSet.has(i)) markers.push({ time: time[i], position: 'belowBar', shape: 'circle', color: alpha(t.up, 0.45), size: 0.6 })
      }
      for (const i of model.signals) {
        markers.push({ time: time[i], position: 'belowBar', shape: 'arrowUp', color: t.up, size: signalSet.has(i - 1) ? 0.8 : 1.2 })
      }
    }
    // Swing lows / highs (hindsight — they grade the signals, never feed them).
    if (conf && layers.includes('swings')) {
      for (const i of conf.swings.lows) markers.push({ time: time[i], position: 'belowBar', shape: 'circle', color: t.violet, size: 0.7 })
      for (const i of conf.swings.highs) markers.push({ time: time[i], position: 'aboveBar', shape: 'circle', color: alpha(t.subtle, 0.8), size: 0.6 })
    }
    markers.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))
    createSeriesMarkers(candles, markers)
    }

    // Sub-panes ----------------------------------------------------------
    const fixed = (lo, hi) => () => ({ priceRange: { minValue: lo, maxValue: hi } })
    // 0–100 scales: blank tick labels past the ends (the header strip sits above 100).
    const pct100 = (v) => (v > 100.5 || v < -0.5 ? '' : v.toFixed(0))
    const p = model.params
    if (paneOf('dist') >= 0) {
      const pi = paneOf('dist')
      // The ±band: a flat line at +band filled down to a baseline at −band.
      if (daily) {
        chart.addSeries(BaselineSeries, {
          ...quiet, baseValue: { type: 'price', price: -p.bandPct }, lineWidth: 1, lineStyle: LineStyle.Dotted,
          topLineColor: alpha(t.up, 0.35), topFillColor1: alpha(t.up, 0.08), topFillColor2: alpha(t.up, 0.08),
          bottomLineColor: 'transparent', bottomFillColor1: 'transparent', bottomFillColor2: 'transparent',
        }, pi).setData(bars.map((b) => ({ time: b.t, value: p.bandPct })))
      }
      const d = chart.addSeries(BaselineSeries, {
        ...quiet, lastValueVisible: true, baseValue: { type: 'price', price: 0 }, lineWidth: 1.5,
        topLineColor: t.up, topFillColor1: alpha(t.up, 0.22), topFillColor2: alpha(t.up, 0.02),
        bottomLineColor: t.down, bottomFillColor1: alpha(t.down, 0.02), bottomFillColor2: alpha(t.down, 0.22),
        priceFormat: { type: 'custom', formatter: (v) => `${v.toFixed(0)}%` },
      }, pi)
      d.setData(line(model.dist))
    }
    if (paneOf('rsi') >= 0) {
      const r = chart.addSeries(LineSeries, {
        ...quiet, lastValueVisible: true, color: t.fg, lineWidth: 1.5, autoscaleInfoProvider: fixed(0, 100),
        priceFormat: { type: 'custom', formatter: pct100 },
      }, paneOf('rsi'))
      r.setData(line(model.rsi))
      r.createPriceLine({ price: 70, color: alpha(t.down, 0.6), lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false })
      r.createPriceLine({ price: 30, color: alpha(t.up, 0.6), lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false })
      if (daily) r.createPriceLine({ price: p.rsiLevel, color: t.gold, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, axisLabelColor: alpha(t.gold, 0.85), axisLabelTextColor: '#000' })
    }
    if (paneOf('macd') >= 0) {
      const pi = paneOf('macd')
      chart.addSeries(HistogramSeries, { ...quiet, base: 0 }, pi)
        .setData(model.macd.hist.map((v, i) => (v == null ? { time: time[i] }
          : { time: time[i], value: v, color: alpha(v >= 0 ? t.up : t.down, (model.macd.hist[i - 1] != null && Math.abs(v) < Math.abs(model.macd.hist[i - 1])) ? 0.35 : 0.7) })))
      chart.addSeries(LineSeries, { ...quiet, lastValueVisible: true, color: t.gold, lineWidth: 1.5 }, pi).setData(line(model.macd.line))
      chart.addSeries(LineSeries, { ...quiet, color: t.subtle, lineWidth: 1 }, pi).setData(line(model.macd.signal))
    }
    if (paneOf('ivr') >= 0) {
      const s = chart.addSeries(LineSeries, {
        ...quiet, lastValueVisible: true, color: t.gold, lineWidth: 1.5, autoscaleInfoProvider: fixed(0, 100),
        priceFormat: { type: 'custom', formatter: pct100 },
      }, paneOf('ivr'))
      s.setData(line(model.ivRank))
      s.createPriceLine({ price: p.ivRankMax, color: t.up, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, axisLabelColor: alpha(t.up, 0.85), axisLabelTextColor: '#000' })
    }
    if (paneOf('ivhv') >= 0) {
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
      if (!suite || paneOf(k) < 0) return
      const pi = paneOf(k)
      const rail = { ...quiet, color: alpha(t.subtle, 0.55), lineWidth: 1, lineType: LineType.WithSteps, lineStyle: LineStyle.Dashed }
      chart.addSeries(LineSeries, rail, pi).setData(line(o.upper))
      chart.addSeries(LineSeries, rail, pi).setData(line(o.lower))
      const ln = chart.addSeries(BaselineSeries, {
        ...quiet, lastValueVisible: true, baseValue: { type: 'price', price: 0 }, lineWidth: 1.5, lineType: LineType.WithSteps,
        topLineColor: t.suiteBull, topFillColor1: alpha(t.suiteBull, 0.6), topFillColor2: alpha(t.suiteBull, 0.12),
        bottomLineColor: t.suiteBear, bottomFillColor1: alpha(t.suiteBear, 0.12), bottomFillColor2: alpha(t.suiteBear, 0.55),
        priceFormat: { type: 'custom', formatter: (v) => v.toFixed(0) },
      }, pi)
      ln.setData(line(o.line))
      // The pillar's signals in a lane along the pane's bottom: blue diamonds (bull), pink (bear).
      const pts = []
      o.bull.forEach((f, i) => { if (f) pts.push({ time: time[i], color: t.suiteBull }) })
      o.bear.forEach((f, i) => { if (f) pts.push({ time: time[i], color: t.suiteBear }) })
      // Keep the lane above the pane's date row (every pane but the last).
      const dia = new DiamondMarkers({ outline: t.bg, lane: true, size: 8, laneOffset: pi < shown.length - 1 ? DATE_ROW : 0 })
      ln.attachPrimitive(dia)
      dia.setPoints(pts)
    }
    osc('echo', suite?.echo)
    osc('tango', suite?.tango)

    // Confluence: buy signals agreeing (lows) up, sell signals (extended
    // highs) down — each 0–5 over the last N bars. Bigger = more agreement.
    if (conf && paneOf('conf') >= 0) {
      const pi = paneOf('conf')
      const buyTone = (sc) => (sc >= 4 ? t.up : sc === 3 ? t.violet : sc === 2 ? alpha(t.violet, 0.5) : alpha(t.subtle, 0.35))
      const sellTone = (sc) => (sc >= 4 ? t.down : sc === 3 ? t.suiteBear : sc === 2 ? alpha(t.suiteBear, 0.5) : alpha(t.subtle, 0.35))
      const fmt5 = { type: 'custom', formatter: (x) => (Math.abs(x) > 5.2 ? '' : Math.abs(x).toFixed(0)) }
      const hb = chart.addSeries(HistogramSeries, { ...quiet, lastValueVisible: true, base: 0, autoscaleInfoProvider: fixed(-5, 5), priceFormat: fmt5 }, pi)
      hb.setData(conf.buy.series.map((c, i) => (c.score ? { time: time[i], value: c.score, color: buyTone(c.score) } : { time: time[i], value: 0 })))
      const hs = chart.addSeries(HistogramSeries, { ...quiet, lastValueVisible: true, base: 0, autoscaleInfoProvider: fixed(-5, 5), priceFormat: fmt5 }, pi)
      hs.setData(conf.sell.series.map((c, i) => (c.score ? { time: time[i], value: -c.score, color: sellTone(c.score) } : { time: time[i], value: 0 })))
      hb.createPriceLine({ price: 3, color: alpha(t.violet, 0.6), lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false })
      hb.createPriceLine({ price: -3, color: alpha(t.suiteBear, 0.6), lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false })
    }

    // Indicator panes: little padding, so 0–100 scales stay 0–100 when tall.

    // Pane heights: price first, the rest equal.
    const all = chart.panes()
    all.forEach((pane, i) => pane.setStretchFactor(i === 0 && showPrice ? PRICE_H / SUB_H : 1))

    // Zoom: keep the last view on rebuilds; default to the last two years.
    const n = bars.length
    // A new interval starts from its default window (bar indexes differ).
    if (rangeRef.current?.tf !== tf) rangeRef.current = null
    chart.timeScale().setVisibleLogicalRange(rangeRef.current ?? { from: Math.max(0, n - iv.show), to: n - 1 + 4 })

    // Date rows under the panes: month (or year) starts in view, at least
    // 64px apart — the same kind of labels as the chart's own axis.
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    let tickRaf = 0
    const computeTicks = () => {
      tickRaf = 0
      const r = chart.timeScale().getVisibleLogicalRange()
      if (!r) return
      const from = Math.max(1, Math.ceil(r.from))
      const to = Math.min(n - 1, Math.floor(r.to))
      const span = to >= from ? (Date.parse(bars[to].t) - Date.parse(bars[from].t)) / 86400000 : 0
      // Years first (always labelled when they fit), then months in the gaps
      // when the view is under two years.
      const years = []
      const months = []
      for (let k = from; k <= to; k++) {
        const a = String(bars[k - 1].t)
        const b = String(bars[k].t)
        const x = chart.timeScale().logicalToCoordinate(k)
        if (x == null) continue
        if (a.slice(0, 4) !== b.slice(0, 4)) years.push({ x, label: b.slice(0, 4), strong: true })
        else if (span < 730 && a.slice(5, 7) !== b.slice(5, 7)) months.push({ x, label: MONTHS[+b.slice(5, 7) - 1] })
      }
      const out = []
      const fits = (x) => out.every((o) => Math.abs(o.x - x) >= 56)
      for (const y of years) if (fits(y.x)) out.push(y)
      for (const m of months) if (fits(m.x)) out.push(m)
      setTicks(out)
    }
    const keep = (r) => {
      if (r) rangeRef.current = { ...r, tf }
      if (!tickRaf) tickRaf = requestAnimationFrame(computeTicks)
    }
    chart.timeScale().subscribeVisibleLogicalRangeChange(keep)

    const index = new Map(time.map((x, i) => [x, i]))
    const timeKey = (x) => (x && typeof x === 'object' ? `${x.year}-${String(x.month).padStart(2, '0')}-${String(x.day).padStart(2, '0')}` : x)
    const move = (param) => {
      // Right after a jump the page scrolls under a resting mouse; keep the jump's bar.
      if (Date.now() < holdRef.current) return
      const i = param.time != null ? index.get(timeKey(param.time)) : undefined
      const v = i == null ? null : i
      setHover(v)
      hoverRef.current?.(v)
    }
    chart.subscribeCrosshairMove(move)

    // Legend positions (each pane's top edge).
    // Each pane keeps a header strip (title + values) above its data: the
    // top scale margin is the header's height over the pane's height.
    const measure = () => {
      let y = 0
      const ps = chart.panes()
      ps.forEach((pane, pi) => {
        const h = pane.getHeight()
        if (!h) return
        const top = Math.min(0.45, (shown[pi] === 'price' ? HEADER_PRICE : HEADER_SUB) / h)
        // Echo / Tango keep a signal lane under their line.
        const lane = shown[pi] === 'echo' || shown[pi] === 'tango'
        // Room for the date row under every pane but the last.
        const dates = pi < ps.length - 1 ? DATE_ROW : 0
        const bottom = shown[pi] === 'price' ? Math.min(0.45, 0.06 + dates / h) : Math.min(0.45, ((lane ? LANE_PX + 6 : h * 0.05) + dates) / h)
        chart.priceScale('right', pi).applyOptions({ scaleMargins: { top, bottom } })
        if (shown[pi] === 'price') chart.priceScale('zone', pi).applyOptions({ scaleMargins: { top, bottom: 0 } })
      })
      setTops(ps.map((pane) => { const top = y; y += pane.getHeight() + 1; return top }))
      computeTicks()
    }
    const raf = requestAnimationFrame(measure)
    const ro = new ResizeObserver(() => requestAnimationFrame(measure))
    ro.observe(el)

    return () => {
      cancelAnimationFrame(raf)
      if (tickRaf) cancelAnimationFrame(tickRaf)
      ro.disconnect()
      chart.unsubscribeCrosshairMove(move)
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(keep)
      chart.remove()
      chartRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, model, suite, conf, key, tf])

  useLayoutEffect(() => { setHover(null) }, [bars])

  // jump = { i, n } (n changes per request): center the view on bar i,
  // about three months either side, and put the crosshair there.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !jump || !bars?.length) return
    const r = { from: Math.max(0, jump.i - iv.jump), to: Math.min(bars.length - 1 + 4, jump.i + iv.jump), tf }
    rangeRef.current = r
    holdRef.current = Date.now() + 1200
    chart.timeScale().setVisibleLogicalRange(r)
    setHover(jump.i)
    hoverRef.current?.(jump.i)
  }, [jump, bars, tf, iv.jump])

  // Legends follow the crosshair; off the chart they show the latest day.
  const i = hover ?? (bars?.length ? bars.length - 1 : null)
  const v = (arr) => (i == null ? null : arr?.[i] ?? null)
  const slope = v(model?.slope200)
  const legends = {
    price: [
      { label: `200${iv.unit}`, value: fmt(v(model?.s200)), cls: slope == null ? 'text-subtle' : slope > 0 ? 'text-green-400' : 'text-rose-300', swatch: slope > 0 ? 'bg-green-400' : 'bg-red-400', thick: true },
      { label: `50${iv.unit}`, value: fmt(v(model?.s50)), cls: 'text-amber-300', swatch: 'bg-amber-400' },
      ...(daily ? [{ label: 'W50', value: fmt(v(model?.wema)), cls: 'text-subtle', swatch: 'bg-fg/70', dashed: true }] : []),
    ],
    dist: [{ label: '', value: pct(v(model?.dist)), cls: v(model?.dist) < 0 ? 'text-rose-300' : 'text-green-400' },
      ...(daily ? [{ label: `±${model?.params.bandPct}% band`, value: '', cls: 'text-muted' }] : [])],
    rsi: [{ label: '', value: fmt(v(model?.rsi), 1), cls: 'text-fg' }],
    macd: [
      { label: '', value: fmt(v(model?.macd.line)), cls: 'text-amber-300', swatch: 'bg-amber-400' },
      { label: '', value: fmt(v(model?.macd.signal)), cls: 'text-subtle', swatch: 'bg-subtle' },
      { label: 'Hist', value: fmt(v(model?.macd.hist)), cls: v(model?.macd.hist) < 0 ? 'text-rose-300' : 'text-green-400' },
    ],
    ivr: [{ label: model?.ivSource === 'iv' ? '' : 'HV stand-in', value: fmt(v(model?.ivRank), 0), cls: v(model?.ivRank) < model?.params.ivRankMax ? 'text-green-400' : 'text-amber-300' }],
    echo: [
      { label: '', value: fmt(v(suite?.echo.line), 1), cls: v(suite?.echo.line) < 0 ? 'text-suite-bear' : 'text-suite-bull' },
      { label: 'rails', value: `${fmt(v(suite?.echo.upper), 0)} / ${fmt(v(suite?.echo.lower), 0)}`, cls: 'text-subtle' },
    ],
    tango: [
      { label: '', value: fmt(v(suite?.tango.line), 1), cls: v(suite?.tango.line) < 0 ? 'text-suite-bear' : 'text-suite-bull' },
      { label: 'rails', value: `${fmt(v(suite?.tango.upper), 0)} / ${fmt(v(suite?.tango.lower), 0)}`, cls: 'text-subtle' },
    ],
    conf: [
      { label: 'Buy', value: v(conf?.buy.series)?.score != null ? `${v(conf?.buy.series).score}/5` : '—', cls: (v(conf?.buy.series)?.score ?? 0) >= 3 ? 'text-confluence' : 'text-subtle' },
      { label: 'Sell', value: v(conf?.sell.series)?.score != null ? `${v(conf?.sell.series).score}/5` : '—', cls: (v(conf?.sell.series)?.score ?? 0) >= 3 ? 'text-suite-bear' : 'text-subtle' },
      { label: [...(v(conf?.buy.series)?.lit ?? []), ...(v(conf?.sell.series)?.lit ?? []).map((k) => (k === 'ext' ? 'ext' : `${k}↓`))].map((k) => CONF_NAMES[k] ?? k).join(' · ') || `last ${conf?.window ?? 5} days`, value: '', cls: 'text-muted' },
    ],
    ivhv: [
      { label: 'IV', value: v(model?.iv) == null ? '—' : `${(v(model?.iv) * 100).toFixed(1)}%`, cls: 'text-amber-300', swatch: 'bg-amber-400' },
      { label: 'HV 20', value: v(model?.hv) == null ? '—' : `${(v(model?.hv) * 100).toFixed(1)}%`, cls: 'text-subtle', swatch: 'bg-subtle' },
    ],
  }

  return (
    <div className="relative" style={{ height }}>
      <div ref={box} className="absolute inset-0" />
      {/* Pane dividers: a 2px line over the chart's 1px separator, so panes read as separate. */}
      {/* Date rows under every pane but the last (the chart's own axis is there). */}
      {shown.map((k, pi) => (pi < shown.length - 1 && tops[pi + 1] != null ? (
        <div key={`dates-${k}`} className="absolute inset-x-0 pointer-events-none text-[10px] leading-none font-mono-tab text-muted"
          style={{ top: tops[pi + 1] - DATE_ROW + 2, height: DATE_ROW - 4 }} aria-hidden>
          {ticks.map((tk) => (
            <span key={tk.x} className={`absolute -translate-x-1/2 whitespace-nowrap ${tk.strong ? 'text-subtle font-semibold' : ''}`} style={{ left: tk.x }}>{tk.label}</span>
          ))}
        </div>
      ) : null))}
      {shown.map((k, pi) => (pi > 0 && tops[pi] != null ? (
        <div key={`sep-${k}`} className="absolute inset-x-0 h-[2px] bg-border-hover pointer-events-none" style={{ top: tops[pi] - 1.5 }} aria-hidden />
      ) : null))}
      {shown.map((k, pi) => (
        <div key={k}>
          <div className={`absolute left-3 right-[104px] pointer-events-none flex items-center gap-x-3 gap-y-0.5 text-[11px] leading-4 font-mono-tab ${k === 'price' ? 'flex-wrap' : 'flex-nowrap overflow-hidden whitespace-nowrap !gap-x-2'}`}
            style={{ top: (tops[pi] ?? 0) + 7 }}>
            <span className="bg-bg/80 rounded px-1 -mx-1 text-[11px] font-semibold text-violet-300">
              {paneTitle(k, tf)}{suiteLabel && (k === 'echo' || k === 'tango' || (k === 'price' && !daily)) ? ` · ${suiteLabel}` : ''}
            </span>
            {legends[k].map((l, li) => (
              <span key={li} className="inline-flex items-center gap-1.5 bg-bg/70 rounded px-1 -mx-1">
                {l.swatch && <span className={`inline-block w-2.5 rounded-full ${l.thick ? 'h-[3px]' : 'h-[2px]'} ${l.swatch} ${l.dashed ? 'opacity-70' : ''}`} aria-hidden />}
                {l.label && <span className="text-muted">{l.label}</span>}
                {l.value !== '' && <span className={l.cls}>{l.value}</span>}
              </span>
            ))}
          </div>
          {onExpand && !focus && (
            <button type="button" onClick={() => onExpand(k)} aria-label={`Expand ${paneTitle(k, tf)}`}
              className="absolute right-[60px] z-10 h-7 w-7 flex items-center justify-center rounded-md bg-bg/80 border border-border text-violet-300 hover:text-violet-200 hover:border-violet-400/50 transition"
              style={{ top: (tops[pi] ?? 0) + 4 }}>
              <Maximize2 size={13} aria-hidden />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
