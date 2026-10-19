import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { supabase } from '../lib/supabase'
import { marketRead } from '../utils/marketPulse'

// The market on one screen (owner, 2026-10-19: "the leaders, their
// momentum, the market and risks signaled by government … economic news").
// Reads the nightly market_pulse row and the next week's econ_events.
const pctS = (x, d = 1) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d)}%`)
const day = (t) => new Date(`${t}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
const TONE = { green: 'text-green-400', amber: 'text-amber-300', red: 'text-red-400' }
const KIND_LABEL = { fomc: 'Fed decision', cpi: 'Inflation (CPI)', jobs: 'Jobs report', ppi: 'Producer prices', gdp: 'GDP', pce: 'PCE inflation', jolts: 'Job openings' }

function Stat({ label, value, sub, tone = 'text-fg' }) {
  return (
    <div className="rounded-2xl bg-bg-elev px-3.5 py-3 min-w-0">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={clsx('mt-0.5 text-base font-semibold font-mono-tab leading-6 truncate', tone)}>{value}</div>
      {sub && <div className="text-[11px] text-muted truncate">{sub}</div>}
    </div>
  )
}

export default function MarketCard() {
  const [p, setP] = useState(undefined)
  const [prev, setPrev] = useState(null)
  const [events, setEvents] = useState([])
  useEffect(() => {
    let cancelled = false
    supabase.from('market_pulse').select('*').order('as_of', { ascending: false }).limit(6)
      .then(({ data, error }) => {
        if (cancelled) return
        if (error || !data?.length) { setP(null); return }
        setP(data[0]); setPrev(data[data.length - 1] ?? null)
      })
    const today = new Date().toISOString().slice(0, 10)
    const until = new Date(Date.now() + 10 * 86400e3).toISOString().slice(0, 10)
    supabase.from('econ_events').select('kind, event_date, event_time, title').gte('event_date', today).lte('event_date', until).order('event_date').limit(6)
      .then(({ data }) => { if (!cancelled) setEvents(data ?? []) })
    return () => { cancelled = true }
  }, [])
  if (p === undefined) return <div className="mb-5 h-40 rounded-2xl bg-card border border-border animate-pulse" aria-busy="true" />
  if (p === null && !events.length) return null
  const read = marketRead(p)
  const leadersChange = p && prev && prev.as_of !== p.as_of && prev.leaders != null ? p.leaders - prev.leaders : null
  return (
    <section className="mb-5 rounded-2xl bg-card border border-border p-4">
      <div className="flex items-baseline gap-2">
        <h2 className="flex-1 text-sm font-semibold">The market</h2>
        {p && <span className="text-[11px] text-muted">{day(p.as_of)} close</span>}
      </div>
      {read && (
        <p className="mt-1 text-sm text-subtle">
          <span className={clsx('font-semibold', TONE[read.tone])}>{read.trend}</span>
          {' — '}S&P 500 {pctS(p.spy_vs200)} vs its 200-day{read.breadth ? <>, <span className="text-fg">{read.breadth}</span> participation</> : null}.
        </p>
      )}
      {p && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Stat label="S&P 500" value={p.spy_close != null ? Number(p.spy_close).toFixed(2) : '—'} sub={`${pctS(p.spy_1m)} past month`} tone={p.spy_1m >= 0 ? 'text-green-400' : 'text-red-400'} />
          <Stat label="Breadth" value={p.breadth != null ? `${Math.round(p.breadth * 100)}%` : '—'} sub="of stocks above their 200-day" />
          <Stat label="Leaders" value={p.leaders ?? '—'} sub={leadersChange == null ? 'stocks meeting the rule' : `${leadersChange >= 0 ? '+' : '−'}${Math.abs(leadersChange)} this week`} />
          <Stat label="Volatility (VIX)" value={p.vix != null ? Number(p.vix).toFixed(1) : '—'} sub={p.vix_5d != null ? `${p.vix_5d >= 0 ? '+' : '−'}${Math.abs(p.vix_5d).toFixed(1)} in 5 days` : 'fear gauge'}
            tone={p.vix == null ? 'text-fg' : p.vix >= 25 ? 'text-red-400' : p.vix >= 18 ? 'text-amber-300' : 'text-green-400'} />
        </div>
      )}
      {p?.groups?.length > 0 && (
        <div className="mt-3">
          <div className="text-[11px] text-muted">Where the leaders are</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {p.groups.slice(0, 6).map((g) => (
              <span key={g.name} className="px-2 py-0.5 rounded-full bg-bg-elev text-xs text-subtle">
                <span className="text-fg font-semibold">{g.name}</span> {g.n}
              </span>
            ))}
          </div>
        </div>
      )}
      {events.length > 0 && (
        <div className="mt-3 pt-3 border-t border-hairline">
          <div className="text-[11px] text-muted">Coming up</div>
          <ul className="mt-1 space-y-1">
            {events.map((e) => (
              <li key={`${e.kind}:${e.event_date}`} className="flex items-baseline gap-2 text-sm">
                <span className="w-24 shrink-0 text-xs text-muted font-mono-tab">{day(e.event_date)}</span>
                <span className="flex-1 min-w-0 truncate text-fg">{KIND_LABEL[e.kind] ?? e.title}</span>
                {e.event_time && <span className="text-[11px] text-muted font-mono-tab">{e.event_time} ET</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
