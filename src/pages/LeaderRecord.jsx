import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { ArrowLeft, ChevronRight } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { stintSummary } from '../utils/leaderRecord'

// /charts/leader-record — the leader record (owner, 2026-10-19: "a live
// record of the price gain since becoming a leader"). Every stock that joined
// the Leaders list in the past year: the close the day it joined, today's
// close (or the close the day it left), the change, and the S&P 500 over the
// same days. Rebuilt each night by the ranking (leader_stints).
const pctS = (x) => (x == null ? '—' : Math.abs(x) < 0.0005 ? '0%' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(Math.abs(x) < 0.1 ? 1 : 0)}%`)
const day = (t) => (t ? new Date(`${t}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '')
const span = (d) => (d === 0 ? 'today' : d < 10 ? `${d} ${d === 1 ? 'day' : 'days'}` : `${Math.round(d / 5)} weeks`)
const of10 = (x) => (x == null ? '—' : `${Math.round(x * 10)} of 10`)

function Stat({ label, value, sub, tone = 'text-fg' }) {
  return (
    <div className="rounded-2xl bg-bg-elev px-3.5 py-3 min-w-0">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={clsx('mt-0.5 text-base font-semibold font-mono-tab leading-6 truncate', tone)}>{value}</div>
      {sub && <div className="text-[11px] text-muted truncate">{sub}</div>}
    </div>
  )
}

export default function LeaderRecord() {
  const [rows, setRows] = useState(undefined)
  const [tab, setTab] = useState('open')
  useEffect(() => {
    let cancelled = false
    supabase.from('leader_stints').select('as_of').order('as_of', { ascending: false }).limit(1)
      .then(({ data, error }) => {
        if (cancelled) return
        const asOf = data?.[0]?.as_of
        if (error || !asOf) { setRows(null); return }
        supabase.from('leader_stints').select('*').eq('as_of', asOf).order('joined_on', { ascending: false }).limit(3000)
          .then(({ data: d, error: e }) => { if (!cancelled) setRows(e ? null : d ?? []) })
      })
    return () => { cancelled = true }
  }, [])
  const list = useMemo(() => (rows ?? []).filter((r) => (tab === 'open' ? r.open : !r.open)), [rows, tab])
  const sum = useMemo(() => stintSummary(list.map((r) => ({ gain: r.gain == null ? null : Number(r.gain), spy_gain: r.spy_gain == null ? null : Number(r.spy_gain) }))), [list])
  const asOf = rows?.[0]?.as_of
  const openN = (rows ?? []).filter((r) => r.open).length

  return (
    <div className="max-w-md mx-auto px-4 pt-4 pb-28">
      <Link to="/charts" className="min-h-[44px] -ml-1 inline-flex items-center gap-1.5 text-sm text-subtle hover:text-fg">
        <ArrowLeft size={16} aria-hidden /> Leaders
      </Link>
      <div className="mt-1 text-[11px] text-muted">{asOf ? `As of ${day(asOf)} close` : 'Updated after each close'}</div>
      <h1 className="mt-0.5 text-[28px] leading-9 font-semibold tracking-tight">Leader record</h1>
      <p className="text-sm text-subtle">How each stock’s price has moved since it joined the Leaders list.</p>

      <div className="mt-4 flex gap-2">
        {[['open', `On the list${rows ? ` · ${openN}` : ''}`], ['closed', `Left the list${rows ? ` · ${rows.length - openN}` : ''}`]].map(([k, label]) => (
          <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k)}
            className={clsx('shrink-0 min-h-[36px] px-3.5 rounded-full text-[13px] font-semibold transition whitespace-nowrap',
              tab === k ? 'bg-fg text-bg' : 'bg-card border border-border text-subtle hover:text-fg')}>{label}</button>
        ))}
      </div>

      {rows === undefined ? (
        <div className="mt-4 h-40 rounded-2xl bg-card border border-border animate-pulse" aria-busy="true" />
      ) : rows === null || rows.length === 0 ? (
        <div className="mt-4 rounded-2xl bg-card border border-border p-5 text-sm text-subtle">The record fills in after the next nightly update.</div>
      ) : (
        <>
          {sum.n > 0 && (
            <div className="mt-4 grid grid-cols-2 gap-2">
              <Stat label={tab === 'open' ? 'Typical change since joining' : 'Typical change while a leader'} value={pctS(sum.median)} tone={sum.median == null ? 'text-fg' : sum.median >= 0 ? 'text-green-400' : 'text-red-400'} sub={`${sum.n} ${sum.n === 1 ? 'stock' : 'stocks'}`} />
              <Stat label="Higher than when it joined" value={of10(sum.higher)} sub={`S&P 500 typical ${pctS(sum.spyMedian)}`} />
              <Stat label="Beat the S&P 500" value={of10(sum.beat)} sub="over the same days" />
              <Stat label={tab === 'open' ? 'Still on the list' : 'Left the list'} value={sum.n} sub={tab === 'open' ? 'joined any time' : 'joined in the past year'} />
            </div>
          )}
          <ul className="mt-4 rounded-2xl bg-card border border-border overflow-hidden divide-y divide-hairline">
            {list.map((r) => {
              const g = r.gain == null ? null : Number(r.gain)
              return (
                <li key={`${r.ticker}:${r.joined_on}`}>
                  <Link to={`/charts/entry/${encodeURIComponent(r.ticker)}`} className="min-h-[64px] px-4 py-3 flex items-center gap-3 hover:bg-bg-elev/60 transition">
                    <span className="flex-1 min-w-0">
                      <span className="block text-[15px] font-semibold leading-5">{r.ticker}{r.theme && <span className="ml-2 text-[11px] font-normal text-muted">{r.theme}</span>}</span>
                      <span className="block text-xs text-subtle truncate font-mono-tab">
                        {r.open ? `Joined ${day(r.joined_on)} · ${span(r.days)}` : `${day(r.joined_on)} → ${day(r.left_on)} · ${span(r.days)}`}
                      </span>
                    </span>
                    <span className="text-right shrink-0">
                      <span className={clsx('inline-block min-w-[72px] px-2.5 py-1 rounded-lg text-sm font-semibold font-mono-tab text-center',
                        g == null || Math.abs(g) < 0.0005 ? 'bg-bg-elev text-muted' : g >= 0 ? 'bg-green-400 text-bg' : 'bg-red-400 text-bg')}>{pctS(g)}</span>
                      {r.spy_gain != null && <span className="block mt-0.5 text-[11px] text-muted font-mono-tab">S&P {pctS(Number(r.spy_gain))}</span>}
                    </span>
                    <ChevronRight size={14} aria-hidden className="shrink-0 text-muted" />
                  </Link>
                </li>
              )
            })}
          </ul>
        </>
      )}
      <p className="mt-4 px-1 text-[11px] text-muted">
        Price change from the close the day a stock joined the list to the latest close, or to the close the day it left. A dip off the list of a week or less that ends back on counts as one stay. Dividends not included.
        General information, the same for every subscriber — not personalized investment advice. Past results don’t guarantee future results.
      </p>
    </div>
  )
}
