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
const ENTRIES = [['setup', 'Buy setup (as shown)'], ['triple', 'Triple ◆'], ['confluence', 'Confluence'], ['zone', 'Buy zone'], ['zoneConfirmed', 'Buy zone · momentum up'], ['bravo', 'Bravo ◆'], ['recovery', 'Recovery']]
const EXITS = [
  ['targets', 'Exit targets', '70% at 2x · 15% at 3x · trail the rest'],
  ['signals', 'Sell signals', 'All out on 2+ sell signals'],
  ['both', 'Both', '70% at 2x, then 2+ sell signals'],
]

export default function SignalRecord() {
  const [row, setRow] = useState(undefined)
  const [opt, setOpt] = useState(undefined)
  const [entry, setEntry] = useState('confluence')
  const [allMissed, setAllMissed] = useState(false)
  useEffect(() => {
    let cancelled = false
    supabase.from('replay_runs').select('run_at, as_of, tickers, summary').order('run_at', { ascending: false }).limit(1)
      .then(({ data, error }) => { if (!cancelled) setRow(error ? null : data?.[0] ?? null) })
    supabase.from('optimizer_runs').select('run_at, as_of, tickers, summary').order('run_at', { ascending: false }).limit(1)
      .then(({ data, error }) => { if (!cancelled) setOpt(error ? null : data?.[0]?.summary ?? null) })
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
          <PreregCard p={s.prereg} />
          <SwingCard sw={s.prereg?.swing} />
          {opt && <OptimizerCard o={opt} />}

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


// The swing exit grid (owner, 2026-10-05: "identify swing trades, exit at
// pre-determined high prices"): entry rule × {price target, hold cap, stop}
// → hit rate, days to the target, option return, by period / year, with
// the random-entry control beside the default variant.
const SWING_RULE_LABEL = { setup: 'Buy setup', confluence: 'Confluence', momentum: 'Momentum 12-1', triple: 'Triple ◆' }
const SWING_VIEWS = [['all', 'All'], ['P1', '2022–23'], ['P2', '2024→'], ['recent', 'Last 2 years']]
function SwingCard({ sw }) {
  const [rule, setRule] = useState('setup')
  const [view, setView] = useState('all')
  if (!sw) return null
  const r = sw.rules?.[rule]
  const months = (d) => (d >= 42 && d % 21 === 0 ? `${d / 21} mo` : `${d}d`)
  const variantLabel = (v) => `${v.target === 'pivot' ? 'Prior pivot high' : v.target === 'opt' ? `+${Math.round(v.pct * 100)}% on the call` : `+${Math.round(v.pct * 100)}% stock`} · ${months(v.maxHold)} cap${v.stopPct != null ? ` · ${Math.round(v.stopPct * 100)}% stop` : ''}`
  const years = Object.keys(r?.variants?.[sw.defaultKey]?.byYear ?? {}).sort()
  const recentYears = years.slice(-2)
  const pick = (vs) => {
    if (view === 'recent') {
      const lists = recentYears.map((y) => vs.byYear[y]).filter(Boolean)
      if (!lists.length) return null
      const n = lists.reduce((s, x) => s + x.n, 0)
      const w = (k) => (n ? lists.reduce((s, x) => s + (x[k] ?? 0) * x.n, 0) / n : null)
      return { n, hitRate: w('hitRate'), medDaysHit: lists[0].medDaysHit, avg: w('avg'), lostHalf: w('lostHalf'), hitAvg: w('hitAvg'), missAvg: w('missAvg') }
    }
    return vs[view]
  }
  const rows = (sw.variants ?? []).map((v) => ({ v, s: r?.variants?.[v.key] ? pick(r.variants[v.key]) : null }))
  const share = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`)
  return (
    <Card title="Swing exit">
      <div className="px-5 pb-3 text-xs text-muted">
        Same entries, a different exit: a stock price fixed at entry, all out on the first close at or above it, else at the hold cap. The question is the hit rate and what hits and misses returned on the call — by period, because the look-back may be too long.
      </div>
      <div className="px-5 pb-3 flex flex-wrap gap-1.5">
        {Object.keys(sw.rules ?? {}).map((k) => (
          <button key={k} type="button" onClick={() => setRule(k)} className={clsx('min-h-[32px] px-2.5 rounded-lg border text-[11px] font-semibold', rule === k ? 'border-violet-400/50 bg-violet-400/10 text-violet-300' : 'border-border text-muted')}>{SWING_RULE_LABEL[k] ?? k}</button>
        ))}
        <span className="flex-1" />
        {SWING_VIEWS.map(([k, label]) => (
          <button key={k} type="button" onClick={() => setView(k)} className={clsx('min-h-[32px] px-2.5 rounded-lg border text-[11px] font-semibold', view === k ? 'border-amber-400/50 bg-amber-400/10 text-amber-300' : 'border-border text-muted')}>{label}</button>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px] font-mono-tab">
          <thead><tr className="text-muted border-t border-hairline"><th className="text-left font-normal px-5 py-2">Exit</th><th className="text-right font-normal pr-3">Trades</th><th className="text-right font-normal pr-3">Hit</th><th className="text-right font-normal pr-3">Days</th><th className="text-right font-normal pr-3">Avg</th><th className="text-right font-normal pr-3">Hit avg</th><th className="text-right font-normal pr-3">Miss avg</th><th className="text-right font-normal pr-5">Lost ½</th></tr></thead>
          <tbody>
            {rows.map(({ v, s }) => (
              <tr key={v.key} className={clsx('border-t border-hairline', v.key === sw.defaultKey && 'bg-violet-400/[0.06]')}>
                <td className="px-5 py-1.5 text-fg whitespace-nowrap">{variantLabel(v)}{v.key === sw.defaultKey ? <span className="text-muted"> · default</span> : null}</td>
                <td className="text-right pr-3 text-subtle">{s?.n ?? '—'}</td>
                <td className={clsx('text-right pr-3', s?.hitRate >= 0.6 ? 'text-green-400' : 'text-fg')}>{share(s?.hitRate)}</td>
                <td className="text-right pr-3 text-subtle">{s?.medDaysHit ?? '—'}</td>
                <td className={clsx('text-right pr-3', tone(s?.avg))}>{pctS(s?.avg)}</td>
                <td className="text-right pr-3 text-green-400">{pctS(s?.hitAvg)}</td>
                <td className="text-right pr-3 text-rose-300">{pctS(s?.missAvg)}</td>
                <td className="text-right pr-5 text-subtle">{share(s?.lostHalf)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {r?.random && (
        <div className="px-5 py-3 border-t border-hairline text-[11px] text-muted">
          Random entries in the same months, same default exit ({r.random.reps} replications): hit rate {share(r.random.hitRate)}, avg {pctS(r.random.avg)} — the rule's hit rate sits at the {r.random.hitPercentile == null ? '—' : `${Math.round(r.random.hitPercentile * 100)}th`} percentile. Shown beside, not in front: the owner's question is the hit rate and the expectancy.
        </div>
      )}
    </Card>
  )
}

// The pre-registered test (docs/signal-engine/preregistration.md, recorded
// 2026-10-05 before the code existed): the buy setup as shown vs the same
// call on SPY bought the same day with the same exits, priced at the
// calibrated implied-vol premium with slippage by liquidity, open trades at
// their mark. Edge / no edge / inconclusive by the recorded rule.
const VERDICT_TONE = { edge: 'border-green-400/50 text-green-400', 'no edge': 'border-rose-300/50 text-rose-300', inconclusive: 'border-amber-400/50 text-amber-400' }
const PREREG_LABELS = { setup: 'Buy setup', zone: 'Buy zone', confluence: 'Confluence', triple: 'Triple ◆', momentum: 'Momentum 12-1', index: 'Index call' }
const PREREG_TEXT = {
  setup: 'Buy setup as shown (buy zone YES + 2 signals, 200-day rising)',
  zone: 'Buy zone turning YES',
  confluence: '2+ buy signals, 200-day rising',
  triple: 'Bravo + Echo + Tango all turning up within 2 days',
  momentum: 'Cross-sectional momentum: top decile of 12-month return (skipping the latest month) among names above their 200-day, at each month end',
  index: 'The SPY call bought at each month end — the benchmark as a rule (its "SPY same day" column is itself; read the random and DCA lines)',
}
function PreregCard({ p }) {
  const [completed, setCompleted] = useState(false)
  const [rule, setRule] = useState(null)
  if (!p) {
    return (
      <Card title="Pre-registered test">
        <div className="px-5 pb-5 text-sm text-subtle">Not run yet — it joins the Saturday replay (needs SPY bars and the IV calibration).</div>
      </Card>
    )
  }
  const pm = p.premium.calibrated
  const shownRule = rule ?? p.rule
  const rules = Object.keys(p.grid[String(pm ?? p.premium.grid?.[0])] ?? {})
  const g = pm != null ? p.grid[String(pm)]?.[shownRule] : null
  const per = g ? (completed ? g.completed : g.marked) : null
  const ci = (r) => (r.lo == null ? '—' : `${pctS(r.lo)} to ${pctS(r.hi)}`)
  return (
    <Card title="Pre-registered test">
      <div className="px-5 pb-4">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={clsx('px-2 py-0.5 rounded-md border text-[11px] font-semibold tracking-wide uppercase', VERDICT_TONE[p.verdict.verdict] ?? 'border-border text-subtle')}>{p.verdict.verdict}</span>
          <span className="text-xs text-subtle">{p.verdict.why}</span>
        </div>
        {rules.length > 1 && (
          <div className="mt-2 flex flex-wrap gap-1.5" role="tablist" aria-label="Rule">
            {rules.map((k) => (
              <button key={k} type="button" role="tab" aria-selected={shownRule === k} onClick={() => setRule(k)}
                className={clsx('min-h-[32px] px-2.5 rounded-lg border text-[11px] font-semibold transition',
                  shownRule === k ? 'border-violet-400/50 bg-violet-400/10 text-violet-300' : 'border-border text-muted hover:text-subtle')}>
                {PREREG_LABELS[k] ?? k}{k === p.rule ? ' · primary' : ''}
              </button>
            ))}
          </div>
        )}
        <p className="mt-2 text-xs text-muted">
          {PREREG_TEXT[shownRule] ?? shownRule} vs the same call on SPY bought the same day, same exits.
          {pm != null ? <> Priced at implied-vol premium <span className="font-mono-tab text-subtle">{pm.toFixed(2)}</span> (from {p.premium.samples.toLocaleString('en-US')} real-IV samples)</> : ' No calibrated premium yet (too little real IV history) — read nothing into the numbers below.'}, slippage by liquidity, every fill counted. {completed ? 'Completed trades only.' : 'Open trades at their mark.'}
        </p>
        <button type="button" onClick={() => setCompleted((v) => !v)} className="mt-2 min-h-[36px] text-xs text-violet-300 hover:text-violet-200">{completed ? 'Show every trade (open at its mark)' : 'Show completed trades only'}</button>
      </div>
      {per && (
        <div className="border-t border-hairline">
          {[['P1', '2022–23'], ['P2', '2024→'], ['all', 'All']].map(([k, label]) => {
            const r = per[k]
            if (!r) return null
            return (
              <div key={k} className="px-5 py-3 border-b border-hairline last:border-b-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-semibold text-fg">{label}</span>
                  <span className="text-[11px] text-muted font-mono-tab">{r.n} trades · {r.months} months{!r.sampleFloor && ' · under the sample floor'}</span>
                </div>
                <div className="mt-1.5 grid grid-cols-3 gap-2 text-[11px]">
                  <div><div className="text-muted uppercase tracking-[0.1em]">Strategy</div><div className={clsx('text-sm font-mono-tab', tone(r.strategy.mean))}>{pctS(r.strategy.mean)}</div><div className="text-muted">win {share(r.strategy.win)} · lost ½ {share(r.strategy.lostHalf)}</div></div>
                  <div><div className="text-muted uppercase tracking-[0.1em]">SPY same day</div><div className={clsx('text-sm font-mono-tab', tone(r.spy.mean))}>{pctS(r.spy.mean)}</div><div className="text-muted">lost ½ {share(r.spy.lostHalf)}</div></div>
                  <div><div className="text-muted uppercase tracking-[0.1em]">Difference</div><div className={clsx('text-sm font-mono-tab', tone(r.spy.diff))}>{pctS(r.spy.diff)}</div><div className="text-muted">95% CI {ci(r.spy)}</div></div>
                </div>
                <div className="mt-1.5 text-[11px] text-muted">
                  Random entries, same months: {r.random.percentile == null ? 'not run for this rule' : <>strategy at the <span className="font-mono-tab text-subtle">{Math.round(r.random.percentile * 100)}th</span> percentile of {r.random.reps} replications</>}
                  {' · '}vs monthly DCA: <span className={clsx('font-mono-tab', tone(r.dca.diff))}>{pctS(r.dca.diff)}</span> ({ci(r.dca)})
                </div>
              </div>
            )
          })}
          <div className="px-5 py-3 border-t border-hairline text-[11px] text-muted">
            <div>Difference vs SPY by premium (all trades): {p.premium.grid.map((x) => <span key={x} className="mr-2"><span className="font-mono-tab text-subtle">{Number(x).toFixed(2)}</span> {pctS(p.grid[String(x)]?.[shownRule]?.marked.all.spy.diff)}{Number(x) === 1 && ' (optimistic)'}</span>)}</div>
            {g.buckets && <div className="mt-1">By the market over each trade's own hold — {Object.entries(g.buckets).map(([k, b]) => <span key={k} className="mr-2">SPY {k}: {b.n} trades, strategy {pctS(b.strategy)} vs SPY {pctS(b.spy)}</span>)}</div>}
            <div className="mt-1">{shownRule === p.rule ? 'Rule recorded 2026-10-05 before the code existed.' : 'A secondary rule under the same test; the verdict above is the primary rule\'s.'} A positive result justifies buying delisted-inclusive data; it never changes a live rule by itself.</div>
          </div>
        </div>
      )}
    </Card>
  )
}

// The rule optimizer's latest run (optimizer_runs): the best rule found by
// searching entries × exits over the universe, judged out of sample. The
// app's live rules don't change here — this is the report.
function OptimizerCard({ o }) {
  const [showFrontier, setShowFrontier] = useState(false)
  const b = o.baseline
  const f = o.final
  const lift = f.validated?.avg != null && b.validated?.avg != null ? f.validated.avg - b.validated.avg : null
  return (
    <Card title="Best rule found">
      <div className="text-xs text-muted -mt-1 mb-3">
        {o.grid.entries} entries × {o.grid.exits} exits searched over {o.tickers} tickers. Chosen on earlier years, judged on later ones it never saw.
      </div>
      <div className="rounded-xl bg-bg-elev px-4 py-3">
        <div className="text-sm text-fg">{f.words}</div>
        <div className="mt-3 grid grid-cols-3 gap-3">
          <div>
            <div className={clsx('text-2xl font-semibold tracking-tight font-mono-tab leading-none', tone(f.validated?.avg))}>{pctS(f.validated?.avg)}</div>
            <div className="mt-1 text-[11px] text-muted">avg, out of sample</div>
          </div>
          <div>
            <div className="text-2xl font-semibold tracking-tight font-mono-tab leading-none text-fg">{share(f.validated?.win)}</div>
            <div className="mt-1 text-[11px] text-muted">win · {f.validated?.n ?? 0} trades</div>
          </div>
          <div>
            <div className="text-2xl font-semibold tracking-tight font-mono-tab leading-none text-fg">{share(f.catch)}</div>
            <div className="mt-1 text-[11px] text-muted">big moves caught</div>
          </div>
        </div>
        <div className="mt-3 text-xs text-subtle font-mono-tab">
          On everything: {share(f.all?.win)} win · {pctS(f.all?.avg)} avg · {share(f.all?.bigLoss)} lost ½+ · {f.all?.n} trades
        </div>
      </div>

      <div className="mt-4 flex items-baseline gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-sm text-fg">Today&apos;s rule</div>
          <div className="text-[11px] text-muted truncate">{b.words}</div>
        </div>
        <div className="text-right shrink-0">
          <div className={clsx('text-base font-semibold font-mono-tab', tone(b.validated?.avg))}>{pctS(b.validated?.avg)}</div>
          <div className="text-[11px] text-muted">{share(b.validated?.win)} win · {share(b.catch)} caught</div>
        </div>
      </div>
      {lift != null && (
        <div className={clsx('mt-2 text-xs', lift > 0.02 ? 'text-green-400' : lift < -0.02 ? 'text-rose-300' : 'text-subtle')}>
          {lift > 0.02 ? `The found rule did ${Math.round(lift * 100)} points better out of sample.` : lift < -0.02 ? `The found rule did ${Math.round(-lift * 100)} points worse out of sample — today's rule stands.` : 'No real difference out of sample — today\'s rule stands.'}
          {!o.stable && ' Different folds picked different rules, so treat this as a direction, not a setting.'}
        </div>
      )}

      <div className="mt-4 text-[11px] uppercase tracking-wider text-muted">Fold by fold</div>
      <ul className="mt-1 space-y-2">
        {o.folds.map((fd) => (
          <li key={fd.fold} className="text-xs">
            <div className="text-fg">Trained through {Number(fd.train_end.slice(0, 4)) - 1}, tested {fd.test_end === '9999-12-31' ? `${fd.train_end.slice(0, 4)} on` : fd.train_end.slice(0, 4)}</div>
            {fd.chosen ? (
              <div className="text-muted font-mono-tab">chosen rule {pctS(fd.chosen.test.avg)} avg · {share(fd.chosen.test.win)} win · {fd.chosen.test.n} trades — today&apos;s rule {pctS(fd.baseline.test.avg)}</div>
            ) : <div className="text-muted">Too few trades to choose</div>}
          </li>
        ))}
      </ul>

      {o.frontier?.length > 0 && (
        <>
          <button type="button" onClick={() => setShowFrontier(!showFrontier)} className="mt-4 min-h-[36px] text-xs font-semibold text-subtle hover:text-fg">
            {showFrontier ? 'Hide the trade-off' : 'Catch more vs. win more'}
          </button>
          {showFrontier && (
            <ul className="mt-1 divide-y divide-hairline">
              {o.frontier.map((p) => (
                <li key={p.words} className="py-2 flex items-center gap-3 text-xs">
                  <span className="w-12 shrink-0 font-mono-tab text-confluence">{share(p.catch)}</span>
                  <span className="flex-1 min-w-0 text-subtle truncate">{p.words}</span>
                  <span className={clsx('shrink-0 font-mono-tab', tone(p.avg))}>{pctS(p.avg)}</span>
                  <span className="w-10 shrink-0 text-right font-mono-tab text-muted">{share(p.win)}</span>
                </li>
              ))}
              <li className="pt-2 text-[11px] text-muted">Caught · rule · avg · win. Every row is the best you can do at that catch rate.</li>
            </ul>
          )}
        </>
      )}
      <div className="mt-3 text-[11px] text-muted">Nothing here changes the app&apos;s rules by itself.</div>
    </Card>
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
