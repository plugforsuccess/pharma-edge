import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { ChevronRight } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { COMPONENTS } from '../utils/confluence'

// Charts → Confluence leaders (owner, 2026-10-03; verdicts 2026-10-04: "it's
// not telling me how to enter"): the universe ranked nightly by
// scripts/rank-confluence.mjs. Every row carries a verdict — buy: ENTER (the
// buy zone is YES with 2+ signals and the 200-day rising) / WAIT (what's
// missing) / WATCH; sell: EXTENDED / TURNING — and an ENTER row shows the
// call the replay would price plus the structure stop. "Yours" = Tracking +
// holdings, ranked or not. Rows open the entry chart.
const LABEL = { buy: Object.fromEntries(COMPONENTS.buy), sell: Object.fromEntries(COMPONENTS.sell) }
const VERDICT = {
  enter: ['ENTER', 'border-green-400/50 text-green-400'],
  wait: ['WAIT', 'border-amber-400/50 text-amber-400'],
  watch: ['WATCH', 'border-border text-subtle'],
  extended: ['EXTENDED', 'border-suite-bear/50 text-suite-bear'],
  turning: ['TURNING', 'border-border text-subtle'],
}
const pct = (x) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`)
const money = (x, d = 2) => `$${Number(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`
const k = (x) => (x >= 1000 ? `$${(x / 1000).toFixed(1)}k` : money(x, 0))
const day = (t) => (t ? new Date(`${t}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '')
const monthYear = (t) => (t ? new Date(`${t}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : '')

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
      .select('ticker, side, as_of, close, score, lit, rank, est_3m, est_6m, own_n, pool_n, verdict, blockers, trade, stop_price')
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
  const horizon = side === 'buy' ? 'est_6m' : 'est_3m'
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
            ? 'ENTER = the buy zone is YES with 2+ signals and the 200-day rising. WAIT rows name what is still missing.'
            : '2+ sell signals at a high. For shares and spreads; a LEAPS follows its exit plan.'}
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
          {noEntry && <p className="px-5 pb-3 text-xs text-amber-400">Nothing meets the entry rule today. These are the closest setups and what each still needs.</p>}
          <ul className="border-t border-hairline divide-y divide-hairline">
            {list.map((r) => {
              const v = VERDICT[r.verdict]
              const trade = r.verdict === 'enter' ? r.trade : null
              const perContract = trade ? trade.cost * 100 : null
              return (
                <li key={r.ticker}>
                  <Link to={`/charts/entry/${encodeURIComponent(r.ticker)}`} className="px-5 py-3 flex items-center gap-3 hover:bg-card-hover/40 transition">
                    <span className={clsx('shrink-0 w-7 text-center text-xs font-semibold font-mono-tab', r.rank ? 'text-fg' : 'text-muted')}>{r.rank ? `#${r.rank}` : '—'}</span>
                    <span className="flex-1 min-w-0">
                      <span className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-fg">{r.ticker}</span>
                        {v && <span className={clsx('px-1.5 rounded border text-[11px] font-semibold tracking-wide', v[1])}>{v[0]}</span>}
                        <span className="text-xs text-muted font-mono-tab">{money(r.close)}</span>
                      </span>
                      <span className="block mt-0.5 text-xs text-subtle">
                        {r.score} of 5 {side === 'sell' ? 'sell ' : ''}signals
                        {side === 'buy' && r.verdict === 'wait' && r.blockers?.length > 0 && <> · <span className="text-amber-400">{r.blockers.map((b) => b.label).join(' · ')}</span></>}
                        {side === 'buy' && r.verdict === 'watch' && <> · <span className="text-subtle">200-day falling</span></>}
                        {side === 'sell' && r.lit?.length > 0 && <> · {r.lit.map((key) => LABEL.sell[key]).join(' · ')}</>}
                        {r.score === 0 && ' today'}
                      </span>
                      {trade && (
                        <span className="block mt-0.5 text-xs text-fg font-mono-tab">
                          Call · {money(trade.strike, 0)} strike · {monthYear(trade.expiry)} · ~{money(trade.cost)}/sh · {k(perContract)} a contract
                          {accountSize && <> · {(perContract / accountSize * 100).toFixed(1)}% of account</>}
                        </span>
                      )}
                      {side === 'buy' && r.verdict && r.stop_price != null && (
                        <span className="block mt-0.5 text-xs text-subtle font-mono-tab">Setup breaks below {money(r.stop_price)}</span>
                      )}
                      {side === 'sell' && r.verdict && (
                        <span className="block mt-0.5 text-xs text-subtle">Shares and spreads: a sell signal · LEAPS: your exit plan decides</span>
                      )}
                      {r[horizon] != null && (
                        <span className="block mt-0.5 text-[11px] text-muted font-mono-tab">
                          After this setup: {side === 'buy' ? '6M' : '3M'} <span className={r[horizon] < 0 ? 'text-rose-300' : 'text-green-400'}>{pct(r[horizon])}</span> avg · {r.own_n}× here, {r.pool_n}× universe
                        </span>
                      )}
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
        Option prices are model estimates (0.75 delta, ~2 years out), not quotes. Past stock returns, not advice. Rankings change after every close.
      </p>
    </section>
  )
}
