import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useHoldings, isQuantity } from '../hooks/useHoldings'
import { todayYmd } from '../utils/afterTax'
import { dailyDecisions, exitRows } from '../lib/holdingChecks'
import PriceChart from '../components/PriceChart'

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

const RANGES = [['1mo', '1M'], ['3mo', '3M'], ['6mo', '6M'], ['1y', '1Y'], ['2y', '2Y']]
const DAY_MS = 86400000
const BOT_DAYS = 30
const price = (n) => (Number.isFinite(n)
  ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: n < 10 ? 4 : 2 })}`
  : '—')
const shortDate = (ymd) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const dayLabel = (ymd) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const num = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—')
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
  const current = items.find((x) => x.id === selected) ?? items[0] ?? null
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
  // Change over the range, or for the hovered day vs the day before.
  const prevOf = (b) => { const i = ohlc?.indexOf(b) ?? -1; return i > 0 ? ohlc[i - 1].c : null }
  const base = hover ? prevOf(hover) : firstBar?.c
  const change = shown && base > 0 ? shown.c - base : null
  // Stable per pick, so hovering doesn't rebuild the chart.
  const levels = useMemo(() => (current?.lines ?? []).map((l) => ({ price: l.v, label: l.label, gold: l.gold })), [current])

  const ideaItems = items.filter((x) => x.group === 'ideas')
  const holdingItems = items.filter((x) => x.group === 'holdings')

  return (
    <div className="px-4 py-4 pb-24 max-w-md mx-auto">
      <header className="flex items-center justify-between mb-5">
        <h1 className="text-lg font-semibold">Charts</h1>
      </header>

      {loading ? (
        <div className="text-xs text-muted py-8 text-center">Loading…</div>
      ) : items.length === 0 ? (
        <section className="bg-card border border-border rounded-2xl p-5">
          <h2 className="text-sm font-semibold mb-1">No suggested trades right now</h2>
          <p className="text-sm text-subtle">
            A chart shows up here when a sector ETF ranks for a LEAPS buy, when the LEAPS bot suggests a trade,
            or when your exit plan calls for a sell or roll.
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
                        <div className={clsx('mt-1 text-xs font-mono-tab', change < 0 ? 'text-rose-300' : 'text-green-400')}>
                          {change >= 0 ? '+' : '−'}{Math.abs(change).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ({change >= 0 ? '+' : '−'}{Math.abs((change / base) * 100).toFixed(2)}%)
                          <span className="text-muted"> {hover ? 'day' : RANGES.find(([v]) => v === range)?.[1]}</span>
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
                  <PriceChart bars={ohlc} levels={levels} height={300} onHover={setHover} />
                )}
              </div>

              {/* Range */}
              <div className="px-3 py-2 flex items-center gap-2 border-t border-hairline">
                <div className="flex-1 flex items-center" role="tablist" aria-label="Range">
                  {RANGES.map(([v, label]) => (
                    <button key={v} type="button" role="tab" aria-selected={range === v} onClick={() => { setHover(null); setRange(v) }}
                      className={clsx('min-h-[36px] min-w-[40px] px-2 rounded-md text-xs font-semibold transition',
                        range === v ? 'bg-bg-elev text-fg' : 'text-muted hover:text-fg')}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>

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

          <p className="text-xs text-muted">
            Suggestions, not advice. Prices are daily closes and may be delayed.
            {' '}Charts by{' '}
            {/* Required by the charting library's licence (logo is off). */}
            <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-subtle">TradingView</a>.
          </p>
        </>
      )}
    </div>
  )
}

const VERDICT_TONE = {
  red: 'text-rose-300 border-rose-400/40 bg-rose-400/10',
  green: 'text-green-300 border-green-400/40 bg-green-400/10',
  amber: 'text-amber-300 border-amber-400/40 bg-amber-400/10',
  neutral: 'text-subtle border-border bg-bg-elev',
}

// "PLTR hit 100% gain" → "hit 100% gain" (the ticker is already shown).
const withoutTicker = (it) => (it.title.startsWith(it.ticker) ? it.title.slice(it.ticker.length).replace(/^[:\s]+/, '') : it.title)

function TradeList({ title, items, current, onPick }) {
  return (
    <section className="bg-card border border-border rounded-2xl p-5 mb-5">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-sm font-semibold">{title}</h2>
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
