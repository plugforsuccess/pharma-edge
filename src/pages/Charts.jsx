import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useHoldings, isQuantity } from '../hooks/useHoldings'
import { todayYmd } from '../utils/afterTax'
import { dailyDecisions, exitRows } from '../lib/holdingChecks'
import { Ruler, Search, Sparkles, X } from 'lucide-react'
import TickerDrawer from '../components/TickerDrawer'
import { TICKER_UNIVERSE } from '../lib/tickerUniverse'
import PriceChart from '../components/PriceChart'
import { placePins, measure, fibLevels, autoSwing } from '../utils/chartTools'

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

export default function Charts() {
  const { user } = useAuth()
  const { federal, profile, positions, plan, ready, results } = useHoldings()
  const [botRows, setBotRows] = useState(null)
  const [ideas, setIdeas] = useState(undefined)
  const [selected, setSelected] = useState(null)
  const [range, setRange] = useState('6mo')
  const [bars, setBars] = useState({})
  const [hover, setHover] = useState(null)
  // Drawing tools, per ticker, saved on this device: two Measure pins and
  // whether Fib levels are on. `picking` = the next tap drops a pin.
  const [tools, setTools] = useState({ ticker: null, pins: [], fib: false })
  const [picking, setPicking] = useState(false)
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
        out.push({ id: `h:${d.pos.id}`, group: 'holdings', ticker: d.pos.ticker, crypto: d.pos.instrument_type === 'crypto',
          title: d.title, body: d.body, verdict: d.verdict, tone: d.tone, lines, from: 'Your plan' })
      }
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
        body: `${why}. Delta ${c.delta.toFixed(2)} · about ${money(c.mid * 100)} per contract (mid) · ${c.dte} days to expiry.`,
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
  }, [ready, results, plan, today, botRows, ideas])

  // Holdings are "ready" only once the tax rates load (a moment after
  // positions); wait for that so the first pick doesn't jump.
  const holdingsPending = positions === null || (positions.length > 0 && !!federal && !!profile?.state_code && !ready)
  const loading = holdingsPending || botRows === null || ideas === undefined
  // Search: any ticker gets a chart (and the drawing tools), even with no
  // suggested trade. Recent searches are kept on this device.
  const [searchOpen, setSearchOpen] = useState(false)
  const [watchlist, setWatchlist] = useState([])
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
    const existing = items.find((x) => x.ticker === sym)
    if (existing) { setSelected(existing.id); return }
    saveRecent([sym, ...recent.filter((x) => x !== sym)].slice(0, RECENT_MAX))
    setSelected(`q:${sym}`)
  }

  const current = allItems.find((x) => x.id === selected) ?? allItems[0] ?? null
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

      {loading ? (
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
            <section className="bg-card border border-border rounded-2xl mb-5 overflow-hidden">
              {/* Quote header: last price and the range's change; while the
                  crosshair is on the chart, that day's OHLC and volume. */}
              <div className="px-5 pt-5">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="text-lg font-semibold tracking-tight">{current.ticker}</h2>
                      <span className={clsx('text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-md border', VERDICT_TONE[current.tone])}>
                        {current.verdict}
                      </span>
                    </div>
                    <div className="text-xs text-muted mt-0.5 truncate">{current.from}</div>
                  </div>
                  {shown && (
                    <div className="text-right shrink-0">
                      <div className="text-2xl font-semibold font-mono-tab leading-none text-fg">{price(shown.c)}</div>
                      {change != null && (
                        <div className={clsx('mt-1 font-mono-tab', change < 0 ? 'text-rose-300' : 'text-green-400')}>
                          <span className="text-sm font-semibold">{change >= 0 ? '+' : '−'}{Math.abs((change / base) * 100).toFixed(2)}%</span>
                          <span className="text-xs"> {change >= 0 ? '+' : '−'}{Math.abs(change).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                          <div className="text-[11px] text-muted">{changeLabel}</div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className="mt-3 h-[18px] text-[11px] font-mono-tab text-muted truncate">
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
              </div>

              <div className="mt-1">
                {data === null || data === undefined ? (
                  <div className="h-[300px] flex items-center justify-center text-xs text-muted">Loading prices…</div>
                ) : data.error || !ohlc ? (
                  <div className="h-[300px] flex items-center justify-center text-xs text-muted">Couldn't load prices for {current.ticker}.</div>
                ) : (
                  <PriceChart bars={ohlc} levels={levels} fitLevels={!intraday} height={300} onHover={setHover}
                    pins={chartPins} fib={fib} picking={picking} onPick={onPick} />
                )}
              </div>

              {/* Range */}
              <div className="px-3 py-2 flex items-center gap-2 border-t border-hairline">
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

              {/* Drawing tools: Measure (two pins), Auto swing, Fibonacci */}
              <div className="px-3 py-2 flex items-center gap-1.5 border-t border-hairline">
                <ToolButton active={picking} onClick={() => setPicking((v) => !v)} label="Measure" icon={Ruler} />
                <ToolButton onClick={() => { const a = ohlc && autoSwing(ohlc); if (a) { saveTools({ ...tools, ticker, pins: a, fib: true }); setPicking(false) } }}
                  label="Auto" icon={Sparkles} disabled={!ohlc} />
                <ToolButton active={tools.fib} onClick={() => saveTools({ ...tools, ticker, fib: !tools.fib })} label="Fib" disabled={!placed} />
                <span className="flex-1" />
                {(tools.pins.length > 0 || tools.fib) && (
                  <button type="button" onClick={() => { saveTools({ ticker, pins: [], fib: false }); setPicking(false) }} aria-label="Clear drawings"
                    className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-md text-muted hover:text-fg">
                    <X size={14} />
                  </button>
                )}
              </div>
              {(picking || move || offRange) && (
                <div className="px-5 pb-3 -mt-1 text-xs">
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
                        <PinCell letter="A" label="From" date={pinDate(move.from.t)} price={num(move.from.p)} />
                        <span className="text-muted text-sm" aria-hidden>→</span>
                        <PinCell letter="B" label="To" date={pinDate(move.to.t)} price={num(move.to.p)} />
                      </div>
                    </div>
                  ) : offRange ? (
                    <span className="text-muted">Your pins are outside this range.</span>
                  ) : (
                    <span className="text-muted">Tap a candle for point {tools.pins.length === 0 ? 'A' : 'B'}. It snaps to the high or low.</span>
                  )}
                  {picking && move && <div className="text-muted mt-0.5">Tap again to move the nearer pin.</div>}
                </div>
              )}
              {fib.length > 0 && (
                <div className="px-5 pb-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs font-mono-tab">
                  {fib.map((l) => (
                    <div key={`${l.kind}-${l.ratio}`} className="flex items-baseline gap-2">
                      <span className={clsx('w-12', l.kind === 'extension' ? (l.up ? 'text-green-400' : 'text-rose-300')
                        : l.ratio === 0.5 || l.ratio === 0.618 ? 'text-amber-300' : 'text-muted')}>{l.label}</span>
                      <span className="text-subtle">{num(l.price)}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* The trade */}
              <div className="px-5 py-4 border-t border-hairline">
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
          )}

          {ideaItems.length > 0 && (
            <TradeList title="LEAPS ideas" items={ideaItems} current={current} onPick={setSelected} />
          )}
          {holdingItems.length > 0 && (
            <TradeList title="Your holdings" items={holdingItems} current={current} onPick={setSelected} />
          )}
          {searchedItems.length > 0 && (
            <TradeList title="Searched" items={searchedItems} current={current} onPick={setSelected}
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
// The 11 SPDR sector ETFs the LEAPS ideas rank (suggest-leaps) — searchable
// alongside the app's ticker list, listed first under "Popular".
const SECTOR_ETFS = [
  ['XLK', 'Technology'], ['XLF', 'Financials'], ['XLV', 'Health Care'], ['XLE', 'Energy'],
  ['XLI', 'Industrials'], ['XLY', 'Consumer Discretionary'], ['XLP', 'Consumer Staples'],
  ['XLU', 'Utilities'], ['XLB', 'Materials'], ['XLRE', 'Real Estate'], ['XLC', 'Communication Services'],
].map(([symbol, label]) => ({ symbol, label: `${label} sector`, isHot: true }))
const CHART_TICKERS = (() => {
  const seen = new Set(SECTOR_ETFS.map((t) => t.symbol))
  return [...SECTOR_ETFS, ...TICKER_UNIVERSE.filter((t) => !seen.has(t.symbol))]
})()
const RECENT_KEY = 'cm:chart-recent'
const RECENT_MAX = 8

const VERDICT_TONE = {
  red: 'text-rose-300 border-rose-400/40 bg-rose-400/10',
  green: 'text-green-300 border-green-400/40 bg-green-400/10',
  amber: 'text-amber-300 border-amber-400/40 bg-amber-400/10',
  neutral: 'text-subtle border-border bg-bg-elev',
}

// "PLTR hit 100% gain" → "hit 100% gain" (the ticker is already shown).
const withoutTicker = (it) => (it.title.startsWith(it.ticker) ? it.title.slice(it.ticker.length).replace(/^[:\s]+/, '') : it.title)

function PinCell({ letter, label, date, price }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-[11px] text-muted">
        <span className="h-4 w-4 rounded-full bg-amber-400 text-bg text-[10px] font-bold flex items-center justify-center" aria-hidden>{letter}</span>
        {label}
      </div>
      <div className="mt-1 text-xs text-subtle truncate">{date}</div>
      <div className="text-sm font-mono-tab text-fg">${price}</div>
    </div>
  )
}

function ToolButton({ active, onClick, label, icon: Icon, disabled }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-pressed={active ?? undefined}
      className={clsx('min-h-[36px] px-2.5 inline-flex items-center gap-1.5 rounded-md text-xs font-semibold transition disabled:opacity-40',
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
      <ul className="space-y-1">
        {items.map((it) => (
          <li key={it.id}>
            <button type="button" onClick={() => onPick(it.id)} aria-pressed={it === current}
              className={clsx('w-full text-left flex items-start gap-3 min-h-[44px] -mx-2 px-2 py-2 rounded-lg transition',
                it === current ? 'bg-amber-400/5' : 'hover:bg-card-hover/40')}>
              <span className="flex-1 min-w-0">
                <span className="block text-sm text-fg">{it.ticker} <span className="text-muted">· {withoutTicker(it)}</span></span>
                <span className="block text-xs text-muted mt-0.5 truncate">{it.from}</span>
              </span>
              <span className={clsx('shrink-0 mt-0.5 text-[10px] uppercase tracking-wider font-semibold px-2 py-1 rounded-md border', VERDICT_TONE[it.tone])}>
                {it.verdict}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
