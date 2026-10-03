import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { ArrowLeft, ChevronRight } from 'lucide-react'
import { supabase } from '../lib/supabase'

// /charts/record — Signal record (owner, 2026-10-03: NOW +84%, "how can the
// app suggest this trade and signal the exit?"). The latest universe replay
// (scripts/replay-universe.mjs → replay_runs): every ticker walked day by
// day with no hindsight, a priced LEAPS call on each entry rule × exit
// rule, big moves caught vs missed, and the walk-forward test of the
// history filter. Read-only; the job runs weekly.
const pctS = (x) => (x == null ? '—' : Math.abs(x) < 0.005 ? '0%' : `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x * 100))}%`)
const share = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`)
const day = (t) => (t ? new Date(`${t}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit', timeZone: 'UTC' }).replace(/, (\d\d)$/, ' ’$1') : '')
const tone = (x) => (x == null ? 'text-muted' : x < 0 ? 'text-rose-300' : 'text-green-400')
const ENTRIES = [['confluence', 'Confluence'], ['zone', 'Buy zone'], ['bravo', 'Bravo ◆']]
const EXITS = [
  ['targets', 'Exit targets', '70% at 2x · 15% at 3x · trail the rest'],
  ['signals', 'Sell signals', 'All out on 2+ sell signals'],
  ['both', 'Both', '70% at 2x, then 2+ sell signals'],
]

export default function SignalRecord() {
  const [row, setRow] = useState(undefined)
  const [entry, setEntry] = useState('confluence')
  const [allMissed, setAllMissed] = useState(false)
  useEffect(() => {
    let cancelled = false
    supabase.from('replay_runs').select('run_at, as_of, tickers, summary').order('run_at', { ascending: false }).limit(1)
      .then(({ data, error }) => { if (!cancelled) setRow(error ? null : data?.[0] ?? null) })
    return () => { cancelled = true }
  }, [])
  const s = row?.summary
  const mv = s?.moves?.[entry]
  const open = mv ? mv.moves - mv.held : 0
  const years = s?.by_year ? Object.entries(s.by_year) : []
  const maxAbs = Math.max(0.01, ...years.map(([, r]) => Math.abs(r.avg ?? 0)))

  return (
    <div className="px-4 py-4 pb-24 max-w-md md:max-w-3xl mx-auto">
      <header className="flex items-center gap-2 mb-5">
        <Link to="/charts" aria-label="Back to Charts"
          className="min-h-[44px] min-w-[44px] -ml-2 flex items-center justify-center rounded-xl text-subtle hover:text-fg">
          <ArrowLeft size={18} />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-semibold leading-tight">Signal record</h1>
          {s && <div className="text-xs text-muted">{s.tickers} tickers · 5 years · as LEAPS, no hindsight · {day(s.as_of)}</div>}
        </div>
      </header>

      {row === undefined ? (
        <div className="space-y-4" aria-busy="true">{[0, 1, 2].map((k) => <div key={k} className="h-40 rounded-2xl bg-card border border-border animate-pulse" />)}</div>
      ) : !s ? (
        <section className="bg-card border border-border rounded-2xl p-5 text-sm text-subtle">No replay yet. It runs every Saturday.</section>
      ) : (
        <>
          <div className="flex gap-1 p-1 rounded-xl bg-card border border-border mb-4" role="tablist" aria-label="Buy on">
            {ENTRIES.filter(([k]) => s.runs[`${k}:targets`]).map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={entry === k} onClick={() => setEntry(k)}
                className={clsx('flex-1 min-w-0 min-h-[40px] px-1 rounded-lg text-sm font-semibold transition truncate',
                  entry === k ? 'bg-bg-elev text-fg' : 'text-muted hover:text-subtle')}>
                {label}
              </button>
            ))}
          </div>

          <Card title="How each exit did">
            <ul className="space-y-4">
              {EXITS.map(([x, label, hint]) => {
                const r = s.runs[`${entry}:${x}`]
                if (!r) return null
                return (
                  <li key={x} className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-fg">{label}</div>
                      <div className="text-[11px] text-muted truncate">{hint}</div>
                      <div className="mt-1 text-xs text-subtle font-mono-tab">{share(r.winRate)} win · {r.n} trades · {Math.round(r.avgDays ?? 0)} days</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className={clsx('text-2xl font-semibold tracking-tight font-mono-tab leading-none', tone(r.avg))}>{pctS(r.avg)}</div>
                      <div className="mt-1 text-[11px] text-muted">avg · median {pctS(r.median)}</div>
                    </div>
                  </li>
                )
              })}
            </ul>
          </Card>

          {mv && open > 0 && (
            <Card title="Big moves caught">
              <div className="flex items-baseline gap-3">
                <div className="text-4xl font-semibold tracking-tight font-mono-tab text-fg leading-none">{share(mv.catchRate)}</div>
                <div className="text-xs text-muted">{mv.caught} of {open} rallies of +{share(s.move_rule.minGain)} off a low</div>
              </div>
              <div className="mt-3 h-1.5 rounded-full bg-bg-elev overflow-hidden" aria-hidden>
                <div className="h-full rounded-full bg-confluence" style={{ width: `${(mv.catchRate ?? 0) * 100}%` }} />
              </div>
              {mv.avgKept != null && <div className="mt-2 text-xs text-subtle">Kept {share(mv.avgKept)} of each move caught</div>}
              <div className="mt-4 flex flex-wrap gap-1.5">
                {Object.entries(mv.why).sort((a, b) => b[1] - a[1]).map(([why, n]) => (
                  <span key={why} className="px-2.5 py-1 rounded-full bg-bg-elev text-xs text-subtle">{why} <span className="font-mono-tab text-fg">{n}</span></span>
                ))}
              </div>
            </Card>
          )}

          {entry === 'confluence' && s.walk_forward && (
            <Card title="Does history help?">
              <div className="text-xs text-muted -mt-1 mb-3">Trades split by what the setup had done before each signal</div>
              <ul className="space-y-3">
                {EXITS.map(([x, label]) => {
                  const w = s.walk_forward[x]
                  if (!w) return null
                  return (
                    <li key={x}>
                      <div className="text-sm text-fg">{label}</div>
                      <div className="mt-1 grid grid-cols-2 gap-2">
                        <Split label="History yes" g={w.yes} />
                        <Split label="History no" g={w.no} />
                      </div>
                    </li>
                  )
                })}
              </ul>
            </Card>
          )}

          {entry === 'confluence' && years.length > 0 && (
            <Card title="By year">
              <ul className="space-y-2.5">
                {years.map(([y, r]) => (
                  <li key={y} className="flex items-center gap-3 text-xs font-mono-tab">
                    <span className="w-10 text-subtle">{y}</span>
                    <span className="flex-1 h-1.5 rounded-full bg-bg-elev overflow-hidden" aria-hidden>
                      <span className={clsx('block h-full rounded-full', (r.avg ?? 0) < 0 ? 'bg-rose-300/70' : 'bg-green-400/70')} style={{ width: `${(Math.abs(r.avg ?? 0) / maxAbs) * 100}%` }} />
                    </span>
                    <span className={clsx('w-12 text-right', tone(r.avg))}>{pctS(r.avg)}</span>
                    <span className="w-14 text-right text-muted">{r.closed} done</span>
                  </li>
                ))}
              </ul>
              <div className="mt-3 text-[11px] text-muted">Confluence buys, exit targets. Recent trades are mostly still open.</div>
            </Card>
          )}

          {s.puts && (
            <Card title="Puts">
              <div className="text-xs text-muted -mt-1 mb-3">Put debit spreads on 2+ sell signals, under the spread rules: 90 days out, pay ≤ 40% of the width, +100% sell half, −50% out, out at 21 days</div>
              <ul className="space-y-4">
                {Object.values(s.puts).map((r) => {
                  const open = r.drops.drops - r.drops.held
                  return (
                    <li key={r.rule} className="flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-fg">{r.label}</div>
                        <div className="mt-1 text-xs text-subtle font-mono-tab">{share(r.winRate)} win · {r.n} trades · {Math.round(r.avgDays ?? 0)} days · {share(r.bigLoss)} lost ½+</div>
                        {open > 0 && <div className="text-[11px] text-muted">Caught {r.drops.caught} of {open} drops of −{share(s.drop_rule.minDrop)} in 3 months</div>}
                      </div>
                      <div className="text-right shrink-0">
                        <div className={clsx('text-2xl font-semibold tracking-tight font-mono-tab leading-none', tone(r.avg))}>{pctS(r.avg)}</div>
                        <div className="mt-1 text-[11px] text-muted">avg · median {pctS(r.median)}</div>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </Card>
          )}

          {entry === 'confluence' && s.missed?.length > 0 && (
            <Card title="Biggest misses" flush>
              <ul className="divide-y divide-hairline">
                {(allMissed ? s.missed : s.missed.slice(0, 10)).map((m) => (
                  <li key={`${m.ticker}${m.low}`}>
                    <Link to={`/charts/entry/${encodeURIComponent(m.ticker)}`} className="px-5 py-3 flex items-center gap-3 hover:bg-card-hover/40 transition">
                      <span className="w-14 shrink-0 text-sm font-semibold text-fg">{m.ticker}</span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-xs text-subtle font-mono-tab">{day(m.low)} → {day(m.peak)}</span>
                        <span className="block text-[11px] text-muted truncate">{m.why}</span>
                      </span>
                      <span className="text-sm font-semibold font-mono-tab text-subtle">{pctS(m.gain)}</span>
                      <ChevronRight size={14} className="text-muted" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
              {s.missed.length > 10 && (
                <button type="button" onClick={() => setAllMissed(!allMissed)} className="w-full min-h-[44px] border-t border-hairline text-xs font-semibold text-subtle hover:text-fg">
                  {allMissed ? 'Show fewer' : `Show all ${s.missed.length}`}
                </button>
              )}
            </Card>
          )}

          <p className="text-[11px] text-muted px-1">Estimated option prices (Black-Scholes, 2% slippage). Past results, not advice.</p>
        </>
      )}
    </div>
  )
}

function Split({ label, g }) {
  return (
    <div className="rounded-xl bg-bg-elev px-3 py-2.5">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={clsx('mt-0.5 text-base font-semibold font-mono-tab', tone(g?.avg))}>{pctS(g?.avg)}</div>
      <div className="text-[11px] text-muted font-mono-tab">{share(g?.winRate)} win · {g?.closed ?? 0}</div>
    </div>
  )
}

function Card({ title, children, flush = false }) {
  return (
    <section className="bg-card border border-border rounded-2xl mb-4 overflow-hidden">
      <h2 className="text-sm font-semibold px-5 pt-5 pb-3">{title}</h2>
      <div className={flush ? '' : 'px-5 pb-5'}>{children}</div>
    </section>
  )
}
