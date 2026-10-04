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
const FEW_OWN = 5

function TrackRecord({ r, side }) {
  const avg = side === 'buy' ? r.est_6m : r.est_3m
  const win = side === 'buy' ? r.est_win_6m : r.est_win_3m
  if (avg == null || !r.pool_n) return null
  const months = side === 'buy' ? '6 months' : '3 months'
  const cases = `${r.pool_n.toLocaleString('en-US')} past cases, ${r.own_n < FEW_OWN ? 'only ' : ''}${r.own_n} on ${r.ticker}`
  if (r.pool_n < THIN_POOL) {
    return <span className="block mt-1 text-[11px] text-muted"><span className="font-semibold">Thin record:</span> too few past cases to trust · {cases}</span>
  }
  const dir = side === 'buy' ? 'higher' : 'lower'
  const toneAvg = side === 'buy' ? (avg >= 0 ? 'text-green-400' : 'text-rose-300') : (avg <= 0 ? 'text-green-400' : 'text-rose-300')
  return (
    <span className="block mt-1 text-[11px] text-muted">
      <span className="font-semibold">Track record:</span> when these signals lined up before, the stock was {dir} {months} later
      {win != null && <> <span className="text-subtle font-mono-tab">{pct0(win)}</span> of the time</>}, averaging <span className={clsx('font-mono-tab', toneAvg)}>{avg >= 0 ? '+' : '−'}{pct0(avg)}</span>
      {' · '}{cases}{r.verdict === 'enter' && ' · stock return, not the option’s'}
    </span>
  )
}

export default function ConfluenceLeaders({ mine = [] }) {
  const [side, setSide] = useState('buy')
  const [scope, setScope] = useState('all')
  const [rows, setRows] = useState(null)
  const [accountSize, setAccountSize] = useState(null)
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
      .select('ticker, side, as_of, close, score, rank, est_3m, est_6m, est_win_3m, est_win_6m, own_n, pool_n, verdict, blockers, trade, stop_price, momentum')
      .eq('side', side)
    q = scope === 'all'
      ? q.not('rank', 'is', null).order('rank').limit(10)
      : q.in('ticker', mine.length ? mine : ['—']).order('score', { ascending: false }).limit(40)
    q.then(({ data, error }) => { if (!cancelled) setRows(error ? [] : data ?? []) })
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
            ? 'BUY SETUP means the app’s entry rule is met today. NOT YET rows say what is still missing.'
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
              return (
                <li key={r.ticker}>
                  <Link to={`/charts/entry/${encodeURIComponent(r.ticker)}`} className="px-5 py-3 flex items-center gap-3 hover:bg-card-hover/40 transition">
                    <span className={clsx('shrink-0 w-7 text-center text-xs font-semibold font-mono-tab', r.rank ? 'text-fg' : 'text-muted')}>{r.rank ? `#${r.rank}` : '—'}</span>
                    <span className="flex-1 min-w-0">
                      <span className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-fg">{r.ticker}</span>
                        <span className="text-xs text-muted font-mono-tab">{money(r.close)}</span>
                        {v && <span className={clsx('px-1.5 rounded border text-[11px] font-semibold tracking-wide', v[1])}>{v[0]}{r.verdict === 'enter' && (r.momentum === 'up' ? ' · CONFIRMED' : r.momentum === 'down' ? ' · EARLY' : '')}</span>}
                      </span>
                      {trade && (
                        <span className="block mt-1 text-sm text-fg">
                          Buy the {monthYear(trade.expiry)} {money(trade.strike, 0)} call — {about(perContract)} per contract
                          {accountSize && <span className="text-subtle"> · {(perContract / accountSize * 100).toFixed(1)}% of your account</span>}
                        </span>
                      )}
                      {r.verdict === 'enter' && r.momentum && (
                        <span className={clsx('block mt-0.5 text-xs', r.momentum === 'up' ? 'text-green-400' : 'text-amber-400')}>
                          {r.momentum === 'up' ? 'The pullback has turned up — a confirmed entry.' : 'Still falling — the rule buys now; a cautious entry waits for it to turn up.'}
                        </span>
                      )}
                      {r.verdict === 'wait' && blockers.length > 0 && (
                        <span className="block mt-1 text-sm text-amber-400">
                          {blockers.length === 1 ? 'Waiting on one thing: ' : 'Waiting on: '}{blockers.join(' · ')}
                        </span>
                      )}
                      {r.verdict === 'watch' && <span className="block mt-1 text-sm text-subtle">Signals, but the long-term trend is falling — the rule doesn’t buy here.</span>}
                      {side === 'buy' && r.verdict === 'enter' && r.stop_price != null && (
                        <span className="block mt-0.5 text-xs text-subtle">Exit if it closes below <span className="font-mono-tab text-fg">{money(r.stop_price)}</span></span>
                      )}
                      {side === 'sell' && r.verdict && (
                        <span className="block mt-1 text-sm text-subtle">
                          {r.verdict === 'extended' ? 'Stretched after a run — ' : 'Momentum fading — '}
                          sell signal for shares and spreads · a LEAPS follows its exit plan
                        </span>
                      )}
                      <span className="block mt-0.5 text-[11px] text-muted">{r.score} of 5 signals{r.verdict ? '' : ' today'}</span>
                      <TrackRecord r={r} side={side} />
                    </span>
                    <ChevronRight size={15} className="shrink-0 text-muted" aria-hidden />
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
