import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import clsx from 'clsx'
import { ArrowDown, ArrowLeft, ArrowUp, Check, ChevronRight, Info, Maximize2, Plus, RotateCcw, Search, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { CHART_TICKERS } from '../lib/chartTickers'
import { entryModel, entryGaps, DEFAULT_PARAMS, HORIZONS } from '../utils/indicators'
import EntryChart, { LAYERS, SUB_PANES, DAILY_ONLY_PANES, paneTitle } from '../components/EntryChart'
import { suiteModel, forwardReturns, horizonStats, normalizePeriods, suiteOnDays, periodKey, SUITE_TIMEFRAMES } from '../utils/signalSuite'
import TickerDrawer from '../components/TickerDrawer'
import NumberInput from '../components/NumberInput'
import { FEATURES } from '../lib/features'

// /charts/entry/:ticker — the LEAPS entry chart. Price with 200 / 50 SMA and
// the weekly 50 EMA, five indicator panes, the combined buy-zone signal
// (every condition true on the same day), today's status, adjustable
// thresholds (saved on this device) and a backtest of past signals.
// Data: the leaps-entry edge function (5 years of Yahoo daily bars + IV);
// the math is utils/indicators.js, run here so thresholds apply live.

const PARAMS_KEY = 'cm:entry-params'
const PANES_KEY = 'cm:entry-panes:v2'
// v2: saved choices from before the Bravo ◆ layer existed left it off.
const LAYERS_KEY = 'cm:entry-layers:v2'
const DEFAULT_LAYERS = ['bravoSignals', 'exits']
// The signal suite runs on daily (default — matches TradingView on a daily
// chart), weekly or monthly bars. A Hardening bull this many trading days
// from a buy-zone signal (either side) confirms it (Hardening is hidden:
// FEATURES.hardening).
const SUITE_TF_KEY = 'cm:suite-tf:v2'
const CONFIRM_DAYS = { '1d': 10, '1wk': 10, '1mo': 21 }
// [key, label, min, max, decimals, suffix]
const FIELDS = [
  ['bandPct', '200-day band', 0.5, 50, 1, '±%'],
  ['rsiLevel', 'RSI dip below', 1, 99, 0, ''],
  ['ivRankMax', 'IV Rank below', 1, 100, 0, ''],
  ['lookback', 'RSI lookback', 1, 60, 0, 'days'],
]

function loadJson(key) {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') } catch { return null }
}
function saveJson(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)) } catch { /* this visit only */ }
}
// Typed strings → numbers, falling back to the default when out of range.
function parseParams(draft) {
  const out = { ...DEFAULT_PARAMS }
  for (const [k, , min, max] of FIELDS) {
    const n = Number(draft[k])
    if (draft[k] !== '' && Number.isFinite(n) && n >= min && n <= max) out[k] = k === 'lookback' ? Math.round(n) : n
  }
  return out
}

const money = (v) => (v == null ? '—' : `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const signed = (v, d = 1) => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}%`)
const ret = (v) => (v == null ? null : v * 100)
const shortDay = (t) => {
  const d = new Date(`${t}T12:00:00Z`)
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} ’${String(d.getUTCFullYear()).slice(2)}`
}
const day = (t) => new Date(`${t}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

export default function LeapsEntry() {
  const { ticker: raw } = useParams()
  const ticker = String(raw || 'SPY').toUpperCase()
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [hover, setHover] = useState(null)
  const [draft, setDraft] = useState(() => {
    const saved = loadJson(PARAMS_KEY) ?? {}
    return Object.fromEntries(FIELDS.map(([k]) => [k, String(saved[k] ?? DEFAULT_PARAMS[k])]))
  })
  const [panes, setPanes] = useState(() => {
    const saved = loadJson(PANES_KEY)
    return Array.isArray(saved) ? saved : SUB_PANES.map(([k]) => k)
  })

  useEffect(() => {
    let cancelled = false
    setData(null)
    setHover(null)
    supabase.functions.invoke('leaps-entry', { body: { ticker } }).then(({ data: d, error }) => {
      if (cancelled) return
      setData(error || !d?.success ? { error: d?.error || error?.message || 'failed' } : d)
    })
    return () => { cancelled = true }
  }, [ticker])

  // The user's open positions in this ticker (shares get the sell signals;
  // LEAPS follow their exit plan).
  const [holdings, setHoldings] = useState([])
  useEffect(() => {
    let cancelled = false
    supabase.from('leaps_positions').select('id, ticker, instrument_type, shares, contracts, option_type')
      .eq('ticker', ticker).is('closed_at', null)
      .then(({ data: rows }) => {
        if (cancelled) return
        setHoldings((rows ?? []).filter((r) => r.ticker === ticker && ['stock', 'equity_option', 'index_option_1256'].includes(r.instrument_type)).map((r) => (r.instrument_type === 'stock'
          ? { id: r.id, kind: 'shares', qty: `${Number(r.shares).toLocaleString('en-US', { maximumFractionDigits: 2 })} shares` }
          : { id: r.id, kind: 'leaps', qty: `${Number(r.contracts).toLocaleString('en-US')} ${r.option_type === 'P' ? 'put' : 'call'}${Number(r.contracts) === 1 ? '' : 's'}` })))
      })
    return () => { cancelled = true }
  }, [ticker])

  const params = useMemo(() => parseParams(draft), [draft])
  const bars = data?.bars ?? null
  const model = useMemo(() => (bars?.length
    ? entryModel(bars, { ivPoints: data.iv_points ?? [], ivToday: data.iv_today ?? null, params })
    : null), [bars, data, params])

  const setField = (k, v) => {
    const next = { ...draft, [k]: v }
    setDraft(next)
    saveJson(PARAMS_KEY, parseParams(next))
  }
  const resetParams = () => {
    const next = Object.fromEntries(FIELDS.map(([k]) => [k, String(DEFAULT_PARAMS[k])]))
    setDraft(next)
    saveJson(PARAMS_KEY, DEFAULT_PARAMS)
  }
  const isDefault = FIELDS.every(([k]) => params[k] === DEFAULT_PARAMS[k])
  const [expanded, setExpanded] = useState(null) // a pane key shown full screen
  // Jump the chart to a bar (from the Signal suite tiles or a backtest row).
  const chartBox = useRef(null)
  const [jump, setJump] = useState(null)
  const jumpTo = (i) => {
    if (!(i >= 0)) return
    setJump({ i, n: Date.now() })
    chartBox.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const [layers, setLayers] = useState(() => {
    const saved = loadJson(LAYERS_KEY)
    return Array.isArray(saved) ? saved : DEFAULT_LAYERS
  })
  const toggleLayer = (k) => {
    const next = layers.includes(k) ? layers.filter((x) => x !== k) : [...layers, k]
    setLayers(next)
    saveJson(LAYERS_KEY, next)
  }
  const togglePane = (k) => {
    const next = panes.includes(k) ? panes.filter((x) => x !== k) : [...panes, k]
    setPanes(next)
    saveJson(PANES_KEY, next)
  }

  // Signal suite on weekly / monthly bars (the ticker's whole history), with
  // its events placed on the daily candles their period closes on.
  const [suiteTf, setSuiteTf] = useState(() => { const v = loadJson(SUITE_TF_KEY); return SUITE_TIMEFRAMES[v] ? v : '1d' })
  const [suiteData, setSuiteData] = useState(null)
  useEffect(() => {
    let cancelled = false
    setSuiteData(null)
    // Daily runs on the chart's own bars — nothing more to fetch.
    if (suiteTf === '1d') return undefined
    supabase.functions.invoke('leaps-entry', { body: { ticker, suite: suiteTf } }).then(({ data: d, error }) => {
      if (cancelled) return
      setSuiteData(error || !d?.success ? { tf: suiteTf, error: true } : { tf: suiteTf, ...d })
    })
    return () => { cancelled = true }
  }, [ticker, suiteTf])
  const pickSuiteTf = (tf) => { setSuiteTf(tf); saveJson(SUITE_TF_KEY, tf) }
  const suitePack = useMemo(() => {
    if (!bars?.length) return null
    if (suiteTf === '1d') {
      const periods = normalizePeriods(bars, '1d')
      const raw = suiteModel(periods)
      return { tf: suiteTf, info: SUITE_TIMEFRAMES[suiteTf], periods, raw, days: suiteOnDays(bars, periods, raw, suiteTf) }
    }
    if (!suiteData?.bars?.length || suiteData.tf !== suiteTf) return null
    const periods = normalizePeriods(suiteData.bars, suiteTf)
    // SPY / VIX matched to the ticker's periods.
    const onPeriods = (list) => {
      const byKey = new Map(normalizePeriods(list ?? [], suiteTf).map((x) => [x.k, x.c]))
      return periods.map((pb) => ({ t: pb.t, c: byKey.get(pb.k) })).filter((x) => x.c != null)
    }
    const raw = suiteModel(periods, { spy: onPeriods(suiteData.spy), vix: onPeriods(suiteData.vix) })
    return { tf: suiteTf, info: SUITE_TIMEFRAMES[suiteTf], periods, raw, days: suiteOnDays(bars, periods, raw, suiteTf) }
  }, [bars, suiteData, suiteTf])
  const suite = suitePack?.days ?? null
  const confirmDays = CONFIRM_DAYS[suiteTf]
  // The chart's candles follow the suite timeframe (owner, 2026-10-03):
  // weekly / monthly draw those bars, with the indicator math run on them
  // and the suite on its own bars. The status card stays daily.
  const periodMode = suiteTf !== '1d' && !!suitePack
  const chart = useMemo(() => {
    if (!model) return null
    if (!periodMode) return { bars, model, suite, tf: '1d' }
    const pbars = suitePack.periods.map(({ k, ...b }) => b)
    const pmodel = entryModel(pbars, { params })
    const psuite = suiteOnDays(pbars, suitePack.periods, suitePack.raw, suiteTf)
    // Daily bar → its period's index (for buy-zone backtest rows).
    const byKey = new Map(suitePack.periods.map((pp, pi) => [pp.k, pi]))
    return { bars: pbars, model: pmodel, suite: psuite, tf: suiteTf, periodOfDay: (i) => byKey.get(periodKey(bars[i].t, suiteTf)) ?? -1 }
  }, [periodMode, bars, model, suite, suitePack, suiteTf, params])
  const s = model?.status
  // Jumps: a daily bar (buy-zone rows) or a suite period (tiles, suite rows).
  const jumpDay = (i) => jumpTo(chart?.periodOfDay ? chart.periodOfDay(i) : i)
  const jumpPeriod = (pi) => jumpTo(periodMode || suiteTf === '1d' ? pi : suite?.closeDays?.[pi] ?? -1)
  const cbars = chart?.bars ?? bars
  const last = cbars ? cbars[cbars.length - 1] : null
  const shown = hover != null && cbars ? cbars[hover] : last
  const prev = hover != null && cbars ? cbars[hover - 1] : cbars?.[cbars.length - 2]
  const dayChange = shown && prev ? shown.c / prev.c - 1 : null

  return (
    <div className="px-4 py-4 pb-24 max-w-md md:max-w-3xl mx-auto">
      <header className="flex items-center gap-2 mb-4">
        <Link to="/charts" aria-label="Back to Charts"
          className="min-h-[44px] min-w-[44px] -ml-2 flex items-center justify-center rounded-xl text-subtle hover:text-fg">
          <ArrowLeft size={18} />
        </Link>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] uppercase tracking-[0.14em] text-muted font-semibold">LEAPS entry</div>
          <h1 className="text-lg font-semibold leading-tight">{ticker}</h1>
        </div>
        <button type="button" onClick={() => setSearchOpen(true)} aria-label="Search tickers"
          className="min-h-[44px] px-3 inline-flex items-center gap-2 rounded-xl bg-card border border-border text-sm text-subtle hover:text-fg transition">
          <Search size={15} aria-hidden /> Search
        </button>
      </header>

      {data === null ? (
        <div className="space-y-4" aria-busy="true">
          <div className="h-44 rounded-2xl bg-card border border-border animate-pulse" />
          <div className="h-[520px] rounded-2xl bg-card border border-border animate-pulse" />
        </div>
      ) : data.error || !model ? (
        <section className="bg-card border border-border rounded-2xl p-5">
          <h2 className="text-sm font-semibold mb-1">Couldn't load {ticker}</h2>
          <p className="text-sm text-subtle">Prices for this ticker aren't available right now. Try another one.</p>
        </section>
      ) : (
        <div className="md:grid md:grid-cols-[1fr_280px] md:gap-x-5 md:items-start">
          <div className="min-w-0 md:order-1">
            <StatusPanel s={s} model={model} params={params} suite={suite} confirmDays={confirmDays} tfLabel={SUITE_TIMEFRAMES[suiteTf].label.toLowerCase()} />
            {<SuitePanel pack={suitePack} failed={suiteData?.error && suiteData.tf === suiteTf} tf={suiteTf} onTf={pickSuiteTf} holdings={holdings} onJump={jumpPeriod} onOpenPane={setExpanded}
              bravoOn={layers.includes('bravo')} onBravo={() => { if (!layers.includes('bravo')) toggleLayer('bravo'); chartBox.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }} />}
          </div>

          {/* Chart */}
          <div className="min-w-0 md:order-3 md:col-span-2">
            <section ref={chartBox} className="bg-card border border-border rounded-2xl mb-4 overflow-hidden scroll-mt-4">
              <div className="px-5 pt-4 pb-2 flex items-end gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-2xl font-semibold font-mono-tab leading-none">{money(shown?.c)}</div>
                  <div className="mt-1 text-[11px] text-muted font-mono-tab">
                    {shown && day(shown.t)}
                    {dayChange != null && (
                      <span className={clsx('ml-2', dayChange < 0 ? 'text-rose-300' : 'text-green-400')}>{signed(dayChange * 100, 2)}</span>
                    )}
                  </div>
                </div>
                {hover != null && !periodMode && model.cond[hover] && (
                  <div className="text-right text-[11px] font-mono-tab">
                    <div className="text-muted">Conditions</div>
                    <div className={model.cond[hover].all ? 'text-green-400 font-semibold' : 'text-subtle'}>
                      {countMet(model.cond[hover])} of 5{model.cond[hover].all ? ' · Buy' : ''}
                    </div>
                  </div>
                )}
              </div>
              {/* What's drawn: indicator panels, then layers on the price chart. */}
              <div className="px-5 pb-3 space-y-3">
                <ToggleGroup label="Panels" items={periodMode ? SUB_PANES.filter(([k]) => !DAILY_ONLY_PANES.has(k)) : SUB_PANES} isOn={(k) => panes.includes(k)} onToggle={togglePane} />
                <ToggleGroup label="On price" items={LAYERS} isOn={(k) => layers.includes(k)} onToggle={toggleLayer} />
              </div>
              <EntryChart bars={chart.bars} model={chart.model} suite={chart.suite} tf={chart.tf} suiteLabel={SUITE_TIMEFRAMES[suiteTf].label} panes={panes} layers={layers} onHover={setHover} onExpand={setExpanded} jump={jump} />
              <div className="px-5 py-3 border-t border-hairline flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-muted">
                {!periodMode && <Key className="text-green-400" glyph="▲">Buy signal</Key>}
                {!periodMode && <Key className="text-green-400/50" glyph="●">MACD confirms</Key>}
                <Key className="text-amber-300" glyph="●">Golden cross</Key>
                <Key className="text-rose-300" glyph="●">Death cross</Key>
                {!periodMode && <Key glyph={<span className="inline-block w-3 h-2.5 rounded-sm bg-green-400/15 align-middle" />}>Buy zone</Key>}
                {layers.includes('hardening') && <Key className="text-amber-300" glyph="▲">Hardening bull</Key>}
                {layers.includes('hardening') && <Key className="text-rose-300" glyph="▼">Hardening bear</Key>}
                {layers.includes('bravoSignals') && <Key className="text-suite-bull" glyph="◆">Bravo bull</Key>}
                {layers.includes('bravoSignals') && <Key className="text-suite-bear" glyph="◆">Bravo bear</Key>}
                {layers.includes('exits') && <Key className="text-suite-bear" glyph="◇">Exit (E Echo · T Tango · B Bravo)</Key>}
                {(panes.includes('echo') || panes.includes('tango')) && <Key className="text-suite-bull" glyph="◆">Echo / Tango bull</Key>}
                {(panes.includes('echo') || panes.includes('tango')) && <Key className="text-suite-bear" glyph="◆">Echo / Tango bear</Key>}
              </div>
            </section>
          </div>

          <div className="min-w-0 md:order-2">
            <Thresholds draft={draft} setField={setField} reset={resetParams} isDefault={isDefault} />
          </div>

          <div className="min-w-0 md:order-4 md:col-span-2">
            <Backtest model={model} suite={suite} pack={suitePack} confirmDays={confirmDays} onJumpDay={jumpDay} onJumpPeriod={jumpPeriod} />
          </div>
        </div>
      )}

      {expanded && chart && (
        <FullPane title={`${ticker} · ${paneTitle(expanded, chart.tf)}`} onClose={() => setExpanded(null)}>
          {(h) => <EntryChart bars={chart.bars} model={chart.model} suite={chart.suite} tf={chart.tf} suiteLabel={SUITE_TIMEFRAMES[suiteTf].label} panes={panes} layers={layers} focus={expanded} fill={h} />}
        </FullPane>
      )}

      <TickerDrawer
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        curated={CHART_TICKERS}
        watchlist={[]}
        gatedSet={NO_GATES}
        selected={ticker}
        onSelect={(sym) => { setSearchOpen(false); navigate(`/charts/entry/${encodeURIComponent(sym)}`) }}
        allowCustom
        feedLabels={false}
      />
    </div>
  )
}
const NO_GATES = new Set()

// A labelled row of on / off chips. On: violet tint + check. Off: neutral + plus.
function ToggleGroup({ label, items, isOn, onToggle }) {
  return (
    <div role="group" aria-label={label}>
      <div className="text-[11px] uppercase tracking-[0.12em] text-muted font-semibold mb-1.5">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {items.map(([k, name]) => {
          const on = isOn(k)
          return (
            <button key={k} type="button" onClick={() => onToggle(k)} aria-pressed={on}
              className={clsx('min-h-[34px] pl-2 pr-2.5 rounded-full text-xs font-semibold border inline-flex items-center gap-1 transition',
                on ? 'bg-violet-400/12 border-violet-400/45 text-violet-200 hover:bg-violet-400/18'
                  : 'bg-transparent border-border text-subtle hover:text-fg hover:border-border-hover')}>
              {on ? <Check size={12} strokeWidth={3} aria-hidden /> : <Plus size={12} strokeWidth={2.5} aria-hidden />}
              {name}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// One pane full screen. Esc or X closes; the page doesn't scroll behind it.
function FullPane({ title, onClose, children }) {
  const body = useRef(null)
  const close = useRef(onClose)
  close.current = onClose
  const [h, setH] = useState(null)
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const key = (e) => { if (e.key === 'Escape') close.current() }
    window.addEventListener('keydown', key)
    const ro = new ResizeObserver(() => setH(body.current?.clientHeight ?? null))
    if (body.current) ro.observe(body.current)
    return () => { document.body.style.overflow = prev; window.removeEventListener('keydown', key); ro.disconnect() }
  }, [])
  return (
    <div className="fixed inset-0 z-[70] bg-bg flex flex-col" role="dialog" aria-modal="true" aria-label={title}
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <div className="flex items-center gap-2 px-4 py-2 border-b border-hairline">
        <h2 className="flex-1 min-w-0 truncate text-sm font-semibold text-violet-300">{title}</h2>
        <button type="button" onClick={onClose} aria-label="Close"
          className="min-h-[44px] min-w-[44px] -mr-2 flex items-center justify-center rounded-xl text-subtle hover:text-fg">
          <X size={18} />
        </button>
      </div>
      <div ref={body} className="flex-1 min-h-0">{h ? children(h) : null}</div>
    </div>
  )
}

const countMet = (c) => ['band', 'rising', 'trend', 'rsi', 'iv'].filter((k) => c[k]).length

function Key({ glyph, className, children }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={clsx('text-[10px] leading-none', className)} aria-hidden>{glyph}</span>{children}
    </span>
  )
}

function StatusPanel({ s, model, params, suite, confirmDays, tfLabel }) {
  const c = s.cond
  const yes = c.all
  const met = countMet(c)
  const lastConfirm = model.macdUp.length ? model.macdUp[model.macdUp.length - 1] : null
  const lastIdx = model.closes.length - 1
  const macdAgo = lastConfirm == null ? null : lastIdx - lastConfirm
  const lastTrade = model.trades[model.trades.length - 1]
  const onChart = suite?.bulls.filter((b) => b.i >= 0) ?? []
  const hBull = onChart[onChart.length - 1] ?? null
  const hAgo = hBull ? lastIdx - hBull.i : null
  const hOk = hAgo != null && hAgo <= confirmDays
  // What each unmet condition still needs (next entry).
  // Hidden until the row's gold (i) is tapped (owner, 2026-10-03).
  const gaps = entryGaps(model) ?? {}
  const [shown, setShown] = useState(() => new Set())
  const toggle = (k) => setShown((prev) => {
    const next = new Set(prev)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    return next
  })
  const rows = [
    {
      key: 'band', ok: c.band, label: `Within ±${params.bandPct}% of the 200-day`,
      value: signed(s.dist), sub: `200-day ${money(s.sma200)}`,
    },
    {
      key: 'rising', ok: c.rising, label: '200-day rising',
      value: s.slope200 == null ? '—' : `${s.slope200 >= 0 ? '+' : '−'}${money(Math.abs(s.slope200))}`, sub: 'over 20 days',
    },
    {
      key: 'trend', ok: c.trend, label: '50-day above 200-day',
      value: money(s.sma50), sub: s.sma50 && s.sma200 ? `${signed((s.sma50 / s.sma200 - 1) * 100)} vs 200` : '',
    },
    {
      key: 'rsi', ok: c.rsi, label: `RSI dipped below ${params.rsiLevel}, now rising`,
      value: s.rsi == null ? '—' : `${s.rsiPrev?.toFixed(1) ?? '—'} → ${s.rsi.toFixed(1)}`,
      sub: Number.isFinite(s.rsiMinLookback) ? `low ${s.rsiMinLookback.toFixed(1)} in ${params.lookback}d` : '',
    },
    {
      key: 'iv', ok: c.iv, label: `IV Rank below ${params.ivRankMax}`,
      value: s.ivRank == null ? '—' : s.ivRank.toFixed(0),
      sub: model.ivSource === 'iv' ? (s.iv ? `IV ${(s.iv * 100).toFixed(1)}%` : '') : 'HV rank stand-in',
    },
  ]
  return (
    <section className={clsx('relative rounded-2xl border mb-4 overflow-hidden',
      yes ? 'border-green-400/40 bg-card' : 'border-border bg-card')}>
      {yes && <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-green-400/12 to-transparent pointer-events-none" aria-hidden />}
      <div className="relative px-5 pt-5 pb-4 flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <div className="text-[11px] uppercase tracking-[0.14em] text-muted font-semibold">Buy zone · {day(s.t)}</div>
          <div className={clsx('mt-1 text-3xl font-bold tracking-tight', yes ? 'text-green-400' : 'text-fg')}>
            {yes ? 'YES' : 'NO'}
          </div>
          <div className="text-xs text-subtle mt-0.5">
            {yes ? 'Every condition is met today.' : `${met} of 5 conditions met.`}
            {lastTrade && !yes && <span className="text-muted"> Last signal {day(lastTrade.t)}.</span>}
          </div>
          {!yes && s.sma200 && (
            <div className="text-xs mt-1.5 text-subtle">
              Entry price zone <span className="font-mono-tab text-fg">{money(s.sma200 * (1 - params.bandPct / 100))}–{money(s.sma200 * (1 + params.bandPct / 100))}</span>
            </div>
          )}
        </div>
        <Meter met={met} yes={yes} />
      </div>
      <ul className="relative border-t border-hairline divide-y divide-hairline">
        {rows.map((r) => (
          <li key={r.label} className="px-5 py-2.5 flex items-center gap-3 min-h-[52px]">
            <span className={clsx('shrink-0 h-6 w-6 rounded-full flex items-center justify-center',
              r.ok ? 'bg-green-400/15 text-green-400' : 'bg-red-400/12 text-rose-300')}
              aria-label={r.ok ? 'Met' : 'Not met'}>
              {r.ok ? <Check size={14} strokeWidth={3} /> : <X size={13} strokeWidth={3} />}
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-sm text-fg leading-snug">
                {r.label}
                {!r.ok && gaps[r.key]?.need && (
                  <button type="button" onClick={() => toggle(r.key)}
                    aria-expanded={shown.has(r.key)} aria-label="What it needs"
                    className="inline-flex align-middle -my-3 ml-0.5 p-3 -mr-3 text-amber-300 hover:text-amber-200">
                    <Info size={15} strokeWidth={2.25} />
                  </button>
                )}
              </span>
              {!r.ok && shown.has(r.key) && gaps[r.key]?.need && <span className="block text-xs text-amber-300/90 mt-0.5 leading-snug">{gaps[r.key].need}</span>}
            </span>
            <span className="text-right shrink-0">
              <span className="block text-sm font-mono-tab text-fg">{r.value}</span>
              {r.sub && <span className="block text-[11px] text-muted font-mono-tab">{r.sub}</span>}
            </span>
          </li>
        ))}
        <li className="px-5 py-2.5 flex items-center gap-3 min-h-[48px]">
          <span className={clsx('shrink-0 h-6 w-6 rounded-full flex items-center justify-center border border-dashed',
            macdAgo != null && macdAgo <= params.macdWindow ? 'border-green-400/60 text-green-400' : 'border-border text-muted')} aria-hidden>
            {macdAgo != null && macdAgo <= params.macdWindow ? <Check size={12} strokeWidth={3} /> : <span className="text-[10px]">—</span>}
          </span>
          <span className="flex-1 min-w-0 text-sm text-subtle leading-snug">
            MACD confirmation <span className="text-muted">(optional)</span>
          </span>
          <span className="text-right shrink-0 text-[11px] text-muted font-mono-tab">
            {macdAgo == null ? 'no cross' : macdAgo === 0 ? 'crossed up today' : `crossed up ${macdAgo}d ago`}
          </span>
        </li>
        {suite && FEATURES.hardening && (
          <li className="px-5 py-2.5 flex items-center gap-3 min-h-[48px]">
            <span className={clsx('shrink-0 h-6 w-6 rounded-full flex items-center justify-center border border-dashed',
              hOk ? 'border-amber-400/60 text-amber-300' : 'border-border text-muted')} aria-hidden>
              {hOk ? <Check size={12} strokeWidth={3} /> : <span className="text-[10px]">—</span>}
            </span>
            <span className="flex-1 min-w-0 text-sm text-subtle leading-snug">
              Hardening confirmation <span className="text-muted">({tfLabel}, optional)</span>
            </span>
            <span className="text-right shrink-0 text-[11px] text-muted font-mono-tab">
              {!hBull ? 'no bull signal' : hOk ? `${'★'.repeat(hBull.stars)} ${hAgo === 0 ? 'today' : `${hAgo}d ago`}` : `none in ${confirmDays}d`}
            </span>
          </li>
        )}
      </ul>
    </section>
  )
}

// Five-segment meter of conditions met.
function Meter({ met, yes }) {
  return (
    <div className="flex items-end gap-1 h-10" aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} className={clsx('w-2 rounded-full transition-colors',
          i < met ? (yes ? 'bg-green-400' : 'bg-amber-400') : 'bg-faint')}
          style={{ height: `${40 + i * 15}%` }} />
      ))}
    </div>
  )
}

function Thresholds({ draft, setField, reset, isDefault }) {
  return (
    <section className="bg-card border border-border rounded-2xl mb-4 p-5">
      <div className="flex items-center mb-3">
        <h2 className="flex-1 text-sm font-semibold">Thresholds</h2>
        {!isDefault && (
          <button type="button" onClick={reset}
            className="min-h-[36px] -mr-2 px-2 inline-flex items-center gap-1.5 rounded-lg text-xs text-subtle hover:text-fg">
            <RotateCcw size={12} aria-hidden /> Reset
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-1 gap-3">
        {FIELDS.map(([k, label, min, max, decimals, suffix]) => {
          const n = Number(draft[k])
          const bad = draft[k] === '' || !Number.isFinite(n) || n < min || n > max
          return (
            <label key={k} className="block">
              <span className="block text-[11px] text-muted mb-1">{label}</span>
              <span className={clsx('flex items-center rounded-xl bg-bg-elev border px-3 min-h-[44px] focus-within:border-amber-400/60 transition',
                bad ? 'border-red-400/50' : 'border-border')}>
                <NumberInput value={draft[k]} onChange={(v) => setField(k, v)} decimals={decimals}
                  className="flex-1 min-w-0 bg-transparent outline-none text-sm font-mono-tab text-fg" aria-label={label} />
                {suffix && <span className="text-[11px] text-muted ml-1.5">{suffix}</span>}
              </span>
            </label>
          )
        })}
      </div>
    </section>
  )
}

const BACKTEST_TABS = FEATURES.hardening
  ? [['zone', 'Buy zone'], ['hardening', 'Hardening ▲'], ['sell', 'Sell signals']]
  : [['zone', 'Buy zone'], ['bravo', 'Bravo ◆'], ['sell', 'Sell signals']]
const ROWS_SHOWN = 30

function Backtest({ model, suite, pack, confirmDays, onJumpDay, onJumpPeriod }) {
  const [tab, setTab] = useState('zone')
  const [all, setAll] = useState(false)
  const view = useMemo(() => {
    if (tab === 'zone' || !pack) {
      const hNear = (i) => (FEATURES.hardening ? suite?.bulls.find((b) => b.i >= 0 && Math.abs(b.i - i) <= confirmDays) ?? null : null)
      const trades = model.trades.map((tr) => {
        const h = hNear(tr.i)
        return { ...tr, hardening: !!h, tag: [tr.confirmed && 'MACD', h && `Hardening ${'★'.repeat(h.stars)}`].filter(Boolean).join(' · ') }
      })
      const split = suite && FEATURES.hardening ? [
        { label: 'With', stats: horizonStats(trades.filter((x) => x.hardening), HORIZONS), n: trades.filter((x) => x.hardening).length },
        { label: 'Without', stats: horizonStats(trades.filter((x) => !x.hardening), HORIZONS), n: trades.filter((x) => !x.hardening).length },
      ] : null
      return {
        trades, stats: model.stats, sell: false, split,
        sub: `${model.trades.length} trade${model.trades.length === 1 ? '' : 's'} in 5 years (${model.signals.length} signal days)`,
        empty: 'No buy-zone signals in this history with these thresholds.',
      }
    }
    // Hardening / sell signals: the suite's own weekly or monthly bars over
    // the ticker's whole history; returns after 13 / 26 / 52 weeks (3 / 6 /
    // 12 months). Rows on the daily chart jump to their close day.
    const { raw, periods, info } = pack
    const closes = periods.map((x) => x.c)
    const since = periods[0]?.t?.slice(0, 4)
    const periodLabel = (t) => (pack.tf === '1d' ? shortDay(t) : pack.tf === '1mo'
      ? new Date(`${t}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }).replace(' ', ' ’')
      : `Wk ${shortDay(t)}`)
    const place = (list) => forwardReturns(closes, list, info.horizons).map((tr) => ({ ...tr, t: periods[tr.i].t, period: true }))
    // Bravo bull diamonds (the same events as on the chart).
    const flagged = (flags, extra) => flags.map((f, i) => (f ? { i, price: periods[i].c, ...extra } : null)).filter(Boolean)
    if (tab === 'bravo') {
      const trades = place(flagged(raw.bravo.bullOn, { tag: 'Bravo bull' }))
      return {
        trades, stats: horizonStats(trades, info.horizons), sell: false, dateFmt: periodLabel,
        sub: `${trades.length} ${info.label.toLowerCase()} Bravo bull diamond${trades.length === 1 ? '' : 's'} since ${since}`,
        empty: `No ${info.label.toLowerCase()} Bravo bull diamonds since ${since}.`,
      }
    }
    if (tab === 'hardening') {
      const trades = place(raw.bulls).map((tr) => ({ ...tr, tag: '★'.repeat(tr.stars) }))
      // Bull sets that lined up but failed a gate, by gate.
      const missed = raw.candidates.filter((c) => c.side === 'bull' && !Object.values(c.gates).every(Boolean))
      const byGate = {}
      for (const c of missed) for (const [g, ok] of Object.entries(c.gates)) if (!ok) byGate[g] = (byGate[g] ?? 0) + 1
      const GATE = { volume: 'volume', regime: 'trend', velocity: 'Echo speed', atr: 'ATR expansion', vix: 'VIX' }
      const near = missed.length ? ` · ${missed.length} more lined up but failed ${Object.entries(byGate).map(([g, k]) => `${GATE[g]} ×${k}`).join(', ')}` : ''
      return {
        trades, stats: horizonStats(trades, info.horizons), sell: false, dateFmt: periodLabel,
        sub: `${trades.length} ${info.label.toLowerCase()} Hardening bull signal${trades.length === 1 ? '' : 's'} since ${since}${near}`,
        empty: `No ${info.label.toLowerCase()} Hardening bull signals since ${since}.`,
      }
    }
    const bravoBears = flagged(raw.bravo.bearOn, { tag: 'Bravo bear' })
    const events = [
      ...(FEATURES.hardening ? raw.bears.map((x) => ({ ...x, tag: `${'★'.repeat(x.stars)} bear` })) : bravoBears),
      ...raw.exits.map((x) => ({ ...x, tag: `Exit ${x.why.join('')}` })),
    ].sort((a, b) => a.i - b.i)
    const trades = place(events)
    return {
      trades, stats: horizonStats(trades, info.horizons, (r) => r < 0), sell: true, dateFmt: periodLabel,
      sub: `${FEATURES.hardening ? `${raw.bears.length} Hardening bear` : `${bravoBears.length} Bravo bear`} + ${raw.exits.length} exit signals (${info.label.toLowerCase()}) since ${since} · a win = the stock fell after`,
      empty: `No ${info.label.toLowerCase()} sell signals since ${since}.`,
    }
  }, [tab, model, suite, pack, confirmDays])
  // Every row jumps the chart to its bar (daily rows map to their week /
  // month when the chart shows weekly / monthly candles).
  const rowJump = (tr) => {
    const go = () => (tr.period ? onJumpPeriod?.(tr.i) : onJumpDay?.(tr.i))
    return {
      onClick: go, role: 'button', tabIndex: 0, 'aria-label': `Show ${shortDay(tr.t)} on the chart`,
      onKeyDown: (e) => { if (e.key === 'Enter') go() }, className: 'cursor-pointer hover:bg-card-hover/50 transition',
    }
  }
  const rows = [...view.trades].reverse()
  const visible = all ? rows : rows.slice(0, ROWS_SHOWN)
  return (
    <section className="bg-card border border-border rounded-2xl mb-4 overflow-hidden">
      <div className="px-5 pt-5 pb-3">
        <div className="flex items-center gap-3">
          <h2 className="flex-1 text-sm font-semibold">Backtest</h2>
        </div>
        <div className="mt-3 flex gap-1 p-1 rounded-xl bg-bg-elev" role="tablist" aria-label="Signal">
          {BACKTEST_TABS.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => { setTab(k); setAll(false) }}
              className={clsx('flex-1 min-h-[36px] rounded-lg text-xs font-semibold transition',
                tab === k ? 'bg-card text-fg shadow-sm' : 'text-muted hover:text-subtle')}>
              {label}
            </button>
          ))}
        </div>
        <div className="text-xs text-muted mt-2.5">{view.sub} · stock return, not option return</div>
      </div>
      <div className="px-5 pb-4 grid grid-cols-3 gap-2">
        {view.stats.map((st) => (
          <div key={st.label} className="rounded-xl bg-bg-elev px-3 py-3">
            <div className="text-[11px] text-muted font-semibold">{st.label}</div>
            <div className={clsx('mt-1 text-lg font-semibold font-mono-tab leading-none',
              st.avg == null ? 'text-muted' : st.avg < 0 ? 'text-rose-300' : 'text-green-400')}>
              {st.avg == null ? '—' : signed(st.avg * 100)}
            </div>
            <div className="text-[11px] text-muted mt-1">avg return</div>
            <div className="mt-2 h-1 rounded-full bg-faint overflow-hidden" aria-hidden>
              <div className={clsx('h-full', view.sell ? 'bg-red-400' : 'bg-green-400')} style={{ width: `${(st.winRate ?? 0) * 100}%` }} />
            </div>
            <div className="text-[11px] mt-1 font-mono-tab">
              <span className="text-fg">{st.winRate == null ? '—' : `${Math.round(st.winRate * 100)}%`}</span>
              <span className="text-muted"> {view.sell ? 'fell' : 'win'} · {st.n}</span>
            </div>
          </div>
        ))}
      </div>
      {view.split && rows.length > 0 && (
        <div className="px-5 pb-4 -mt-1">
          <table className="w-full text-xs font-mono-tab rounded-xl overflow-hidden border border-hairline border-separate border-spacing-0">
            <thead>
              <tr className="text-[11px] text-muted bg-bg-elev/60">
                <th className="text-left font-semibold font-sans px-3 py-2">Hardening</th>
                <th className="text-right font-semibold px-2 py-2">Trades</th>
                {HORIZONS.map(([l]) => <th key={l} className="text-right font-semibold px-2 py-2 last:pr-3">{l}</th>)}
              </tr>
            </thead>
            <tbody>
              {view.split.map((g) => (
                <tr key={g.label}>
                  <td className="font-sans text-subtle px-3 py-2 border-t border-hairline whitespace-nowrap">{g.label}</td>
                  <td className="text-right text-subtle px-2 py-2 border-t border-hairline">{g.n}</td>
                  {g.stats.map((st) => (
                    <td key={st.label} className={clsx('text-right px-2 py-2 border-t border-hairline last:pr-3 whitespace-nowrap',
                      st.avg == null ? 'text-muted' : st.avg < 0 ? 'text-rose-300' : 'text-green-400')}>
                      {st.avg == null ? '—' : signed(st.avg * 100)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length === 0 ? (
        <div className="px-5 pb-5 text-sm text-subtle">{view.empty}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono-tab">
            <thead>
              <tr className="text-muted text-[11px] border-y border-hairline">
                <th className="text-left font-semibold pl-5 pr-1 py-2">Date</th>
                <th className="text-right font-semibold px-1.5 py-2">{view.sell ? 'Price' : 'Entry'}</th>
                {HORIZONS.map(([label]) => <th key={label} className="text-right font-semibold px-1.5 py-2 last:pr-5">{label}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {visible.map((tr) => (
                <tr key={`${tr.t}-${tr.tag}`} {...rowJump(tr)}>
                  <td className="pl-5 pr-1 py-2.5 text-fg whitespace-nowrap">
                    {view.dateFmt ? view.dateFmt(tr.t) : shortDay(tr.t)}
                    {tr.tag && <span className={clsx('block text-[11px] leading-4 mt-0.5',
                      view.sell ? 'text-rose-300/80' : tab === 'hardening' ? 'text-amber-300' : tab === 'bravo' ? 'text-suite-bull' : 'text-green-400/70')}>{tr.tag}</span>}
                  </td>
                  <td className="px-1.5 py-2.5 text-right text-subtle">{money(tr.price)}</td>
                  {tr.returns.map((r, h) => (
                    <td key={h} className={clsx('px-1.5 py-2.5 text-right whitespace-nowrap last:pr-5',
                      r == null ? 'text-muted' : r < 0 ? 'text-rose-300' : 'text-green-400')}>
                      {r == null ? 'open' : signed(ret(r))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > ROWS_SHOWN && (
            <button type="button" onClick={() => setAll((v) => !v)}
              className="w-full min-h-[44px] border-t border-hairline text-xs font-semibold text-subtle hover:text-fg">
              {all ? 'Show fewer' : `Show all ${rows.length}`}
            </button>
          )}
        </div>
      )}
    </section>
  )
}

// Signal suite today: Entry (latest Bravo bull diamond — or Hardening bull
// when FEATURES.hardening) and Sell (fresh Bravo bear / Hardening bear, else
// fresh exit, else the latest) tiles — tap to see it on the chart —
// then one row per pillar (Echo / Tango open their pane full screen; Bravo
// turns its band on), then the user's positions in this ticker.
function SuitePanel({ pack, failed, tf, onTf, holdings, onJump, onOpenPane, onBravo, bravoOn }) {
  const header = (
    <div className="px-5 pt-5 pb-4 flex items-center gap-3">
      <h2 className="flex-1 text-sm font-semibold">Signal suite</h2>
      <div className="flex gap-0.5 p-0.5 rounded-lg bg-bg-elev" role="tablist" aria-label="Suite timeframe">
        {Object.entries(SUITE_TIMEFRAMES).map(([k, v]) => (
          <button key={k} type="button" role="tab" aria-selected={tf === k} onClick={() => onTf(k)}
            className={clsx('min-h-[32px] px-3 rounded-md text-[11px] font-semibold transition',
              tf === k ? 'bg-card text-violet-300 shadow-sm' : 'text-muted hover:text-subtle')}>
            {v.label}
          </button>
        ))}
      </div>
    </div>
  )
  if (!pack) {
    return (
      <section className="bg-card border border-border rounded-2xl mb-4 overflow-hidden">
        {header}
        {failed
          ? <div className="px-5 pb-5 text-sm text-subtle">Couldn't load {SUITE_TIMEFRAMES[tf].label.toLowerCase()} bars for this ticker.</div>
          : <div className="px-5 pb-5 grid grid-cols-2 gap-2.5" aria-busy="true">
              <div className="h-[116px] rounded-xl bg-bg-elev animate-pulse" /><div className="h-[116px] rounded-xl bg-bg-elev animate-pulse" />
            </div>}
      </section>
    )
  }
  const { raw, info, days: suite } = pack
  const lastP = pack.periods.length - 1
  const ago = (pi) => (pi == null ? null : lastP - pi)
  const agoText = (n) => (n === 0 ? `this ${info.unit}` : n === 1 ? `last ${info.unit}` : `${n} ${info.unit}s ago`)
  const lastOf = (list) => list[list.length - 1] ?? null
  // Entry / Sell: Hardening when it's on; otherwise the Bravo diamonds
  // (with exits for Sell) — the same events drawn on the chart.
  const diamonds = (flags, side) => flags.map((f, pi) => (f ? { pi, i: suite.closeDays[pi] ?? -1, price: pack.periods[pi].c, side, stars: null } : null)).filter(Boolean)
  const bull = lastOf(FEATURES.hardening ? suite.bulls : diamonds(raw.bravo.bullOn, 'bull'))
  const bear = lastOf(FEATURES.hardening ? suite.bears : diamonds(raw.bravo.bearOn, 'bear'))
  const exit = lastOf(suite.exits)
  const fresh = (e) => e && ago(e.pi) <= info.fresh
  const bullFresh = fresh(bull)
  const bearFresh = fresh(bear)
  const exitFresh = fresh(exit)
  const sell = bearFresh ? { kind: 'bear', e: bear } : exitFresh ? { kind: 'exit', e: exit }
    : bear && (!exit || bear.pi >= exit.pi) ? { kind: 'bear', e: bear } : exit ? { kind: 'exit', e: exit } : null
  const WHY = { E: 'Echo turned down', T: 'Tango turned down', B: 'Bravo trend flipped' }
  // Tiles jump to their period (the chart draws the suite's own bars).
  const jumpable = (e) => (e && e.pi >= 0 ? () => onJump(e.pi) : null)
  const regime = raw.bravo.regime[lastP]
  const lastFlag = (flags) => { for (let i = flags.length - 1; i >= 0; i--) if (flags[i]) return i; return null }
  const pillar = (o) => {
    const v = o.line[lastP]
    const zone = v == null ? null : v >= o.upper[lastP] ? 'Above rail' : v <= o.lower[lastP] ? 'Below rail' : 'Mid-range'
    const b = lastFlag(o.bull)
    const sx = lastFlag(o.bear)
    const latest = b != null && (sx == null || b > sx) ? { side: 'Bull', n: ago(b) } : sx != null ? { side: 'Bear', n: ago(sx) } : null
    return { v, zone, latest }
  }
  const echo = pillar(raw.echo)
  const tango = pillar(raw.tango)
  const bravoB = lastFlag(raw.bravo.bull)
  const bravoS = lastFlag(raw.bravo.bear)
  const bravoLatest = bravoB != null && (bravoS == null || bravoB > bravoS) ? { side: 'Bull', n: ago(bravoB) } : bravoS != null ? { side: 'Bear', n: ago(bravoS) } : null
  const tone = (side) => (side === 'Bull' ? 'up' : side === 'Bear' ? 'down' : 'flat')
  const since = pack.periods[0]?.t?.slice(0, 4)
  // Short ages for the pillar rows: "now", "3w ago", "2mo ago".
  const short = info.unit === 'day' ? 'd' : info.unit === 'week' ? 'w' : 'mo'
  const agoShort = (n) => (n === 0 ? 'now' : `${n}${short} ago`)
  return (
    <section className="bg-card border border-border rounded-2xl mb-4 overflow-hidden">
      {header}
      <div className="px-5 pb-5 grid grid-cols-2 gap-2.5">
        <SignalTile tone={bullFresh ? 'buy' : 'idle'} icon={ArrowUp} label="Entry"
          onClick={jumpable(bull)}
          title={bull ? (FEATURES.hardening ? 'Hardening bull' : 'Bravo bull') : 'No bull signal'}
          stars={bull?.stars}
          sub={bull ? `${agoText(ago(bull.pi))} · $${bull.price.toFixed(2)}` : `None since ${since}`} />
        <SignalTile tone={!sell ? 'idle' : sell.kind === 'bear' && bearFresh ? 'sell' : exitFresh && sell.kind === 'exit' ? 'trim' : 'idle'} icon={ArrowDown} label="Sell"
          onClick={jumpable(sell?.e)}
          title={!sell ? 'No sell signal' : sell.kind === 'bear' ? (FEATURES.hardening ? 'Hardening bear' : 'Bravo bear') : 'Exit signal'}
          stars={sell?.kind === 'bear' ? sell.e.stars : null}
          sub={!sell ? `None since ${since}` : sell.kind === 'bear' ? `${agoText(ago(sell.e.pi))} · $${sell.e.price.toFixed(2)}`
            : `${agoText(ago(sell.e.pi))} · ${sell.e.why.map((w) => WHY[w]).join(', ')}`} />
      </div>
      <ul className="border-t border-hairline divide-y divide-hairline">
        <PillarRow name="Bravo" what="Trend" onClick={onBravo} action={bravoOn ? 'On chart' : 'Show band'}
          value={regime === 1 ? 'Bull trend' : regime === -1 ? 'Bear trend' : 'No trend'} valueTone={regime === 1 ? 'up' : regime === -1 ? 'down' : 'flat'}
          chip={regime === 1 ? 'Above basis' : regime === -1 ? 'Below basis' : 'Mixed'}
          latest={bravoLatest && `${bravoLatest.side} ${agoShort(bravoLatest.n)}`} latestTone={tone(bravoLatest?.side)} />
        <PillarRow name="Echo" what="Momentum" onClick={() => onOpenPane('echo')} action="Open" expand
          value={echo.v == null ? '—' : echo.v.toFixed(1)} mono valueTone={echo.v == null ? 'flat' : echo.v >= 0 ? 'up' : 'down'} chip={echo.zone}
          latest={echo.latest && `${echo.latest.side} ${agoShort(echo.latest.n)}`} latestTone={tone(echo.latest?.side)} />
        <PillarRow name="Tango" what="Money flow" onClick={() => onOpenPane('tango')} action="Open" expand
          value={tango.v == null ? '—' : tango.v.toFixed(1)} mono valueTone={tango.v == null ? 'flat' : tango.v >= 0 ? 'up' : 'down'} chip={tango.zone}
          latest={tango.latest && `${tango.latest.side} ${agoShort(tango.latest.n)}`} latestTone={tone(tango.latest?.side)} />
      </ul>
      {holdings?.length > 0 && (
        <ul className="border-t border-hairline divide-y divide-hairline">
          {holdings.map((h) => (
            <li key={h.id}>
              <Link to={`/leaps?open=${h.id}`} className="px-5 py-3 flex items-center gap-3 min-h-[56px] hover:bg-card-hover/40 transition">
                <span className={clsx('shrink-0 text-[10px] uppercase tracking-wider font-semibold px-2 py-1 rounded-md border',
                  h.kind === 'shares' ? 'text-amber-300 border-amber-400/40 bg-amber-400/10' : 'text-subtle border-border bg-bg-elev')}>
                  {h.kind === 'shares' ? 'Shares' : 'LEAPS'}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm text-fg">You {h.kind === 'shares' ? 'own' : 'hold'} <span className="font-mono-tab">{h.qty}</span></span>
                  <span className="block text-xs text-muted mt-0.5">{h.kind === 'shares' ? 'The sell signals apply to these shares.' : 'Your exit plan decides; these signals are for shares and spreads.'}</span>
                </span>
                <ChevronRight size={15} className="shrink-0 text-muted" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

const TILE_TONE = {
  buy: { box: 'border-amber-400/40 bg-amber-400/[0.06]', label: 'text-amber-300', icon: 'bg-amber-400/15 text-amber-300' },
  sell: { box: 'border-red-400/40 bg-red-400/[0.07]', label: 'text-rose-300', icon: 'bg-red-400/15 text-rose-300' },
  trim: { box: 'border-red-400/25 bg-red-400/[0.04]', label: 'text-rose-300', icon: 'bg-red-400/12 text-rose-300' },
  idle: { box: 'border-hairline bg-bg-elev', label: 'text-muted', icon: 'bg-faint text-subtle' },
}
function SignalTile({ tone, icon: Icon, label, title, stars, sub, onClick }) {
  const c = TILE_TONE[tone]
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag type={onClick ? 'button' : undefined} onClick={onClick ?? undefined}
      className={clsx('text-left rounded-xl border p-3.5 min-w-0 min-h-[116px] flex flex-col transition', c.box,
        onClick && 'hover:border-border-hover active:scale-[0.99]')}>
      <span className="flex items-center gap-2">
        <span className={clsx('h-6 w-6 rounded-full flex items-center justify-center shrink-0', c.icon)} aria-hidden><Icon size={13} strokeWidth={2.5} /></span>
        <span className={clsx('text-[11px] uppercase tracking-[0.12em] font-semibold', c.label)}>{label}</span>
      </span>
      <span className="mt-3 text-base font-semibold text-fg leading-tight">{title}</span>
      {stars ? <span className="mt-0.5 text-xs text-amber-300 tracking-wider" aria-label={`${stars} stars`}>{'★'.repeat(stars)}<span className="text-faint">{'★'.repeat(4 - stars)}</span></span> : null}
      <span className="mt-1 text-xs text-muted leading-4">{sub}</span>
      {onClick && <span className="mt-auto pt-2 text-[11px] font-semibold text-subtle inline-flex items-center gap-0.5">View on chart <ChevronRight size={12} aria-hidden /></span>}
    </Tag>
  )
}

const TONE_TEXT = { up: 'text-green-400', down: 'text-rose-300', flat: 'text-subtle' }
// Two aligned lines per row: name · value · latest signal on top, the role ·
// state chip · action below — every column shares the same two baselines.
function PillarRow({ name, what, value, valueTone, mono, chip, latest, latestTone, onClick, action, expand }) {
  return (
    <li>
      <button type="button" onClick={onClick}
        className="w-full text-left px-5 py-3 grid grid-cols-[8px_84px_minmax(0,1fr)_auto] items-start gap-x-3 hover:bg-card-hover/40 transition">
        <span className={clsx('mt-[7px] h-2 w-2 rounded-full', valueTone === 'up' ? 'bg-green-400' : valueTone === 'down' ? 'bg-red-400' : 'bg-faint')} aria-hidden />
        <span className="min-w-0">
          <span className="block h-5 text-sm leading-5 text-fg font-medium truncate">{name}</span>
          <span className="block h-4 mt-1 text-[11px] leading-4 text-muted truncate">{what}</span>
        </span>
        <span className="min-w-0">
          <span className={clsx('block h-5 text-sm leading-5 font-semibold truncate', mono && 'font-mono-tab', TONE_TEXT[valueTone])}>{value}</span>
          <span className="block h-4 mt-1">
            {chip && <span className="inline-block max-w-full truncate whitespace-nowrap align-top text-[11px] leading-4 font-medium px-1.5 rounded bg-bg-elev text-subtle">{chip}</span>}
          </span>
        </span>
        <span className="text-right">
          <span className={clsx('block h-5 text-xs leading-5 font-mono-tab whitespace-nowrap', TONE_TEXT[latestTone])}>{latest ?? ''}</span>
          <span className="flex h-4 mt-1 items-center justify-end gap-1 text-[11px] leading-4 text-violet-300 font-semibold whitespace-nowrap">
            {expand ? <Maximize2 size={11} aria-hidden /> : null}{action}{!expand && <ChevronRight size={12} aria-hidden />}
          </span>
        </span>
      </button>
    </li>
  )
}
