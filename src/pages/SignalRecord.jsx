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
const pctS = (x) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x * 100))}%`)
const share = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`)
const day = (t) => (t ? new Date(`${t}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '')
const tone = (x) => (x == null ? 'text-muted' : x < 0 ? 'text-rose-300' : 'text-green-400')
const ENTRY_ORDER = ['confluence', 'zone', 'bravo']
const EXIT_ORDER = ['targets', 'signals', 'both']
const ENTRY_LABEL = { confluence: 'Confluence', zone: 'Buy zone', bravo: 'Bravo ◆' }
const EXIT_LABEL = { targets: 'Exit targets', signals: 'Sell signals', both: 'Targets + signals' }

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

  return (
    <div className="px-4 py-4 pb-24 max-w-md md:max-w-3xl mx-auto">
      <header className="flex items-center gap-2 mb-4">
        <Link to="/charts" aria-label="Back to Charts"
          className="min-h-[44px] min-w-[44px] -ml-2 flex items-center justify-center rounded-xl text-subtle hover:text-fg">
          <ArrowLeft size={18} />
        </Link>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] uppercase tracking-[0.14em] text-muted font-semibold">Charts</div>
          <h1 className="text-lg font-semibold leading-tight">Signal record</h1>
        </div>
      </header>

      {row === undefined ? (
        <div className="space-y-4" aria-busy="true">{[0, 1, 2].map((k) => <div key={k} className="h-40 rounded-2xl bg-card border border-border animate-pulse" />)}</div>
      ) : !s ? (
        <section className="bg-card border border-border rounded-2xl p-5 text-sm text-subtle">No replay yet — it runs weekly over every ticker.</section>
      ) : (
        <>
          <p className="text-xs text-muted mb-4">
            {s.tickers} tickers, 5 years each, replayed day by day with only what was known at each close. A ~2-year, 0.75-delta call bought the day after each signal. As of {day(s.as_of)}.
          </p>

          <Card title="Buy on">
            <div className="flex gap-1 p-1 rounded-xl bg-bg-elev" role="tablist" aria-label="Entry rule">
              {ENTRY_ORDER.filter((k) => s.runs[`${k}:targets`]).map((k) => (
                <button key={k} type="button" role="tab" aria-selected={entry === k} onClick={() => setEntry(k)}
                  className={clsx('flex-1 min-w-0 min-h-[36px] px-1 rounded-lg text-xs font-semibold transition truncate',
                    entry === k ? 'bg-card text-fg shadow-sm' : 'text-muted hover:text-subtle')}>
                  {ENTRY_LABEL[k]}
                </button>
              ))}
            </div>
            <div className="mt-4 overflow-x-auto -mx-1">
              <table className="w-full text-xs font-mono-tab">
                <thead>
                  <tr className="text-muted text-left">
                    <th className="font-normal px-1 pb-2">Sell by</th>
                    <th className="font-normal px-1 pb-2 text-right">Trades</th>
                    <th className="font-normal px-1 pb-2 text-right">Win</th>
                    <th className="font-normal px-1 pb-2 text-right">Avg</th>
                    <th className="font-normal px-1 pb-2 text-right">Median</th>
                    <th className="font-normal px-1 pb-2 text-right">Lost ½+</th>
                    <th className="font-normal px-1 pb-2 text-right">Days</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {EXIT_ORDER.map((x) => {
                    const r = s.runs[`${entry}:${x}`]
                    if (!r) return null
                    return (
                      <tr key={x}>
                        <td className="px-1 py-2 text-fg font-sans">{EXIT_LABEL[x]}</td>
                        <td className="px-1 py-2 text-right">{r.n}</td>
                        <td className="px-1 py-2 text-right">{share(r.winRate)}</td>
                        <td className={clsx('px-1 py-2 text-right', tone(r.avg))}>{pctS(r.avg)}</td>
                        <td className={clsx('px-1 py-2 text-right', tone(r.median))}>{pctS(r.median)}</td>
                        <td className="px-1 py-2 text-right">{share(r.bigLoss)}</td>
                        <td className="px-1 py-2 text-right">{Math.round(r.avgDays ?? 0)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-muted">Option returns on closed trades. Exit targets sell 70% at +100%, 15% at +200%, the rest on a 30% give-back; sell signals close on 2+ sell signals; both = targets first, then signals guard the rest. Out with 6 months left.</p>
          </Card>

          {s.moves?.[entry] && (
            <Card title="Big moves">
              <div className="text-2xl font-semibold font-mono-tab text-fg">{share(s.moves[entry].catchRate)}</div>
              <div className="text-xs text-subtle mt-0.5">
                caught · {s.moves[entry].caught} of {s.moves[entry].moves - s.moves[entry].held} moves of +{share(s.move_rule.minGain)} or more within 6 months of a low
                {s.moves[entry].held ? ` (${s.moves[entry].held} more while already holding)` : ''}
              </div>
              {s.moves[entry].avgKept != null && <div className="text-xs text-muted mt-1">The trades that caught one kept {share(s.moves[entry].avgKept)} of the move on average.</div>}
              <div className="mt-3 text-[11px] uppercase tracking-wider text-muted">Why the rest were missed</div>
              <ul className="mt-1 text-sm">
                {Object.entries(s.moves[entry].why).sort((a, b) => b[1] - a[1]).map(([why, n]) => (
                  <li key={why} className="py-1 flex"><span className="flex-1 text-subtle">{why}</span><span className="font-mono-tab text-fg">{n}</span></li>
                ))}
              </ul>
            </Card>
          )}

          {s.walk_forward && (
            <Card title="Does the history filter help?">
              <p className="text-xs text-muted mb-3">Confluence entries judged only by what that setup had done before the signal (this ticker blended with the whole universe, like the ranking). Out of sample.</p>
              <table className="w-full text-xs font-mono-tab">
                <thead>
                  <tr className="text-muted text-left">
                    <th className="font-normal pb-2">Sell by</th>
                    <th className="font-normal pb-2 text-right">History: yes</th>
                    <th className="font-normal pb-2 text-right">History: no</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {EXIT_ORDER.map((x) => {
                    const w = s.walk_forward[x]
                    if (!w) return null
                    const cell = (g) => <><span className={tone(g.avg)}>{pctS(g.avg)}</span><span className="text-muted"> · {share(g.winRate)} win · {g.closed}</span></>
                    return (
                      <tr key={x}>
                        <td className="py-2 text-fg font-sans">{EXIT_LABEL[x]}</td>
                        <td className="py-2 text-right">{cell(w.yes)}</td>
                        <td className="py-2 text-right">{cell(w.no)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </Card>
          )}

          {s.by_year && (
            <Card title="By year · Confluence + exit targets">
              <ul className="divide-y divide-hairline text-xs font-mono-tab">
                {Object.entries(s.by_year).map(([y, r]) => (
                  <li key={y} className="py-2 flex gap-3">
                    <span className="w-12 text-fg">{y}</span>
                    <span className="flex-1 text-muted">{r.n} trades · {share(r.winRate)} win</span>
                    <span className={tone(r.avg)}>{pctS(r.avg)}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted">Recent years have fewer closed trades — most are still open.</p>
            </Card>
          )}

          {s.missed?.length > 0 && (
            <Card title="Biggest missed moves" flush>
              <ul className="divide-y divide-hairline">
                {(allMissed ? s.missed : s.missed.slice(0, 15)).map((m) => (
                  <li key={`${m.ticker}${m.low}`}>
                    <Link to={`/charts/entry/${encodeURIComponent(m.ticker)}`} className="px-5 py-3 flex items-center gap-3 hover:bg-card-hover/40 transition">
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm text-fg"><span className="font-semibold">{m.ticker}</span> <span className="font-mono-tab text-subtle">{day(m.low)} → {day(m.peak)}</span></span>
                        <span className="block text-xs text-muted">{m.why}{m.best ? ` · best ${m.best}/5` : ''}</span>
                      </span>
                      <span className="text-sm font-semibold font-mono-tab text-green-400">{pctS(m.gain)}</span>
                      <ChevronRight size={14} className="text-muted" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
              {s.missed.length > 15 && (
                <button type="button" onClick={() => setAllMissed(!allMissed)} className="w-full min-h-[44px] border-t border-hairline text-xs font-semibold text-subtle hover:text-fg">
                  {allMissed ? 'Show fewer' : `Show all ${s.missed.length}`}
                </button>
              )}
            </Card>
          )}

          <p className="text-[11px] text-muted px-1">
            Option prices are Black-Scholes estimates from each stock&apos;s recent volatility, with 2% slippage per fill — real fills differ. Big moves are found with hindsight, only to grade the entries. Past results, not advice.
          </p>
        </>
      )}
    </div>
  )
}

function Card({ title, children, flush = false }) {
  return (
    <section className="bg-card border border-border rounded-2xl mb-4 overflow-hidden">
      <h2 className={clsx('text-sm font-semibold px-5 pt-5', flush ? 'pb-3' : 'pb-3')}>{title}</h2>
      <div className={flush ? '' : 'px-5 pb-5'}>{children}</div>
    </section>
  )
}
