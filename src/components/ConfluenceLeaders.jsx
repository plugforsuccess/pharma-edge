import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { ChevronRight } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { COMPONENTS } from '../utils/confluence'

// Charts → Confluence leaders (owner, 2026-10-03): the universe ranked
// nightly by scripts/rank-confluence.mjs — lows (buy) and extended highs
// (sell) where several signals agree and the setup's history (this ticker
// blended with the whole universe) shows an edge. "Yours" = Tracking +
// holdings, ranked or not. Rows open the entry chart.
const LABEL = { buy: Object.fromEntries(COMPONENTS.buy), sell: Object.fromEntries(COMPONENTS.sell) }
const pct = (x) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`)
const share = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`)
const day = (t) => (t ? new Date(`${t}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '')

export default function ConfluenceLeaders({ mine = [] }) {
  const [side, setSide] = useState('buy')
  const [scope, setScope] = useState('all')
  const [rows, setRows] = useState(null)
  const mineKey = mine.join(',')

  useEffect(() => {
    let cancelled = false
    setRows(null)
    let q = supabase.from('confluence_ranks')
      .select('ticker, side, as_of, close, score, lit, rank, est_3m, est_6m, est_at_turn, est_win_6m, own_n, pool_n, conditions_met, etb_convergence')
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

  return (
    <section className="bg-card border border-border rounded-2xl mb-5 overflow-hidden">
      <div className="px-5 pt-5 pb-3">
        <div className="flex items-baseline gap-2">
          <h2 className="flex-1 text-sm font-semibold">Confluence leaders</h2>
          {asOf && <span className="text-[11px] text-muted">as of {day(asOf)}</span>}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <div className="flex gap-0.5 p-0.5 rounded-lg bg-bg-elev" role="tablist" aria-label="Side">
            {[['buy', 'Lows · buy'], ['sell', 'Highs · sell']].map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={side === k} onClick={() => setSide(k)}
                className={clsx('min-h-[36px] px-2.5 rounded-md text-xs font-semibold transition whitespace-nowrap',
                  side === k ? (k === 'buy' ? 'bg-card text-confluence shadow-sm' : 'bg-card text-suite-bear shadow-sm') : 'text-muted hover:text-subtle')}>{label}</button>
            ))}
          </div>
          <span className="flex-1" />
          <div className="flex gap-0.5 p-0.5 rounded-lg bg-bg-elev" role="tablist" aria-label="Which tickers">
            {[['all', 'Top 10'], ['mine', 'Yours']].map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={scope === k} onClick={() => setScope(k)}
                className={clsx('min-h-[36px] px-2.5 rounded-md text-xs font-semibold transition whitespace-nowrap', scope === k ? 'bg-card text-fg shadow-sm' : 'text-muted hover:text-subtle')}>{label}</button>
            ))}
          </div>
        </div>
        <p className="mt-2 text-xs text-muted">
          {side === 'buy'
            ? 'Lows where 2+ buy signals agree and the 200-day is rising. Echo, Tango and Bravo converging within 10 days ranks first, then most signals.'
            : 'Extended highs where 2+ sell signals agree. Most signals first.'}
        </p>
      </div>
      {list === null ? (
        <div className="px-5 pb-5 space-y-2" aria-busy="true">{[0, 1, 2].map((k) => <div key={k} className="h-14 rounded-xl bg-bg-elev animate-pulse" />)}</div>
      ) : list.length === 0 ? (
        <div className="px-5 pb-5 text-sm text-subtle">
          {scope === 'mine' ? (mine.length ? 'None of your tickers have signals today.' : 'Add tickers to Tracking or Portfolio to see them here.')
            : 'No rankings yet — they run after each close.'}
        </div>
      ) : (
        <ul className="border-t border-hairline divide-y divide-hairline">
          {list.map((r) => (
            <li key={r.ticker}>
              <Link to={`/charts/entry/${encodeURIComponent(r.ticker)}`} className="px-5 py-3 flex items-center gap-3 hover:bg-card-hover/40 transition">
                <span className={clsx('shrink-0 w-7 text-center text-xs font-semibold font-mono-tab', r.rank ? 'text-fg' : 'text-muted')}>{r.rank ? `#${r.rank}` : '—'}</span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-baseline gap-2">
                    <span className="text-sm font-semibold text-fg">{r.ticker}</span>
                    <span className={clsx('text-xs font-mono-tab', r.score >= 3 ? (side === 'buy' ? 'text-confluence' : 'text-suite-bear') : 'text-subtle')}>{r.score}/5</span>
                    {side === 'buy' && r.etb_convergence && (
                      <span className="shrink-0 px-1.5 rounded border border-confluence/40 text-confluence text-[11px] font-semibold tracking-wide" title="Echo, Tango and Bravo bull signals within 10 trading days">E+T+B</span>
                    )}
                    <span className="text-xs text-muted truncate">{r.lit.map((k) => LABEL[side][k]).join(' · ')}</span>
                  </span>
                  <span className="block mt-0.5 text-xs text-muted font-mono-tab">
                    {r.est_at_turn != null && <>{share(r.est_at_turn)} at a {side === 'buy' ? 'low' : 'high'} · </>}
                    {side === 'buy' ? '6M' : '3M'} <span className={r[horizon] == null ? '' : r[horizon] < 0 ? 'text-rose-300' : 'text-green-400'}>{pct(r[horizon])}</span>
                    {' · '}{r.own_n}× here, {r.pool_n}× universe
                  </span>
                </span>
                <ChevronRight size={15} className="shrink-0 text-muted" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link to="/charts/record" className="px-5 py-3 border-t border-hairline flex items-center gap-2 text-xs text-subtle hover:text-fg">
        <span className="flex-1">Signal record: how these signals traded as LEAPS, every ticker</span>
        <ChevronRight size={14} aria-hidden />
      </Link>
      <p className="px-5 pb-3 text-[11px] text-muted">
        Past stock returns, not option returns, and not advice. Rankings change after every close.
      </p>
    </section>
  )
}
