import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useHoldings, isQuantity } from '../hooks/useHoldings'
import { todayYmd } from '../utils/afterTax'
import { dailyDecisions, exitRows } from '../lib/holdingChecks'
import { ChartLine, ChevronLeft, ChevronRight, Crosshair, Maximize2, Minimize2, Search, Sparkles, X } from 'lucide-react'
import TickerDrawer from '../components/TickerDrawer'
import { CHART_TICKERS } from '../lib/chartTickers'
import PriceChart from '../components/PriceChart'
import ConfluenceLeaders from '../components/ConfluenceLeaders'
import MomentumList from '../components/MomentumList'
import { placePins, measure, fibLevels, autoSwing, stepPin } from '../utils/chartTools'

// Charts — the stocks where the app suggests a LEAPS trade, with the trade
// drawn on the price chart. (GEX spread plays live on Pulse.)
//   LEAPS ideas   — buys from the suggest-leaps edge function (the LDP
//                   core sleeve: top-ranked sector ETFs and the call that
//                   clears the engine's contract rules), plus LEAPS bot
//                   suggestions from ldp_audit_log (last 30 days).
//   Your holdings — today's sell / roll / exit calls from your exit plan
//                   (same checks as Home and the bot view).
// Prices come from the price-history edge function (Polygon daily bars,
// Yahoo fallback). Holding charts are hidden for now; their history
// (leaps_position_marks) keeps collecting.

const RANGES = [['1d', '1D'], ['5d', '1W'], ['1mo', '1M'], ['3mo', '3M'], ['6mo', '6M'], ['1y', '1Y'], ['2y', '2Y'], ['5y', '5Y'], ['max', 'All']]
const DAY_MS = 86400000
const BOT_DAYS = 30
const price = (n) => (Number.isFinite(n)
  ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: n < 10 ? 4 : 2 })}`
  : '—')
const shortDate = (ymd) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
// Daily bars carry a date; intraday bars carry ET wall-clock seconds (read as UTC).
const dayLabel = (t) => (typeof t === 'number'
  ? new Date(t * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })
  : new Date(`${t}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }))
const num = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—')
const TOOLS_KEY = (ticker) => `cm:chart-tools:${ticker}`
// "54 trading days · 78 days" / "12 candles" between the pins.
// The span between the pins: main line + an optional calendar-days line.
function spanLabel(m, range) {
  if (range === '1d' || range === '5d') return { main: `${m.candles} candle${m.candles === 1 ? '' : 's'}`, sub: null }
  const unit = range === '5y' ? 'week' : range === 'max' ? 'month' : 'trading day'
  return {
    main: `${m.candles.toLocaleString('en-US')} ${unit}${m.candles === 1 ? '' : 's'}`,
    sub: unit === 'trading day' ? `${m.days.toLocaleString('en-US')} calendar days` : null,
  }
}
// A pin's date: with the year for daily candles, with the time intraday.
const pinDate = (t) => (typeof t === 'number' ? dayLabel(t) : shortDate(t))
const compact = (n) => Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
const pctSigned = (r) => (Number.isFinite(r) ? `${r >= 0 ? '+' : '−'}${Math.abs(r * 100).toFixed(1)}%` : '—')
const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`

// OCC option symbol ("XLK   280121C00250000" or without padding).
function parseOcc(sym) {
  const m = /^([A-Z.]+)\s*(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(String(sym ?? '').trim())
  if (!m) return null
  return { root: m[1], expiration: `20${m[2]}-${m[3]}-${m[4]}`, type: m[5], strike: Number(m[6]) / 1000 }
}

// Price levels for a holding's suggestion: the option's strike and
// break-even, or the cost and the target's price per share / coin.
function holdingLevels(r, decision) {
  const { pos, calc } = r
  const lines = []
  if (isQuantity(pos.instrument_type)) {
    const units = Number(pos.shares)
    if (units > 0) {
      lines.push({ v: Number(pos.cost_basis) / units, label: 'Your cost' })
      const rows = exitRows(r)
      const row = decision.kind === 'sell' ? rows.find((x) => x.hit && x.contracts !== 0) : rows.find((x) => !x.hit && x.contracts !== 0)
      if (row) lines.push({ v: row.exit_value / units, label: `${Math.round(row.gain_pct * 100)}% gain`, gold: true })
    }
  } else if (Number(pos.strike) > 0) {
    const strike = Number(pos.strike)
    const perShare = Number(pos.cost_basis) / ((Number(pos.contracts) || 1) * 100)
    lines.push({ v: strike, label: 'Strike', gold: true })
    lines.push({ v: pos.option_type === 'P' ? strike - perShare : strike + perShare, label: 'Break-even' })
  }
  return { lines, calc }
}


// Full screen renders through a portal on <body>. The page scrolls inside
// <main class="overflow-y-auto">; on iOS a position: fixed layer inside a
// scrolled overflow container has its touches read as scrolls of that
// container and its hit-testing offset (owner, 2026-10-05: no pan, no
// pinch, the close unreachable). Outside <main> it behaves.
function Portalled({ when, children }) {
  return when ? createPortal(children, document.body) : children
}

const CHART_TABS = [['momentum', 'Momentum'], ['pullbacks', 'Pullbacks'], ['charts', 'Ideas & holdings']]

export default function Charts() {
  const { user } = useAuth()
  const { federal, profile, positions, plan, ready, results } = useHoldings()
  const [botRows, setBotRows] = useState(null)
  const [ideas, setIdeas] = useState(undefined)
  // The index call's record from the pre-registered test (index_call_record()).
  const [indexRecord, setIndexRecord] = useState(null)
  const [selected, setSelected] = useState(null)
  // Tabs at the top (owner, 2026-10-07: "so the user doesn't have to scroll
  // for eternity"): Momentum · Pullbacks · Ideas & holdings, remembered here.
  const [tab, setTabState] = useState(() => { try { const t = localStorage.getItem('cm:charts-tab'); return CHART_TABS.some(([k]) => k === t) ? t : 'momentum' } catch { return 'momentum' } })
  const setTab = (t) => { setTabState(t); try { localStorage.setItem('cm:charts-tab', t) } catch { /* storage off */ } }
  const [range, setRange] = useState('6mo')
  const [bars, setBars] = useState({})
  const [hover, setHover] = useState(null)
  // Drawing tools, per ticker, saved on this device: two Measure pins and
  // whether Fib levels are on. `picking` = the next tap drops a pin.
  const [tools, setTools] = useState({ ticker: null, pins: [], fib: false })
  const [picking, setPicking] = useState(false)
  // Full screen chart (the maximize button by the OHLC line; Esc or the
  // minimize button closes it).
  const [full, setFull] = useState(false)
  useEffect(() => {
    if (!full) return undefined
    const onKey = (e) => { if (e.key === 'Escape') setFull(false) }
    // The page scrolls inside <main>, not the body: lock that too.
    const scroller = document.querySelector('main')
    const prev = document.body.style.overflow
    const prevMain = scroller?.style.overflow ?? ''
    document.body.style.overflow = 'hidden'
    if (scroller) scroller.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey)
    return () => { document.body.style.overflow = prev; if (scroller) scroller.style.overflow = prevMain; window.removeEventListener('keydown', onKey) }
  }, [full])
  const today = todayYmd()

  useEffect(() => {
    if (!user) return
    let live = true
    const since = new Date(Date.now() - BOT_DAYS * DAY_MS).toISOString()
    supabase.from('ldp_audit_log').select('id, recorded_at, action, ticker, payload')
      .eq('kind', 'suggestion').gte('recorded_at', since).order('recorded_at', { ascending: false }).limit(50)
      .then(({ data, error }) => { if (live) setBotRows(error ? [] : data ?? []) })
    supabase.functions.invoke('suggest-leaps', { body: {} })
      .then(({ data, error }) => { if (live) setIdeas(!error && data?.success ? data : null) })
    supabase.rpc('index_call_record').then(({ data, error }) => { if (live && !error) setIndexRecord(data ?? null) })
    return () => { live = false }
  }, [user])

  // Every suggested trade, as { id, group, ticker, crypto, title, body, verdict, tone, lines, expiration }.
  const items = useMemo(() => {
    const out = []
    // Your holdings: today's sell / roll / exit calls.
    if (ready) {
      const byId = new Map(results.map((r) => [r.pos.id, r]))
      for (const d of dailyDecisions(results, plan, today)) {
        if (d.kind === 'hold' || !d.pos.ticker) continue
        const r = byId.get(d.pos.id)
        const { lines } = holdingLevels(r, d)
        out.push({ id: `h:${d.pos.id}`, posId: d.pos.id, shares: d.pos.instrument_type === 'stock', group: 'holdings', ticker: d.pos.ticker, crypto: d.pos.instrument_type === 'crypto',
          title: d.title, body: d.body, verdict: d.verdict, tone: d.tone, lines, from: 'Your plan' })
      }
    }
    // The index call first (owner, 2026-10-05: in the test, the SPY call
    // bought on the same days as every stock signal beat every single-name
    // rule — the benchmark, made visible). SPY carries the record sentence.
    for (const p of ideas?.index ?? []) {
      const c = p.contract
      const rec = p.ticker === 'SPY' ? indexRecordText(indexRecord) : 'The same plain index call on the Nasdaq-100; the test measured SPY.'
      if (!c) {
        out.push({ id: `x:${p.ticker}`, group: 'ideas', ticker: p.ticker, title: `${p.ticker}: no call fits right now`,
          body: `${rec} ${p.reason[0].toUpperCase()}${p.reason.slice(1)}.`, verdict: 'Index', tone: 'neutral', lines: [], from: 'Index call' })
        continue
      }
      out.push({ id: `x:${p.ticker}`, group: 'ideas', ticker: p.ticker,
        title: `Buy ${p.ticker} ${shortDate(c.expiration)} $${c.strike} call`,
        body: `${rec} Delta ${c.delta.toFixed(2)} · about ${money(c.mid * 100)} per contract (mid)${liveText(c)} · ${c.dte} days to expiry.`,
        verdict: 'Index', tone: 'green', from: 'Index call',
        lines: [{ v: c.strike, label: 'Strike', gold: true }, { v: c.strike + c.mid, label: 'Break-even' }],
        expiration: c.expiration })
    }
    // LEAPS buy ideas: the top-ranked sector ETFs and their calls.
    const total = ideas?.ranked?.length ?? 0
    for (const p of ideas?.picks ?? []) {
      const c = p.contract
      const why = `Ranked #${p.rank} of ${total} sectors · 12m ${pctSigned(p.ret_12m)} vs ${ideas.benchmark} ${pctSigned(p.ret_12m - p.rel_strength)}`
      if (!c) {
        out.push({ id: `i:${p.ticker}`, group: 'ideas', ticker: p.ticker, title: `${p.ticker}: no call fits yet`,
          body: `${why}. ${p.reason[0].toUpperCase()}${p.reason.slice(1)}.`, verdict: 'Watch', tone: 'neutral', lines: [], from: 'LEAPS ideas' })
        continue
      }
      out.push({ id: `i:${p.ticker}`, group: 'ideas', ticker: p.ticker,
        title: `Buy ${p.ticker} ${shortDate(c.expiration)} $${c.strike} call`,
        body: `${why}. Delta ${c.delta.toFixed(2)} · about ${money(c.mid * 100)} per contract (mid)${liveText(c)} · ${c.dte} days to expiry.`,
        verdict: 'Buy', tone: 'green', from: 'LEAPS ideas',
        lines: [{ v: c.strike, label: 'Strike', gold: true }, { v: c.strike + c.mid, label: 'Break-even' }],
        expiration: c.expiration })
    }
    // LEAPS bot suggestions, newest per ticker (skipped where an idea
    // above already covers the ticker).
    const seen = new Set((ideas?.picks ?? []).map((p) => p.ticker))
    for (const row of botRows ?? []) {
      if (seen.has(row.ticker)) continue
      seen.add(row.ticker)
      const occ = parseOcc(row.payload?.contract)
      const lines = occ ? [{ v: occ.strike, label: 'Strike', gold: true }] : []
      const what = occ ? `${shortDate(occ.expiration)} $${occ.strike} ${occ.type === 'C' ? 'call' : 'put'}` : row.payload?.contract ?? ''
      const contracts = row.payload?.sizing?.contracts
      out.push({ id: `b:${row.id}`, group: 'ideas', ticker: row.ticker, title: `${row.action === 'buy' ? 'Buy' : 'Sell'} ${row.ticker} ${what}`.trim(),
        body: row.payload?.thesis ?? row.payload?.reason ?? (contracts ? `${contracts} contracts` : ''),
        verdict: row.action === 'buy' ? 'Buy' : 'Sell', tone: row.action === 'buy' ? 'green' : 'amber', lines,
        expiration: occ?.expiration, from: `LEAPS bot · ${shortDate(row.recorded_at.slice(0, 10))}` })
    }
    // Ideas first: the default chart is the top-ranked buy.
    return [...out.filter((x) => x.group === 'ideas'), ...out.filter((x) => x.group === 'holdings')]
  }, [ready, results, plan, today, botRows, ideas, indexRecord])

  // Holdings are "ready" only once the tax rates load (a moment after
  // positions); wait for that so the first pick doesn't jump.
  const holdingsPending = positions === null || (positions.length > 0 && !!federal && !!profile?.state_code && !ready)
  const loading = holdingsPending || botRows === null || ideas === undefined
  // Search: any ticker gets a chart (and the drawing tools), even with no
  // suggested trade. Recent searches are kept on this device.
  const [searchOpen, setSearchOpen] = useState(false)
  const [watchlist, setWatchlist] = useState([])
  // Tracking + holdings tickers, for the leaders' "Yours" view.
  const myTickers = useMemo(() => [...new Set([...watchlist, ...(positions ?? []).map((x) => x.ticker).filter(Boolean)])].sort(), [watchlist, positions])
  const [recent, setRecent] = useState(() => {
    try { const r = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'); return Array.isArray(r) ? r.slice(0, RECENT_MAX) : [] } catch { return [] }
  })
  useEffect(() => {
    if (!user) return
    supabase.from('watchlist').select('ticker').then(({ data }) => setWatchlist((data ?? []).map((r) => String(r.ticker).toUpperCase())))
  }, [user])
  const saveRecent = (list) => {
    setRecent(list)
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)) } catch { /* this visit only */ }
  }
  const searchItems = useMemo(() => recent.map((sym) => ({
    id: `q:${sym}`, group: 'search', ticker: sym, title: 'No suggested trade', body: '',
    verdict: 'Chart', tone: 'neutral', lines: [], from: 'Search',
  })), [recent])
  const allItems = useMemo(() => [...items, ...searchItems.filter((q) => !items.some((x) => x.ticker === q.ticker))], [items, searchItems])
  const pickTicker = (raw) => {
    const sym = String(raw ?? '').trim().toUpperCase()
    if (!sym) return
    setSearchOpen(false)
    setHover(null)
    setTab('charts')
    const existing = items.find((x) => x.ticker === sym)
    if (existing) { setSelected(existing.id); return }
    saveRecent([sym, ...recent.filter((x) => x !== sym)].slice(0, RECENT_MAX))
    setSelected(`q:${sym}`)
  }

  const current = allItems.find((x) => x.id === selected) ?? allItems[0] ?? null
  // Picking a row charts it and brings the chart into view.
  const chartRef = useRef(null)
  const showItem = (id) => {
    setSelected(id)
    requestAnimationFrame(() => chartRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }
  const key = current ? `${current.crypto ? 'X:' : ''}${current.ticker}:${range}` : null

  // One request per ticker + range; results stay cached for the visit.
  const requested = useRef(new Set())
  useEffect(() => {
    if (loading || !current || requested.current.has(key)) return
    requested.current.add(key)
    supabase.functions.invoke('price-history', { body: { ticker: current.ticker, range, crypto: current.crypto || undefined } })
      .then(({ data, error }) => {
        setBars((b) => ({ ...b, [key]: !error && data?.success ? data : { error: true } }))
      })
  }, [loading, current, key, range])

  const data = key ? bars[key] : null
  const ohlc = data?.bars?.length ? data.bars : null
  const lastBar = ohlc?.[ohlc.length - 1]
  const firstBar = ohlc?.[0]
  const shown = hover ?? lastBar
  // Gain or loss from the start of the range (1D: the previous close) to
  // the latest candle — or, while scrubbing, to the candle under the finger.
  const intraday = typeof firstBar?.t === 'number'
  const base = range === '1d' && data?.prev_close > 0 ? data.prev_close : firstBar?.c
  const change = shown && base > 0 ? shown.c - base : null
  const changeLabel = range === '1d' ? 'today'
    : hover && firstBar ? `since ${typeof firstBar.t === 'string' && ['1y', '2y', '5y', 'max'].includes(range) ? shortDate(firstBar.t) : dayLabel(firstBar.t)}`
    : RANGES.find(([v]) => v === range)?.[1]
  // Stable per pick, so hovering doesn't rebuild the chart.
  const levels = useMemo(() => (current?.lines ?? []).map((l) => ({ price: l.v, label: l.label, gold: l.gold })), [current])

  // Load this ticker's saved pins when the pick changes.
  const ticker = current?.ticker ?? null
  useEffect(() => {
    if (!ticker) return
    let saved = null
    try { saved = JSON.parse(localStorage.getItem(TOOLS_KEY(ticker)) ?? 'null') } catch { /* none */ }
    setTools({ ticker, pins: Array.isArray(saved?.pins) ? saved.pins.slice(0, 2) : [], fib: saved?.fib === true })
    setPicking(false)
  }, [ticker])
  const saveTools = (next) => {
    setTools(next)
    try { localStorage.setItem(TOOLS_KEY(next.ticker), JSON.stringify({ pins: next.pins, fib: next.fib })) } catch { /* this visit only */ }
  }
  // A tap while measuring: first A, then B; with both set, it moves the nearer pin.
  const onPick = (pin) => {
    if (!pin || tools.ticker !== ticker) return
    let pins = tools.pins
    if (pins.length < 2) pins = [...pins, pin]
    else {
      const placedNow = placePins(ohlc, pins)
      const idx = ohlc.findIndex((b) => b.t === pin.t)
      const nearer = placedNow && Math.abs(placedNow[0].i - idx) <= Math.abs(placedNow[1].i - idx) ? 0 : 1
      const ordered = placedNow ? [{ t: placedNow[0].t, p: placedNow[0].p }, { t: placedNow[1].t, p: placedNow[1].p }] : pins
      pins = ordered.map((x, i) => (i === nearer ? pin : x))
    }
    saveTools({ ...tools, pins })
    if (pins.length === 2 && tools.pins.length < 2) setPicking(false)
  }
  // A dragged pin (live while dragging) or a ‹ › step.
  const onPinsChange = (pins) => { if (tools.ticker === ticker) saveTools({ ...tools, pins }) }
  const step = (k, dir) => {
    const next = stepPin(ohlc, placed, k, dir)
    if (next) saveTools({ ...tools, pins: next })
  }
  const placed = useMemo(() => (tools.ticker === ticker && ohlc ? placePins(ohlc, tools.pins) : null), [tools, ticker, ohlc])
  const move = useMemo(() => measure(placed), [placed])
  const fib = useMemo(() => (tools.fib ? fibLevels(placed) : []), [tools.fib, placed])
  const chartPins = useMemo(() => {
    if (placed) return placed
    // One pin so far: show it on its candle.
    if (tools.ticker === ticker && tools.pins.length === 1 && ohlc) {
      const one = placePins(ohlc, [tools.pins[0], tools.pins[0]])
      return one ? [one[0]] : []
    }
    return []
  }, [placed, tools, ticker, ohlc])
  const offRange = tools.ticker === ticker && tools.pins.length === 2 && ohlc && !placed

  const ideaItems = items.filter((x) => x.group === 'ideas')
  const holdingItems = items.filter((x) => x.group === 'holdings')
  const searchedItems = allItems.filter((x) => x.group === 'search')

  return (
    <div className="px-4 py-4 pb-24 max-w-md mx-auto">
      <header className="flex items-center justify-between mb-5">
        <h1 className="text-lg font-semibold">Charts</h1>
        <button type="button" onClick={() => setSearchOpen(true)} aria-label="Search tickers"
          className="min-h-[44px] px-3 inline-flex items-center gap-2 rounded-xl bg-card border border-border text-sm text-subtle hover:text-fg transition">
          <Search size={15} aria-hidden /> Search
        </button>
      </header>

      {/* One list at a time: tabs pinned under the header. */}
      <div className="sticky top-[env(safe-area-inset-top)] z-20 -mx-4 px-4 pt-1 pb-3 mb-1 bg-bg">
        <div className="flex gap-0.5 p-0.5 rounded-xl bg-card border border-border" role="tablist" aria-label="Charts sections">
          {CHART_TABS.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
              className={clsx('flex-1 min-w-0 min-h-[40px] px-1 rounded-lg text-[13px] font-semibold transition truncate',
                tab === k ? 'bg-bg-elev text-fg shadow-sm' : 'text-muted hover:text-subtle')}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'momentum' && <MomentumList />}
      {tab === 'pullbacks' && <ConfluenceLeaders mine={myTickers} />}

      {tab !== 'charts' ? null : loading ? (
        <div className="text-xs text-muted py-8 text-center">Loading…</div>
      ) : allItems.length === 0 ? (
        <section className="bg-card border border-border rounded-2xl p-5">
          <h2 className="text-sm font-semibold mb-1">No suggested trades right now</h2>
          <p className="text-sm text-subtle">
            A chart shows up here when a sector ETF ranks for a LEAPS buy, when the LEAPS bot suggests a trade,
            or when your exit plan calls for a sell or roll. Search any ticker to chart it.
          </p>
          <Link to="/bot" className="mt-4 min-h-[44px] inline-flex items-center text-sm text-amber-300">See today's checks</Link>
        </section>
      ) : (
        <>
          {current && (
            <Portalled when={full}>
            <section ref={chartRef} className={clsx('bg-card scroll-mt-4',
              full ? 'fixed inset-0 z-[70] flex flex-col overflow-y-auto overscroll-contain pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]'
                : 'border border-border rounded-2xl mb-5 overflow-hidden')}
              role={full ? 'dialog' : undefined} aria-modal={full || undefined} aria-label={full ? `${current.ticker} chart` : undefined}>
              {/* Quote header: last price and the range's change; while the
                  crosshair is on the chart, that day's OHLC and volume. */}
              <div className={clsx('px-5 shrink-0', full ? 'pt-3' : 'pt-5')}>
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="text-lg font-semibold tracking-tight">{current.ticker}</h2>
                      <span className={clsx('text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-md border', VERDICT_TONE[current.tone])}>
                        {current.verdict}
                      </span>
                    </div>
                    {!full && <div className="text-xs text-muted mt-0.5 truncate">{current.from}</div>}
                  </div>
                  {shown && (
                    <div className="text-right shrink-0">
                      <div className="text-2xl font-semibold font-mono-tab leading-none text-fg">{price(shown.c)}</div>
                      {change != null && (
                        <div className={clsx('mt-1 font-mono-tab', change < 0 ? 'text-rose-300' : 'text-green-400')}>
                          <span className="text-sm font-semibold">{change >= 0 ? '+' : '−'}{Math.abs((change / base) * 100).toFixed(2)}%</span>
                          <span className="text-xs"> {change >= 0 ? '+' : '−'}{Math.abs(change).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                          {!full && <div className="text-[11px] text-muted">{changeLabel}</div>}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className={clsx('flex items-center gap-2', full ? 'mt-1' : 'mt-3')}>
                  <div className="flex-1 min-w-0 h-[18px] text-[11px] font-mono-tab text-muted truncate">
                    {shown && (
                      <>
                        {dayLabel(shown.t)}
                        <span className="ml-3">O <span className="text-subtle">{num(shown.o)}</span></span>
                        <span className="ml-2">H <span className="text-subtle">{num(shown.h)}</span></span>
                        <span className="ml-2">L <span className="text-subtle">{num(shown.l)}</span></span>
                        {shown.v > 0 && <span className="ml-2">Vol <span className="text-subtle">{compact(shown.v)}</span></span>}
                      </>
                    )}
                  </div>
                  <button type="button" onClick={() => setFull((v) => !v)} aria-label={full ? 'Exit full screen' : 'Full screen'}
                    className="shrink-0 -my-3 -mr-3 h-11 w-11 flex items-center justify-center rounded-md text-violet-300 hover:text-violet-200">
                    {full ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                  </button>
                </div>
              </div>

              <div className={clsx('mt-1', full && 'flex-1 min-h-[200px]')}>
                {data === null || data === undefined ? (
                  <div className="h-[300px] flex items-center justify-center text-xs text-muted">Loading prices…</div>
                ) : data.error || !ohlc ? (
                  <div className="h-[300px] flex items-center justify-center text-xs text-muted">Couldn't load prices for {current.ticker}.</div>
                ) : (
                  <PriceChart bars={ohlc} levels={levels} fitLevels={!intraday} height={full ? '100%' : 300} onHover={setHover}
                    pins={chartPins} fib={fib} picking={picking} onPick={onPick} onPinsChange={onPinsChange} />
                )}
              </div>

              {/* Range */}
              <div className="px-3 py-2 flex items-center gap-2 border-t border-hairline shrink-0">
                <div className="flex-1 flex items-center" role="tablist" aria-label="Range">
                  {RANGES.map(([v, label]) => (
                    <button key={v} type="button" role="tab" aria-selected={range === v} onClick={() => { setHover(null); setRange(v) }}
                      className={clsx('flex-1 min-h-[36px] min-w-0 px-0.5 rounded-md text-[11px] font-semibold transition',
                        range === v ? 'bg-bg-elev text-fg' : 'text-muted hover:text-fg')}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Drawing tools: Measure (two pins), Fibonacci, Auto swing (owner, 2026-10-03: this order; only Auto keeps an icon) */}
              <div className="px-3 py-2 flex items-center gap-1 border-t border-hairline shrink-0">
                <ToolButton active={picking} onClick={() => setPicking((v) => !v)} label="Measure" />
                <ToolButton active={tools.fib} onClick={() => saveTools({ ...tools, ticker, fib: !tools.fib })} label="Fibonacci" disabled={!placed} />
                <ToolButton onClick={() => { const a = ohlc && autoSwing(ohlc); if (a) { saveTools({ ...tools, ticker, pins: a, fib: true }); setPicking(false) } }}
                  label="Auto" icon={Sparkles} disabled={!ohlc} />
                <span className="flex-1" />
                {!current.crypto && (
                  <Link to={`/charts/entry/${encodeURIComponent(current.ticker)}`} aria-label="Entry chart"
                    className="min-h-[36px] px-2 inline-flex items-center gap-1.5 rounded-md text-xs font-semibold whitespace-nowrap text-amber-300 hover:text-amber-200">
                    <Crosshair size={13} aria-hidden /> Entry
                  </Link>
                )}
                {(tools.pins.length > 0 || tools.fib) && (
                  <button type="button" onClick={() => { saveTools({ ticker, pins: [], fib: false }); setPicking(false) }} aria-label="Clear drawings"
                    className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-md text-muted hover:text-fg">
                    <X size={14} />
                  </button>
                )}
              </div>
              {(picking || move || offRange) && (
                <div className="px-5 pb-3 -mt-1 text-xs shrink-0">
                  {move ? (
                    <div className="rounded-xl bg-bg-elev px-4 py-3">
                      {/* The move, and how long it took */}
                      <div className="flex items-start gap-3">
                        <div className={clsx('flex-1 min-w-0 font-mono-tab', move.change < 0 ? 'text-rose-300' : 'text-green-400')}>
                          <span className="text-lg font-semibold">{move.change >= 0 ? '+' : '−'}{Math.abs(move.pct * 100).toFixed(2)}%</span>
                          <span className="ml-2 text-sm">{move.change >= 0 ? '+' : '−'}${num(Math.abs(move.change))}</span>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-sm text-fg">{spanLabel(move, range).main}</div>
                          {spanLabel(move, range).sub && <div className="text-[11px] text-muted">{spanLabel(move, range).sub}</div>}
                        </div>
                      </div>
                      {/* From A to B */}
                      <div className="mt-3 pt-3 border-t border-hairline grid grid-cols-[1fr_auto_1fr] items-center gap-3">
                        <PinCell letter="A" label="From" date={pinDate(move.from.t)} price={num(move.from.p)}
                          onStep={(dir) => step(0, dir)} canBack={!!stepPin(ohlc, placed, 0, -1)} canFwd={!!stepPin(ohlc, placed, 0, 1)} />
                        <span className="text-muted text-sm" aria-hidden>→</span>
                        <PinCell letter="B" label="To" date={pinDate(move.to.t)} price={num(move.to.p)}
                          onStep={(dir) => step(1, dir)} canBack={!!stepPin(ohlc, placed, 1, -1)} canFwd={!!stepPin(ohlc, placed, 1, 1)} />
                      </div>
                    </div>
                  ) : offRange ? (
                    <span className="text-muted">Your pins are outside this range.</span>
                  ) : (
                    <span className="text-muted">Tap a candle for point {tools.pins.length === 0 ? 'A' : 'B'}. It snaps to the high or low.</span>
                  )}
                  {move && <div className="text-muted mt-2">Drag a pin to move it{picking ? ', or tap a candle to move the nearer one' : ''}.</div>}
                </div>
              )}
              {fib.length > 0 && (
                // Retracements = how far price pulls back from B toward A (the
                // trading convention: 0% at B, 100% at A); extensions = targets
                // past B, as multiples of the A→B move.
                <div className="px-5 pb-3 shrink-0 space-y-3 text-xs">
                  {[['retracement', 'Pullback from B toward A'], ['extension', 'Targets past B']].map(([kind, title]) => (
                    <div key={kind}>
                      <div className="text-[11px] text-muted mb-1">{title}</div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono-tab">
                        {fib.filter((l) => l.kind === kind).map((l) => (
                          <div key={`${l.kind}-${l.ratio}`} className="flex items-baseline gap-2">
                            <span className={clsx('w-16', l.kind === 'extension' ? (l.up ? 'text-green-400' : 'text-rose-300')
                              : l.ratio === 0.5 || l.ratio === 0.618 ? 'text-amber-300' : 'text-muted')}>
                              {l.label}{l.ratio === 0 && l.kind === 'retracement' ? ' · B' : l.ratio === 1 ? ' · A' : ''}
                            </span>
                            <span className="text-subtle">{num(l.price)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* The trade */}
              <div className={clsx('px-5 py-4 border-t border-hairline', full && 'hidden')}>
                <div className="text-sm font-semibold text-fg">{current.title}</div>
                {current.body && <div className="text-sm text-subtle mt-1">{current.body}</div>}
                {levels.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {levels.map((l) => (
                      <span key={l.label} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-bg-elev text-xs">
                        <span className={clsx('h-0.5 w-3 rounded', l.gold ? 'bg-amber-400' : 'bg-subtle')} aria-hidden />
                        <span className="text-muted">{l.label}</span>
                        <span className="font-mono-tab text-fg">{price(l.price)}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </section>
            </Portalled>
          )}

          {ideaItems.length > 0 && (
            <TradeList title="LEAPS ideas" items={ideaItems} current={current} onPick={showItem} />
          )}
          {holdingItems.length > 0 && (
            <TradeList title="Your holdings" items={holdingItems} current={current} onPick={showItem} />
          )}
          {searchedItems.length > 0 && (
            <TradeList title="Searched" items={searchedItems} current={current} onPick={showItem}
              onClear={() => { saveRecent([]); if (current?.group === 'search') setSelected(null) }} />
          )}

          <p className="text-xs text-muted">
            Suggestions, not advice. Prices are daily closes and may be delayed.
          </p>
        </>
      )}

      <TickerDrawer
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        curated={CHART_TICKERS}
        watchlist={watchlist}
        gatedSet={NO_GATES}
        selected={current?.ticker}
        onSelect={pickTicker}
        allowCustom
        feedLabels={false}
      />
    </div>
  )
}

const NO_GATES = new Set()
const RECENT_KEY = 'cm:chart-recent'
const RECENT_MAX = 8

const VERDICT_TONE = {
  red: 'text-rose-300 border-rose-400/40 bg-rose-400/10',
  green: 'text-green-300 border-green-400/40 bg-green-400/10',
  amber: 'text-amber-300 border-amber-400/40 bg-amber-400/10',
  neutral: 'text-subtle border-border bg-bg-elev',
}

// One sentence from the pre-registered test: the SPY call bought on the
// same days as every stock signal, against the single-name rules (same
// exits, open trades at their mark). Once the `index` rule has run (SPY
// at month ends), its own numbers lead.
// Live bid / ask from the dxlink-worker (owner, 2026-10-06): suggest-leaps
// attaches `live` when dxlink_quotes has the contract; "live" within 20
// minutes of the last frame, else the last quote with its age.
function liveText(c) {
  const l = c.live
  if (!l || l.bid == null || l.ask == null) return ''
  const ageMin = l.updated_at ? Math.round((Date.now() - Date.parse(l.updated_at)) / 60000) : null
  const tag = ageMin == null ? '' : ageMin <= 20 ? 'live' : ageMin < 120 ? `${ageMin} min ago` : ageMin < 48 * 60 ? `${Math.round(ageMin / 60)}h ago` : 'last'
  return ` · bid ${money(l.bid)} / ask ${money(l.ask)}${tag ? ` (${tag})` : ''}`
}

function indexRecordText(rec) {
  const pct = (v) => (v == null ? null : `${v >= 0 ? '+' : '−'}${Math.round(Math.abs(v) * 100)}%`)
  if (!rec?.rules) return 'The plain index call — the benchmark every stock signal is tested against.'
  const idx = rec.rules.index
  const setup = rec.rules.setup
  const mom = rec.rules.momentum
  const control = setup?.spy
  const parts = []
  // The fairest index record is the monthly DCA control on SPY itself: the
  // same call bought every month end, overlapping (one-at-a-time month-end
  // entries give only a handful of trades, so timing luck dominates them).
  if (idx?.dca != null && Number(idx.dca_n) >= 30) parts.push(`In the test, this call bought every month end averaged ${pct(Number(idx.dca))} per trade over ${Number(idx.dca_n)} trades`)
  else if (control != null) parts.push(`In the test, this call bought on the same days as every stock signal averaged ${pct(Number(control))} per trade${setup.spy_lost_half != null && Number(setup.spy_lost_half) === 0 ? ', none losing half' : ''}`)
  if (!parts.length) return 'The plain index call — the benchmark every stock signal is tested against.'
  const vs = [setup?.strategy != null ? `${pct(Number(setup.strategy))} for the buy setup` : null, mom?.strategy != null ? `${pct(Number(mom.strategy))} for momentum` : null].filter(Boolean)
  return `${parts[0]}${vs.length ? ` — against ${vs.join(' and ')}` : ''}. Same exits, 2022–2026, a bull market; past results, not a forecast.`
}

// "PLTR hit 100% gain" → "hit 100% gain" (the ticker is already shown).
const withoutTicker = (it) => (it.title.startsWith(it.ticker) ? it.title.slice(it.ticker.length).replace(/^[:\s]+/, '') : it.title)

// One pin of the measure card; ‹ › step it a candle earlier / later.
function PinCell({ letter, label, date, price, onStep, canBack, canFwd }) {
  const btn = 'shrink-0 h-9 w-8 -my-1.5 flex items-center justify-center rounded-md text-subtle hover:text-fg hover:bg-card disabled:opacity-30 disabled:hover:bg-transparent'
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-[11px] text-muted">
        <span className="h-4 w-4 rounded-full bg-amber-400 text-bg text-[10px] font-bold flex items-center justify-center" aria-hidden>{letter}</span>
        {label}
      </div>
      <div className="mt-1 text-xs text-subtle truncate">{date}</div>
      <div className="flex items-center gap-1">
        <span className="flex-1 min-w-0 text-sm font-mono-tab text-fg truncate">${price}</span>
        <button type="button" className={btn} onClick={() => onStep(-1)} disabled={!canBack} aria-label={`Move ${letter} one candle earlier`}>
          <ChevronLeft size={15} />
        </button>
        <button type="button" className={btn} onClick={() => onStep(1)} disabled={!canFwd} aria-label={`Move ${letter} one candle later`}>
          <ChevronRight size={15} />
        </button>
      </div>
    </div>
  )
}

function ToolButton({ active, onClick, label, icon: Icon, disabled }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-pressed={active ?? undefined}
      className={clsx('min-h-[36px] px-2 inline-flex items-center gap-1.5 rounded-md text-xs font-semibold whitespace-nowrap transition disabled:opacity-40',
        active ? 'bg-amber-400/15 text-amber-300' : 'text-subtle hover:text-fg')}>
      {Icon && <Icon size={14} aria-hidden />}
      {label}
    </button>
  )
}

function TradeList({ title, items, current, onPick, onClear }) {
  return (
    <section className="bg-card border border-border rounded-2xl p-5 mb-5">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="flex-1 text-sm font-semibold">{title}</h2>
        {onClear && (
          <button type="button" onClick={onClear} className="-my-2 min-h-[44px] px-2 text-xs text-muted hover:text-fg">Clear</button>
        )}
      </div>
      <ul className="space-y-2.5">
        {items.map((it) => {
          const on = it === current
          const what = withoutTicker(it)
          return (
            <li key={it.id} className={clsx('rounded-xl border transition',
              on ? 'border-amber-400/40 bg-amber-400/[0.04]' : 'border-hairline bg-bg-elev/40')}>
              {/* The row charts this ticker. */}
              <button type="button" onClick={() => onPick(it.id)} aria-pressed={on}
                className="w-full text-left px-4 pt-3.5 pb-3 rounded-t-xl hover:bg-card-hover/40 transition">
                <span className="flex items-center gap-2">
                  <span className="flex-1 min-w-0 text-[15px] font-semibold text-fg">{it.ticker}</span>
                  <span className={clsx('shrink-0 text-[10px] uppercase tracking-wider font-semibold px-2 py-1 rounded-md border', VERDICT_TONE[it.tone])}>
                    {it.verdict}
                  </span>
                </span>
                {what && <span className="block text-sm text-subtle mt-0.5">{what[0].toUpperCase() + what.slice(1)}</span>}
                {it.body && <span className="block text-xs text-muted mt-1 line-clamp-2">{it.body}</span>}
              </button>
              <span className="flex items-center gap-1 px-2 pb-1.5 border-t border-hairline">
                <button type="button" onClick={() => onPick(it.id)} disabled={on}
                  className={clsx('min-h-[40px] px-2 inline-flex items-center gap-1.5 text-xs font-semibold rounded-md transition',
                    on ? 'text-amber-300' : 'text-subtle hover:text-fg')}>
                  <ChartLine size={13} aria-hidden /> {on ? 'On the chart' : 'Show on chart'}
                </button>
                <span className="flex-1" />
                {it.posId && it.shares && (
                  <Link to={`/charts/entry/${encodeURIComponent(it.ticker)}`}
                    className="min-h-[40px] px-2 inline-flex items-center gap-1 text-xs font-semibold text-violet-300 hover:text-violet-200 rounded-md">
                    Signals <ChevronRight size={13} aria-hidden />
                  </Link>
                )}
                {it.posId ? (
                  <Link to={`/leaps?open=${it.posId}`}
                    className="min-h-[40px] px-2 inline-flex items-center gap-1 text-xs font-semibold text-amber-300 hover:text-amber-200 rounded-md">
                    Open in Portfolio <ChevronRight size={13} aria-hidden />
                  </Link>
                ) : !it.crypto && (
                  <Link to={`/charts/entry/${encodeURIComponent(it.ticker)}`}
                    className="min-h-[40px] px-2 inline-flex items-center gap-1 text-xs font-semibold text-amber-300 hover:text-amber-200 rounded-md">
                    Entry chart <ChevronRight size={13} aria-hidden />
                  </Link>
                )}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
