import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { ChevronRight } from 'lucide-react'
import { supabase } from '../lib/supabase'

// Charts → Confluence leaders (owner, 2026-10-03; verdicts 2026-10-04: "it's
// not telling me how to enter"; plain words 2026-10-04: "a novice user may
// find this confusing"): the universe ranked nightly by
// scripts/rank-confluence.mjs. Each row answers three questions in plain
// English — what to do, what it costs, when you're wrong — and one muted
// track-record line. Buy: BUY SETUP (early / confirmed) · NOT YET (what's
// missing, in words) · NOT IN AN UPTREND. Sell: STRETCHED · LOSING STEAM.
// Indicator names, per-share prices and the blended-history mechanics stay
// on the entry chart, which every row opens.
const VERDICT = {
  enter: ['BUY SETUP', 'border-green-400/50 text-green-400'],
  wait: ['NOT YET', 'border-amber-400/50 text-amber-400'],
  watch: ['NOT IN AN UPTREND', 'border-border text-subtle'],
  extended: ['STRETCHED', 'border-suite-bear/50 text-suite-bear'],
  turning: ['LOSING STEAM', 'border-border text-subtle'],
}
// What a missing buy-zone condition means, in words (the nightly row keeps
// the indicator version for the entry chart).
const PLAIN = {
  iv: 'options are too expensive right now',
  rsi: "hasn't pulled back enough",
  trend: 'short-term trend still down',
  rising: 'long-term trend is falling',
}
const plainBlocker = (b) => (b.k === 'band' ? (/^Fall/.test(b.need ?? '') ? 'too far above its trend line' : 'too far below its trend line') : PLAIN[b.k] ?? b.label)
const money = (x, d = 2) => `$${Number(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`
// "about $1,200" — nearest $100 from $1,000, nearest $10 below.
const about = (x) => `about ${money(x >= 1000 ? Math.round(x / 100) * 100 : Math.round(x / 10) * 10, 0)}`
const pct0 = (x) => `${Math.round(Math.abs(x) * 100)}%`
const day = (t) => (t ? new Date(`${t}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '')
const monthYear = (t) => (t ? new Date(`${t}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : '')
const THIN_POOL = 30
// Under this much room to the stop the row says the entry is at the edge of the zone.
const EDGE_ROOM = 0.03
const FEW_OWN = 5

// Five segments, one per signal (filled = lit today).
function SignalMeter({ score, side }) {
  const on = side === 'buy' ? 'bg-confluence' : 'bg-suite-bear'
  return (
    <span className="inline-flex items-center gap-1" aria-label={`${score} of 5 signals`}>
      <span className="flex gap-[3px]">{[0, 1, 2, 3, 4].map((i) => <span key={i} className={clsx('h-1.5 w-3 rounded-sm', i < score ? on : 'bg-border')} />)}</span>
      <span className="text-[11px] text-muted font-mono-tab">{score}/5</span>
    </span>
  )
}

// Plain sentences, each number with its context: how often the pattern
// appeared, how often it worked against how often any random day worked,
// the typical result, the bad quarter, beat the market, and that the call
// moves more than the stock.
function TrackRecord({ r, side, baseline }) {
  const H = side === 'buy' ? '6m' : '3m'
  const avg = r[`est_${H}`]
  const win = r[`est_win_${H}`]
  const med = r[`est_med_${H}`]
  const badq = r[`est_badq_${H}`]
  const beat = r[`est_beat_${H}`]
  if (avg == null || !r.pool_n) return null
  const t = r.verdict === 'enter' ? r.trade : null
  const levRaw = t && t.cost > 0 && r.close > 0 ? (t.delta * r.close) / t.cost : null
  const lev = levRaw ? (levRaw < 3 ? levRaw.toFixed(1) : String(Math.round(levRaw))) : null
  const times = (k) => (k === 1 ? 'once' : k === 2 ? 'twice' : `${k.toLocaleString('en-US')} times`)
  const own = r.own_n === 0 ? `never on ${r.ticker}` : `${times(r.own_n)} on ${r.ticker}`
  const num = (x, cls = 'text-fg') => <span className={clsx('font-mono-tab', cls)}>{x}</span>
  const seen = <>Seen {num(times(r.pool_n), 'text-subtle')} across all stocks ({own}).</>
  if (r.pool_n < THIN_POOL) return <p className="mt-2 text-[11px] leading-4 text-muted">{seen} Too few to judge.</p>
  const months = side === 'buy' ? 'Six' : 'Three'
  const dir = side === 'buy' ? 'higher' : 'lower'
  const baseWin = baseline?.[`win_${H}`]
  const vs = baseWin == null || win == null ? null
    : win - baseWin > 0.08 ? 'better than' : win - baseWin < -0.08 ? 'worse than' : 'about the same as'
  const good = (x) => (side === 'buy' ? x >= 0 : x <= 0)
  const signed = (x) => `${x >= 0 ? '+' : '−'}${pct0(x)}`
  // The bad quarter reads as a loss for buys, a rise for sells.
  const badText = badq == null ? null
    : side === 'buy'
      ? (badq < 0 ? <>one case in four lost more than {num(pct0(badq), 'text-rose-300')}</> : <>even the worst quarter of cases gained {num(pct0(badq), 'text-green-400')} or more</>)
      : (badq > 0 ? <>one case in four rose more than {num(pct0(badq), 'text-rose-300')}</> : <>even the worst quarter of cases fell {num(pct0(badq), 'text-green-400')} or more</>)
  return (
    <p className="mt-2 text-[11px] leading-4 text-muted">
      {seen}{' '}
      {months} months later the stock was {dir} {num(pct0(win))} of the time
      {vs && <> — {vs} any random day ({num(pct0(baseWin), 'text-subtle')})</>}.
      {med != null && <> The typical result was {num(signed(med), good(med) ? 'text-green-400' : 'text-rose-300')}</>}
      {med != null && badText && <>; {badText}</>}{med != null && '.'}
      {beat != null && <> It {side === 'buy' ? 'beat' : 'fell behind'} the S&P 500 {num(pct0(beat))} of the time.</>}
      {lev && <> A call like this moves about {num(`${lev}×`, 'text-subtle')} the stock.</>}
    </p>
  )
}

// What the app's own rule did on this very stock — ahead of the pattern's
// record across all stocks, and flagged when the two disagree.
function OwnRecord({ r }) {
  const o = r.own_record
  if (!o) return null
  const z = o.zone
  const num = (x, cls = 'text-fg') => <span className={clsx('font-mono-tab', cls)}>{x}</span>
  const signed = (x) => `${x >= 0 ? '+' : '−'}${pct0(x)}`
  const tone = (x) => (x >= 0 ? 'text-green-400' : 'text-rose-300')
  const times = (k) => (k === 1 ? 'once' : k === 2 ? 'twice' : `${k} times`)
  const monthOf = (t) => new Date(`${t}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
  const poolWin = r.est_win_6m
  // The pattern looks fine but this stock's own trades lost: say so.
  const disagree = z.closed >= 1 && z.avg != null && z.avg < 0 && poolWin != null && poolWin >= 0.55
  const rallies = o.moves?.n ? <> It caught {num(`${o.moves.caught} of ${o.moves.n}`)} of {r.ticker}’s big rallies{o.moves.why?.['already holding'] ? <> ({o.moves.why['already holding']} missed while holding an earlier, losing entry)</> : null}.</> : null
  if (z.n === 0) {
    return (
      <p className="mt-2 text-[11px] leading-4 text-muted">
        <span className="text-subtle font-semibold">On {r.ticker} itself:</span> this is the first time the rule has fired in 5 years
        {o.confluence.closed > 0 && <>; the broader 2-signal version fired {times(o.confluence.n)}, {o.confluence.wins} of {o.confluence.closed} made money (avg {num(signed(o.confluence.avg), tone(o.confluence.avg))} on the call)</>}.
        {rallies}
      </p>
    )
  }
  return (
    <p className={clsx('mt-2 text-[11px] leading-4', disagree ? 'text-amber-400' : 'text-muted')}>
      <span className={clsx('font-semibold', disagree ? 'text-amber-400' : 'text-subtle')}>On {r.ticker} itself:</span> this rule has fired {num(times(z.n), disagree ? 'text-amber-400' : 'text-subtle')} in 5 years
      {z.closed > 0 && <> — {num(`${z.wins} of ${z.closed}`, disagree ? 'text-amber-400' : 'text-fg')} made money, averaging {num(signed(z.avg), tone(z.avg))} on the call</>}
      {z.open && <>; the {monthOf(z.open.signal)} entry is still open at {num(signed(z.open.option), tone(z.open.option))}</>}.
      {!z.open && o.confluence.open && <> A {monthOf(o.confluence.open.signal)} entry on similar signals is still open at {num(signed(o.confluence.open.option), tone(o.confluence.open.option))}.</>}
      {rallies}
      {disagree && <> <span className="font-semibold">{r.ticker}’s own history disagrees with the pattern’s record below.</span></>}
    </p>
  )
}

function Fact({ label, value, tone = 'text-fg' }) {
  return (
    <span className="min-w-0">
      <span className="block text-[11px] uppercase tracking-[0.12em] text-muted font-semibold">{label}</span>
      <span className={clsx('block text-sm leading-5 truncate', tone)}>{value}</span>
    </span>
  )
}

export default function ConfluenceLeaders({ mine = [] }) {
  const [side, setSide] = useState('buy')
  const [scope, setScope] = useState('all')
  const [rows, setRows] = useState(null)
  const [accountSize, setAccountSize] = useState(null)
  const [baseline, setBaseline] = useState(null)
  const mineKey = mine.join(',')

  useEffect(() => {
    let cancelled = false
    supabase.auth.getUser().then(({ data }) => {
      if (!data?.user) return
      return supabase.from('profiles').select('account_size').eq('id', data.user.id).maybeSingle()
        .then(({ data: p }) => { if (!cancelled && p?.account_size > 0) setAccountSize(Number(p.account_size)) })
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    setRows(null)
    let q = supabase.from('confluence_ranks')
      .select('ticker, side, as_of, close, score, rank, est_3m, est_6m, est_win_3m, est_win_6m, own_n, pool_n, verdict, blockers, trade, stop_price, momentum, own_record, est_med_3m, est_med_6m, est_badq_3m, est_badq_6m, est_beat_3m, est_beat_6m')
      .eq('side', side)
    q = scope === 'all'
      ? q.not('rank', 'is', null).order('rank').limit(10)
      : q.in('ticker', mine.length ? mine : ['—']).order('score', { ascending: false }).limit(40)
    q.then(({ data, error }) => { if (!cancelled) setRows(error ? [] : data ?? []) })
    // The baseline the record is read against: every ticker, every day.
    supabase.from('confluence_pool').select('win_3m, win_6m, med_3m, med_6m').eq('side', side).eq('combo', '__any_day__').maybeSingle()
      .then(({ data }) => { if (!cancelled) setBaseline(data ?? null) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, scope, mineKey])

  // Yours: ranked first, then by score.
  const list = useMemo(() => (scope === 'all' ? rows : rows && [...rows].sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || b.score - a.score)), [rows, scope])
  const asOf = rows?.[0]?.as_of
  const noEntry = side === 'buy' && scope === 'all' && list?.length > 0 && !list.some((r) => r.verdict === 'enter')

  return (
    <section className="bg-card border border-border rounded-2xl mb-5 overflow-hidden">
      <div className="px-5 pt-5 pb-3">
        <div className="flex items-baseline gap-2">
          <h2 className="flex-1 text-sm font-semibold">Confluence leaders</h2>
          {asOf && <span className="text-[11px] text-muted">as of {day(asOf)}</span>}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <div className="flex gap-0.5 p-0.5 rounded-lg bg-bg-elev" role="tablist" aria-label="Side">
            {[['buy', 'Lows · buy'], ['sell', 'Highs · sell']].map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={side === key} onClick={() => setSide(key)}
                className={clsx('min-h-[36px] px-2.5 rounded-md text-xs font-semibold transition whitespace-nowrap',
                  side === key ? (key === 'buy' ? 'bg-card text-confluence shadow-sm' : 'bg-card text-suite-bear shadow-sm') : 'text-muted hover:text-subtle')}>{label}</button>
            ))}
          </div>
          <span className="flex-1" />
          <div className="flex gap-0.5 p-0.5 rounded-lg bg-bg-elev" role="tablist" aria-label="Which tickers">
            {[['all', 'Top 10'], ['mine', 'Yours']].map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={scope === key} onClick={() => setScope(key)}
                className={clsx('min-h-[36px] px-2.5 rounded-md text-xs font-semibold transition whitespace-nowrap', scope === key ? 'bg-card text-fg shadow-sm' : 'text-muted hover:text-subtle')}>{label}</button>
            ))}
          </div>
        </div>
        <p className="mt-2 text-xs text-muted">
          {side === 'buy'
            ? 'BUY SETUP = the entry rule is met today. EARLY = momentum is still falling; the rule buys anyway, a cautious entry waits for it to rise. NOT YET = what’s still missing.'
            : 'Stocks showing 2+ sell signals near a high. For shares and spreads; a LEAPS follows its exit plan.'}
        </p>
      </div>
      {list === null ? (
        <div className="px-5 pb-5 space-y-2" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="h-14 rounded-xl bg-bg-elev animate-pulse" />)}</div>
      ) : list.length === 0 ? (
        <div className="px-5 pb-5 text-sm text-subtle">
          {scope === 'mine' ? (mine.length ? 'None of your tickers have signals today.' : 'Add tickers to Tracking or Portfolio to see them here.')
            : 'No rankings yet — they run after each close.'}
        </div>
      ) : (
        <>
          {noEntry && <p className="px-5 pb-3 text-xs text-amber-400">No stock meets the entry rule today. These are the closest, and what each still needs.</p>}
          <ul className="border-t border-hairline divide-y divide-hairline">
            {list.map((r) => {
              const v = VERDICT[r.verdict]
              const trade = r.verdict === 'enter' ? r.trade : null
              const perContract = trade ? trade.cost * 100 : null
              const blockers = (r.blockers ?? []).map(plainBlocker)
              const room = r.stop_price != null && r.close > 0 ? 1 - r.stop_price / r.close : null
              const edge = room != null && room < EDGE_ROOM
              return (
                <li key={r.ticker}>
                  <Link to={`/charts/entry/${encodeURIComponent(r.ticker)}`} className="block px-5 py-4 hover:bg-card-hover/40 transition">
                    {/* Identity */}
                    <span className="flex items-center gap-2.5">
                      <span className={clsx('shrink-0 text-[11px] font-semibold font-mono-tab', r.rank ? 'text-muted' : 'text-muted/60')}>{r.rank ? `#${r.rank}` : '—'}</span>
                      <span className="text-base font-semibold text-fg leading-6">{r.ticker}</span>
                      <span className="text-xs text-subtle font-mono-tab">{money(r.close)}</span>
                      <span className="flex-1" />
                      {v && (
                        <span className={clsx('px-2 py-0.5 rounded-md border text-[11px] font-semibold tracking-wide whitespace-nowrap', v[1])}>
                          {v[0]}
                        </span>
                      )}
                      <ChevronRight size={15} className="shrink-0 text-muted" aria-hidden />
                    </span>

                    {/* The instruction */}
                    {trade && (
                      <span className="mt-3 flex items-end gap-3 rounded-xl bg-bg-elev px-3.5 py-3">
                        <span className="flex-1 min-w-0">
                          <span className="block text-[11px] uppercase tracking-[0.12em] text-muted font-semibold">Buy</span>
                          <span className="block text-sm font-semibold text-fg leading-5">{monthYear(trade.expiry)} {money(trade.strike, 0)} call</span>
                        </span>
                        <span className="text-right">
                          <span className="block text-base font-semibold text-fg font-mono-tab leading-6">{about(perContract).replace('about ', '≈')}</span>
                          <span className="block text-[11px] text-muted">per contract{accountSize && ` · ${(perContract / accountSize * 100).toFixed(1)}% of account`}</span>
                        </span>
                      </span>
                    )}
                    {r.verdict === 'wait' && blockers.length > 0 && (
                      <span className="mt-3 block rounded-xl bg-bg-elev px-3.5 py-3">
                        <span className="block text-[11px] uppercase tracking-[0.12em] text-muted font-semibold">{blockers.length === 1 ? 'Waiting on one thing' : 'Waiting on'}</span>
                        <span className="block text-sm text-amber-400 leading-5">{blockers.join(' · ')}</span>
                      </span>
                    )}
                    {r.verdict === 'watch' && (
                      <span className="mt-3 block rounded-xl bg-bg-elev px-3.5 py-3 text-sm text-subtle leading-5">Signals, but the long-term trend is falling — the rule doesn’t buy here.</span>
                    )}
                    {side === 'sell' && r.verdict && (
                      <span className="mt-3 block rounded-xl bg-bg-elev px-3.5 py-3">
                        <span className="block text-[11px] uppercase tracking-[0.12em] text-muted font-semibold">{r.verdict === 'extended' ? 'Stretched after a run' : 'Momentum fading'}</span>
                        <span className="block text-sm text-fg leading-5">Sell signal for shares and spreads · a LEAPS follows its exit plan</span>
                      </span>
                    )}

                    {/* Two facts */}
                    {trade && (
                      <span className="mt-3 grid grid-cols-2 gap-3">
                        <Fact label="Momentum" value={r.momentum === 'up' ? 'Rising · confirmed' : 'Falling · early'} tone={r.momentum === 'up' ? 'text-green-400' : 'text-amber-400'} />
                        {r.stop_price != null && (
                          <Fact label="Exit below" tone={edge ? 'text-amber-400' : 'text-fg'}
                            value={<><span className="font-mono-tab">{money(r.stop_price)}</span>{room != null && <span className={clsx('text-xs', edge ? 'text-amber-400' : 'text-muted')}> · {(room * 100).toFixed(1)}% away</span>}</>} />
                        )}
                      </span>
                    )}
                    {trade && edge && <span className="mt-1.5 block text-[11px] text-amber-400">This entry sits at the bottom edge of the buy zone.</span>}

                    {/* Signals + record */}
                    <span className="mt-3 block"><SignalMeter score={r.score} side={side} /></span>
                    {side === 'buy' && r.verdict === 'enter' && <OwnRecord r={r} />}
                    <TrackRecord r={r} side={side} baseline={baseline} />
                  </Link>
                </li>
              )
            })}
          </ul>
        </>
      )}
      <Link to="/charts/record" className="px-5 py-3 border-t border-hairline flex items-center gap-2 text-xs text-subtle hover:text-fg">
        <span className="flex-1">Signal record: how these signals traded as LEAPS, every ticker</span>
        <ChevronRight size={14} aria-hidden />
      </Link>
      <p className="px-5 pb-3 text-[11px] text-muted">
        Option prices are estimates, not quotes. Past results are the stock’s, not advice. Rankings change after every close.
      </p>
    </section>
  )
}
