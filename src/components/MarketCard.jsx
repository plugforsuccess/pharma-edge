import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { marketRead } from '../utils/marketPulse'
import { Sparkline } from './ConfluenceLeaders'

// The market on one screen (owner, 2026-10-19: "the leaders, their
// momentum, the market and risks signaled by government … economic news").
// A one-line strip that opens into the full card (remembered on the device,
// cm:market-open); every number links somewhere — the S&P / VIX charts, the
// Leaders list (all, or one group), the agencies' own release schedules.
// Reads the nightly market_pulse rows and the next 10 days of econ_events.
const pctS = (x, d = 1) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d)}%`)
const day = (t) => new Date(`${t}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
const shortDay = (t) => new Date(`${t}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const TONE = { green: 'text-green-400', amber: 'text-amber-300', red: 'text-red-400' }
const DOT = { green: 'bg-green-400', amber: 'bg-amber-300', red: 'bg-red-400' }
const KIND_LABEL = { fomc: 'Fed decision', cpi: 'Inflation (CPI)', jobs: 'Jobs report', ppi: 'Producer prices', gdp: 'GDP', pce: 'PCE inflation', jolts: 'Job openings' }
const KIND_SHORT = { fomc: 'Fed', cpi: 'CPI', jobs: 'Jobs', ppi: 'PPI', gdp: 'GDP', pce: 'PCE', jolts: 'JOLTS' }
// What each release is, in one plain sentence (facts, no forecast).
const KIND_WHAT = {
  fomc: 'The Fed announces its interest-rate decision at 2:00 pm ET; the chair’s press conference follows at 2:30. Rate changes affect borrowing costs across the economy.',
  cpi: 'The monthly change in consumer prices. It’s the most-watched inflation reading and shapes expectations for the Fed’s next rate decision.',
  jobs: 'Monthly payrolls, the unemployment rate and wage growth. The Fed watches it alongside inflation.',
  ppi: 'Prices businesses receive for their goods and services — an early read on inflation in the supply chain.',
  gdp: 'How fast the US economy grew in the quarter. Later releases revise the first estimate.',
  pce: 'Personal income, spending and the PCE price index — the inflation measure the Fed targets.',
  jolts: 'Job openings, hires and quits — how tight the labor market is.',
}
const SOURCE = {
  fed: ['Federal Reserve', 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm'],
  bls: ['Bureau of Labor Statistics', 'https://www.bls.gov/schedule/news_release/'],
  bea: ['Bureau of Economic Analysis', 'https://www.bea.gov/news/schedule'],
}
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const when = (t) => {
  const today = new Date(); today.setHours(12, 0, 0, 0)
  const n = Math.round((new Date(`${t}T12:00:00`) - today) / 86400e3)
  return n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : day(t)
}

function Tile({ label, value, sub, tone = 'text-fg', spark, sparkTone, to, onClick, ariaLabel }) {
  const body = (
    <>
      <div className="flex items-center gap-1 text-[11px] text-muted">
        <span className="flex-1 truncate">{label}</span>
        <ChevronRight size={12} aria-hidden className="shrink-0" />
      </div>
      <div className={clsx('mt-0.5 text-base font-semibold font-mono-tab leading-6 truncate', tone)}>{value}</div>
      {spark?.length > 1 && <Sparkline values={spark} height={22} className={clsx('mt-1 w-full', sparkTone)} />}
      {sub && <div className="mt-0.5 text-[11px] text-muted truncate">{sub}</div>}
    </>
  )
  const cls = 'block w-full text-left rounded-2xl bg-bg-elev px-3.5 py-3 min-w-0 min-h-[44px] hover:bg-hairline transition'
  return to
    ? <Link to={to} className={cls} aria-label={ariaLabel}>{body}</Link>
    : <button type="button" onClick={onClick} className={cls} aria-label={ariaLabel}>{body}</button>
}

export default function MarketCard() {
  const [hist, setHist] = useState(undefined)
  const [events, setEvents] = useState([])
  const [open, setOpenState] = useState(() => { try { return localStorage.getItem('cm:market-open') === '1' } catch { return false } })
  const setOpen = (v) => { setOpenState(v); try { localStorage.setItem('cm:market-open', v ? '1' : '0') } catch { /* storage off */ } }
  const [breadthOpen, setBreadthOpen] = useState(false)
  const [eventOpen, setEventOpen] = useState(null)
  const [params, setParams] = useSearchParams()
  useEffect(() => {
    let cancelled = false
    supabase.from('market_pulse').select('*').order('as_of', { ascending: false }).limit(30)
      .then(({ data, error }) => { if (!cancelled) setHist(error || !data?.length ? null : data) })
    const today = isoDay(new Date())
    const until = isoDay(new Date(Date.now() + 10 * 86400e3))
    supabase.from('econ_events').select('kind, event_date, event_time, title, source').gte('event_date', today).lte('event_date', until).order('event_date').limit(8)
      .then(({ data }) => { if (!cancelled) setEvents(data ?? []) })
    return () => { cancelled = true }
  }, [])
  if (hist === undefined) return <div className="mb-5 h-16 rounded-2xl bg-card border border-border animate-pulse" aria-busy="true" />
  if (hist === null && !events.length) return null
  const p = hist?.[0] ?? null
  const read = marketRead(p)
  // A week / a month back in the stored history (oldest first for the lines).
  const back = (days) => p && hist.find((h) => Date.parse(h.as_of) <= Date.parse(p.as_of) - days * 86400e3)
  const week = back(6), month = back(27)
  const series = (k) => (hist ?? []).map((h) => h[k]).filter((x) => x != null).reverse()
  const breadthLine = series('breadth')
  const leadersLine = series('leaders')
  const leadersChange = week?.leaders != null && p?.leaders != null ? p.leaders - week.leaders : null
  const breadthRef = month ?? (hist?.length > 4 ? hist[hist.length - 1] : null)
  const breadthChange = breadthRef?.breadth != null && p?.breadth != null ? Math.round((p.breadth - breadthRef.breadth) * 100) : null
  const toLeaders = (next) => {
    const q = new URLSearchParams(params)
    q.delete('group'); q.delete('leaders')
    for (const [k, v] of Object.entries(next)) q.set(k, v)
    setParams(q, { replace: true })
    requestAnimationFrame(() => document.getElementById('leaders')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }
  const next = events[0]
  const spyTone = p?.spy_1m == null ? 'text-fg' : p.spy_1m >= 0 ? 'text-green-400' : 'text-red-400'
  const vixTone = p?.vix == null ? 'text-fg' : p.vix >= 25 ? 'text-red-400' : p.vix >= 18 ? 'text-amber-300' : 'text-green-400'

  return (
    <section className="mb-5 rounded-2xl bg-card border border-border overflow-hidden">
      {/* The strip: the verdict and three numbers, one tap to open. */}
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="w-full min-h-[56px] px-4 py-3 flex items-center gap-3 text-left hover:bg-bg-elev/60 transition">
        {read && <span className={clsx('h-2.5 w-2.5 shrink-0 rounded-full', DOT[read.tone])} aria-hidden />}
        <span className="flex-1 min-w-0">
          <span className="block text-sm leading-5 truncate">
            {read ? <span className={clsx('font-semibold', TONE[read.tone])}>{read.trend}</span> : <span className="font-semibold">The market</span>}
            {p?.spy_vs200 != null && <span className="text-subtle"> · S&P {pctS(p.spy_vs200)} vs 200-day</span>}
          </span>
          <span className="block text-xs text-muted truncate font-mono-tab">
            {[p?.leaders != null && `${p.leaders} leaders`, p?.vix != null && `VIX ${Number(p.vix).toFixed(1)}`,
              next && `${KIND_SHORT[next.kind] ?? next.title} ${when(next.event_date) === 'Today' || when(next.event_date) === 'Tomorrow' ? when(next.event_date).toLowerCase() : shortDay(next.event_date)}`]
              .filter(Boolean).join(' · ')}
          </span>
        </span>
        <ChevronDown size={18} aria-hidden className={clsx('shrink-0 text-muted transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="px-4 pb-4">
          {p && (
            <p className="text-sm text-subtle">
              {p.spy_streak != null && read
                ? <>The S&P 500 has closed {p.spy_above ? 'above' : 'below'} its 200-day average for <span className="text-fg font-semibold">{p.spy_streak} {p.spy_streak === 1 ? 'day' : 'days'}</span>{p.spy_slope200 != null ? `, and that average is ${p.spy_slope200 > 0 ? 'rising' : 'flat or falling'}` : ''}.</>
                : read ? <>S&P 500 {pctS(p.spy_vs200)} vs its 200-day average.</> : null}
              {p.breadth != null && <> {Math.round(p.breadth * 100)}% of the stocks we track are above theirs — <span className="text-fg">{read?.breadth ?? 'mixed'}</span> participation.</>}
            </p>
          )}

          {p && (
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Tile label="S&P 500" to="/charts/entry/SPY" ariaLabel="Open the S&P 500 chart"
                value={p.spy_close != null ? Number(p.spy_close).toFixed(2) : '—'} tone={spyTone}
                spark={p.spy_spark} sparkTone={spyTone} sub={`${pctS(p.spy_1m)} past month`} />
              <Tile label="Breadth" onClick={() => setBreadthOpen(!breadthOpen)} ariaLabel="Show breadth over time"
                value={p.breadth != null ? `${Math.round(p.breadth * 100)}%` : '—'}
                spark={breadthLine.length > 4 ? breadthLine : null} sparkTone="text-subtle"
                sub={breadthChange != null ? `${breadthChange >= 0 ? 'up' : 'down'} ${Math.abs(breadthChange)} pts since ${shortDay(breadthRef.as_of)}` : `of ${p.universe ?? '—'} stocks above their 200-day`} />
              <Tile label="Leaders" onClick={() => toLeaders({ leaders: 'all' })} ariaLabel="Show every leader"
                value={p.leaders ?? '—'} spark={leadersLine.length > 4 ? leadersLine : null} sparkTone="text-subtle"
                sub={leadersChange == null ? 'stocks meeting the rule' : leadersChange === 0 ? 'no change this week' : `${leadersChange > 0 ? '+' : '−'}${Math.abs(leadersChange)} this week`} />
              <Tile label="Volatility (VIX)" to={`/charts/entry/${encodeURIComponent('^VIX')}`} ariaLabel="Open the VIX chart"
                value={p.vix != null ? Number(p.vix).toFixed(1) : '—'} tone={vixTone}
                spark={p.vix_spark} sparkTone={vixTone}
                sub={p.vix_5d != null ? `${p.vix_5d >= 0 ? '+' : '−'}${Math.abs(p.vix_5d).toFixed(1)} in 5 days` : 'the market’s fear gauge'} />
            </div>
          )}

          {breadthOpen && p?.breadth != null && (
            <div className="mt-2 rounded-2xl bg-bg-elev px-3.5 py-3">
              <div className="text-[11px] text-muted">Breadth{breadthLine.length > 1 ? `, since ${shortDay(hist[hist.length - 1].as_of)}` : ''}</div>
              {breadthLine.length > 1
                ? <Sparkline values={breadthLine} fill height={64} className="mt-1 w-full text-violet-300" />
                : <div className="mt-1 text-xs text-subtle">The line fills in as each close is recorded.</div>}
              <p className="mt-1.5 text-xs text-subtle">
                The share of the {p.universe ?? ''} stocks we track that closed above their own 200-day average ({p.above200 ?? '—'} of {p.universe ?? '—'}).
                Above 60% is broad, 40–60% mixed, below 40% narrow — a rally carried by few stocks.
              </p>
            </div>
          )}

          {p?.groups?.length > 0 && (
            <div className="mt-3">
              <div className="text-[11px] text-muted">Where the leaders are · tap to see them</div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {p.groups.slice(0, 8).map((g) => (
                  <button key={g.name} type="button" onClick={() => toLeaders({ group: g.name })} aria-label={`Show the ${g.n} ${g.name} leaders`}
                    className={clsx('min-h-[32px] px-2.5 rounded-full text-xs transition',
                      params.get('group') === g.name ? 'bg-amber-400/15 text-amber-300 border border-amber-400/30' : 'bg-bg-elev text-subtle hover:text-fg')}>
                    <span className="font-semibold text-fg">{g.name}</span> {g.n}
                  </button>
                ))}
              </div>
            </div>
          )}

          {events.length > 0 && (
            <div className="mt-3 pt-3 border-t border-hairline">
              <div className="text-[11px] text-muted">Coming up · tap for what it is</div>
              <ul className="mt-1">
                {events.map((e) => {
                  const key = `${e.kind}:${e.event_date}`
                  const isOpen = eventOpen === key
                  const src = SOURCE[e.source]
                  return (
                    <li key={key}>
                      <button type="button" onClick={() => setEventOpen(isOpen ? null : key)} aria-expanded={isOpen}
                        className="w-full min-h-[40px] flex items-center gap-2 text-left text-sm">
                        <span className={clsx('w-24 shrink-0 text-xs font-mono-tab', when(e.event_date) === 'Today' || when(e.event_date) === 'Tomorrow' ? 'text-amber-300 font-semibold' : 'text-muted')}>{when(e.event_date)}</span>
                        <span className="flex-1 min-w-0 truncate text-fg">{KIND_LABEL[e.kind] ?? e.title}</span>
                        {e.event_time && <span className="text-[11px] text-muted font-mono-tab">{e.event_time} ET</span>}
                        <ChevronDown size={14} aria-hidden className={clsx('shrink-0 text-muted transition-transform', isOpen && 'rotate-180')} />
                      </button>
                      {isOpen && (
                        <div className="mb-2 ml-[104px] text-xs text-subtle">
                          <div className="text-fg">{e.title}</div>
                          {KIND_WHAT[e.kind] && <p className="mt-0.5">{KIND_WHAT[e.kind]}</p>}
                          {src && (
                            <a href={src[1]} target="_blank" rel="noreferrer" className="mt-1 min-h-[32px] inline-flex items-center gap-1 text-amber-300 hover:text-amber-200">
                              Official schedule · {src[0]} <ExternalLink size={12} aria-hidden />
                            </a>
                          )}
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
