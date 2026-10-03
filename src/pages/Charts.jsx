import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useHoldings, isQuantity } from '../hooks/useHoldings'
import { todayYmd } from '../utils/afterTax'
import { dailyDecisions, exitRows } from '../lib/holdingChecks'
import LineChart from '../components/LineChart'

// Charts — the stocks where the app suggests a trade, with the trade
// drawn on the price chart. Two groups:
//   LEAPS   — today's sell / roll / exit calls on your holdings (the exit
//             playbook, same checks as Home and the bot view), and LEAPS
//             bot suggestions from ldp_audit_log (last 30 days).
//   Spreads — the latest GEX spread plays from the scanner
//             (top_plays_feed, last 2 days). Elite.
// Prices come from the price-history edge function (Polygon daily bars,
// Yahoo fallback). Holding charts are hidden for now; their history
// (leaps_position_marks) keeps collecting.

const RANGES = [['3mo', '3M'], ['6mo', '6M'], ['1y', '1Y']]
const DAY_MS = 86400000
const BOT_DAYS = 30
const FEED_DAYS = 2
const ms = (ymd) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd ?? ''))
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null
}
const price = (n) => (Number.isFinite(n)
  ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: n < 10 ? 4 : 2 })}`
  : '—')
const shortDate = (ymd) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const KING_NODE = { call_wall: 'Call wall', put_wall: 'Put wall', flip: 'The Flip', zero_gamma: 'The Flip' }

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
  const [feed, setFeed] = useState(undefined)
  const [selected, setSelected] = useState(null)
  const [range, setRange] = useState('6mo')
  const [bars, setBars] = useState({})
  const today = todayYmd()

  useEffect(() => {
    if (!user) return
    let live = true
    const since = new Date(Date.now() - BOT_DAYS * DAY_MS).toISOString()
    supabase.from('ldp_audit_log').select('id, recorded_at, action, ticker, payload')
      .eq('kind', 'suggestion').gte('recorded_at', since).order('recorded_at', { ascending: false }).limit(50)
      .then(({ data, error }) => { if (live) setBotRows(error ? [] : data ?? []) })
    supabase.from('top_plays_feed').select('computed_at, ranked_plays')
      .gte('computed_at', new Date(Date.now() - FEED_DAYS * DAY_MS).toISOString())
      .order('computed_at', { ascending: false }).limit(1)
      .then(({ data, error }) => { if (live) setFeed(error ? null : data?.[0] ?? null) })
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
        out.push({ id: `h:${d.pos.id}`, group: 'leaps', ticker: d.pos.ticker, crypto: d.pos.instrument_type === 'crypto',
          title: d.title, body: d.body, verdict: d.verdict, tone: d.tone, lines, from: 'Your plan' })
      }
    }
    // LEAPS bot suggestions, newest per ticker.
    const seen = new Set()
    for (const row of botRows ?? []) {
      if (seen.has(row.ticker)) continue
      seen.add(row.ticker)
      const occ = parseOcc(row.payload?.contract)
      const lines = occ ? [{ v: occ.strike, label: 'Strike', gold: true }] : []
      const what = occ ? `${shortDate(occ.expiration)} $${occ.strike} ${occ.type === 'C' ? 'call' : 'put'}` : row.payload?.contract ?? ''
      const contracts = row.payload?.sizing?.contracts
      out.push({ id: `b:${row.id}`, group: 'leaps', ticker: row.ticker, title: `${row.action === 'buy' ? 'Buy' : 'Sell'} ${row.ticker} ${what}`.trim(),
        body: row.payload?.thesis ?? row.payload?.reason ?? (contracts ? `${contracts} contracts` : ''),
        verdict: row.action === 'buy' ? 'Buy' : 'Sell', tone: row.action === 'buy' ? 'green' : 'amber', lines,
        expiration: occ?.expiration, from: `LEAPS bot · ${shortDate(row.recorded_at.slice(0, 10))}` })
    }
    // GEX spread plays (Elite).
    for (const [i, p] of (feed?.ranked_plays ?? []).slice(0, 8).entries()) {
      if (!p?.ticker) continue
      const legs = [
        ['Long put', p.long_put_strike], ['Short put', p.short_put_strike],
        ['Short call', p.short_call_strike], ['Long call', p.long_call_strike],
      ].filter(([, v]) => Number(v) > 0)
      const lines = legs.length
        ? legs.map(([label, v]) => ({ v: Number(v), label }))
        : [['Long', p.long_strike], ['Short', p.short_strike]].filter(([, v]) => Number(v) > 0).map(([label, v]) => ({ v: Number(v), label }))
      if (Number(p.target_strike) > 0) {
        lines.push({ v: Number(p.target_strike), label: KING_NODE[p.target_king_node] ?? 'Target', gold: true })
      }
      // Iron condor: it keeps its credit while price stays between the short strikes.
      const band = Number(p.short_put_strike) > 0 && Number(p.short_call_strike) > 0
        ? { from: Number(p.short_put_strike), to: Number(p.short_call_strike) } : null
      out.push({ id: `s:${i}:${p.ticker}`, group: 'spreads', ticker: p.ticker,
        title: `${p.strategy ?? p.type} · exp ${p.expiration ? shortDate(p.expiration) : '—'}`,
        body: p.market_view ?? '', verdict: Number.isFinite(p.risk_reward) ? `R/R 1:${(+p.risk_reward).toFixed(1)}` : 'Play',
        tone: 'neutral', lines, band, expiration: p.expiration, from: 'Spread scanner' })
    }
    return out
  }, [ready, results, plan, today, botRows, feed])

  // Holdings are "ready" only once the tax rates load (a moment after
  // positions); wait for that so the first pick doesn't jump.
  const holdingsPending = positions === null || (positions.length > 0 && !!federal && !!profile?.state_code && !ready)
  const loading = holdingsPending || botRows === null || feed === undefined
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
  const series = data?.bars?.length
    ? data.bars.map((b) => ({ t: ms(b.t), v: b.c })).filter((p) => p.t != null)
    : []
  const first = series[0]?.v
  const last = series[series.length - 1]?.v
  const change = first > 0 && last != null ? last / first - 1 : null
  const vLines = []
  const exp = current?.expiration ? ms(current.expiration) : null
  if (exp != null && series.length && exp - series[series.length - 1].t <= 45 * DAY_MS) vLines.push({ t: exp, label: 'Expires' })

  const leaps = items.filter((x) => x.group === 'leaps')
  const spreads = items.filter((x) => x.group === 'spreads')

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
            A chart shows up here when your exit plan calls for a sell or roll, when the LEAPS bot suggests a trade,
            or when the spread scanner finds a play during market hours.
          </p>
          <Link to="/bot" className="mt-4 min-h-[44px] inline-flex items-center text-sm text-amber-300">See today's checks</Link>
        </section>
      ) : (
        <>
          {current && (
            <section className="bg-card border border-amber-400/30 rounded-2xl p-5 mb-5">
              <div className="flex items-baseline gap-2 mb-1">
                <h2 className="flex-1 text-base font-semibold">{current.ticker}</h2>
                {last != null && <span className="text-sm font-mono-tab text-fg">{price(last)}</span>}
                {change != null && (
                  <span className={clsx('text-xs font-mono-tab', change < 0 ? 'text-rose-300' : 'text-green-400')}>
                    {change >= 0 ? '+' : '−'}{Math.abs(change * 100).toFixed(1)}%
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1 mb-3" role="tablist" aria-label="Range">
                {RANGES.map(([v, label]) => (
                  <button key={v} type="button" role="tab" aria-selected={range === v} onClick={() => setRange(v)}
                    className={clsx('min-h-[32px] px-3 rounded-full text-xs font-semibold transition',
                      range === v ? 'bg-amber-400/10 text-amber-300' : 'text-muted hover:text-fg')}>
                    {label}
                  </button>
                ))}
              </div>
              {data === null || data === undefined ? (
                <div className="h-[220px] flex items-center justify-center text-xs text-muted">Loading prices…</div>
              ) : data.error ? (
                <div className="h-[220px] flex items-center justify-center text-xs text-muted">Couldn't load prices for {current.ticker}.</div>
              ) : (
                <LineChart height={220} format={price} vLines={vLines}
                  bands={current.band ? [{ ...current.band, fill: 'fill-green-400/10' }] : []}
                  hLines={current.lines.map((l) => ({ v: l.v, label: `${l.label} ${price(l.v)}`,
                    stroke: l.gold ? 'stroke-amber-400/60' : undefined, text: l.gold ? 'fill-amber-300' : undefined }))}
                  series={[{ id: 'close', label: 'Close', points: series,
                    stroke: change != null && change < 0 ? 'stroke-red-400' : 'stroke-green-400',
                    text: change != null && change < 0 ? 'text-rose-300' : 'text-green-400' }]} />
              )}
              <div className="mt-4 pt-4 border-t border-hairline">
                <div className="text-xs text-muted mb-1">{current.from}</div>
                <div className="text-sm font-semibold text-fg">{current.title}</div>
                {current.body && <div className="text-sm text-subtle mt-1">{current.body}</div>}
              </div>
            </section>
          )}

          {leaps.length > 0 && (
            <TradeList title="LEAPS" items={leaps} current={current} onPick={setSelected} />
          )}
          {spreads.length > 0 && (
            <TradeList title="Spread plays" badge="Elite" items={spreads} current={current} onPick={setSelected} />
          )}

          <p className="text-xs text-muted">
            Suggestions, not advice. Prices are daily closes and may be delayed.
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

function TradeList({ title, badge, items, current, onPick }) {
  return (
    <section className="bg-card border border-border rounded-2xl p-5 mb-5">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {badge && <span className="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-md border border-amber-400/40 text-amber-300">{badge}</span>}
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
