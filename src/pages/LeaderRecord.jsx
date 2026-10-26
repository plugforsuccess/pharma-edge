import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { ArrowLeft, ChevronRight } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { stintSummary } from '../utils/leaderRecord'
import { basketIndex } from '../utils/basketRecord'

// /charts/leader-record — the leader record (owner, 2026-10-19: "a live
// record of the price gain since becoming a leader" → "leaders should be buy
// and holds"). Every time a stock joined the Leaders list in the past year:
// bought at that day's close and held to the latest close, beside the S&P 500
// over the same days; dropping off the list is shown, not counted as a sale.
// Rebuilt each night by the ranking (leader_stints).
const pctS = (x) => (x == null ? '—' : Math.abs(x) < 0.0005 ? '0%' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(Math.abs(x) < 0.1 ? 1 : 0)}%`)
const day = (t) => (t ? new Date(`${t}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '')
const ago = (d) => (d === 0 ? 'today' : d < 10 ? `${d} ${d === 1 ? 'day' : 'days'} ago` : d < 65 ? `${Math.round(d / 5)} weeks ago` : `${Math.round(d / 21)} months ago`)
const RECENT = 63 // trading days ≈ 3 months
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

// The strongest-10 quality basket, logged every close since 2026-10-26
// (basket_record, append-only, hashed). It is the forward record: no
// backfill, so it starts at one day and earns its length.
function BasketCard() {
  const [rows, setRows] = useState(undefined)
  useEffect(() => {
    let cancelled = false
    supabase.from('basket_record').select('as_of, tickers, closes, spy_close, rebalanced').eq('basket', 'quality_top10').order('as_of').limit(2000)
      .then(({ data, error }) => { if (!cancelled) setRows(error ? null : data ?? []) })
    return () => { cancelled = true }
  }, [])
  const r = useMemo(() => basketIndex(rows ?? []), [rows])
  if (!r) return null
  const pct = (x) => `${x >= 0 ? '+' : '−'}${(Math.abs(x) * 100).toFixed(1)}%`
  return (
    <section className="bg-card border border-border rounded-2xl p-5 mt-4">
      <div className="text-[11px] uppercase tracking-[0.12em] text-muted font-semibold">Forward record · strongest 10 by cash flow</div>
      <div className="mt-2 grid grid-cols-3 gap-3">
        <Stat label="Basket" value={pct(r.basket)} tone={r.basket >= 0 ? 'text-green-400' : 'text-red-400'} />
        <Stat label="S&P 500" value={pct(r.spy)} tone={r.spy >= 0 ? 'text-green-400' : 'text-red-400'} />
        <Stat label="Closes logged" value={String(r.days)} sub={`since ${day(r.start)}`} />
      </div>
      <div className="mt-3 text-xs text-subtle">{r.members.join(' · ')}</div>
      <div className="mt-1 text-[11px] text-muted">Equal weight, re-picked on a month's first close ({r.rebalances} so far), price only. Every row is hashed when written; nothing is backfilled. {r.days < 63 ? 'Too short to read anything into yet.' : ''}</div>
    </section>
  )
}

export default function LeaderRecord() {
  const [rows, setRows] = useState(undefined)
  const [tab, setTab] = useState('recent')
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
  const list = useMemo(() => (rows ?? []).filter((r) => (tab === 'recent' ? r.days <= RECENT : r.days > RECENT)), [rows, tab])
  const num = (x) => (x == null ? null : Number(x))
  const sum = useMemo(() => stintSummary(list.map((r) => ({ gain: num(r.gain), spy_gain: num(r.spy_gain), univ_med: num(r.univ_med), univ_avg: num(r.univ_avg) }))), [list])
  const asOf = rows?.[0]?.as_of
  const recentN = (rows ?? []).filter((r) => r.days <= RECENT).length
  const stillN = list.filter((r) => r.open).length

  return (
    <div className="max-w-md mx-auto px-4 pt-4 pb-28">
      <Link to="/charts" className="min-h-[44px] -ml-1 inline-flex items-center gap-1.5 text-sm text-subtle hover:text-fg">
        <ArrowLeft size={16} aria-hidden /> Leaders
      </Link>
      <div className="mt-1 text-[11px] text-muted">{asOf ? `As of ${day(asOf)} close` : 'Updated after each close'}</div>
      <h1 className="mt-0.5 text-[28px] leading-9 font-semibold tracking-tight">Leader record</h1>
      <p className="text-sm text-subtle">Each stock bought the day it became a leader and held to today.</p>
      <BasketCard />

      <div className="mt-4 flex gap-2">
        {[['recent', `Past 3 months${rows ? ` · ${recentN}` : ''}`], ['older', `3–12 months${rows ? ` · ${rows.length - recentN}` : ''}`]].map(([k, label]) => (
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
          {sum.n > 0 && sum.avg != null && (
            /* The group view (owner, 2026-10-19): every leader together, beside
               the S&P 500 and any stock over the same days. Facts only. */
            <div className="mt-4 rounded-2xl bg-card border border-border px-4 py-3.5">
              <div className="text-[11px] text-muted">All {sum.n} leaders together · average change</div>
              <div className={clsx('mt-0.5 text-[28px] leading-9 font-semibold font-mono-tab', sum.avg >= 0 ? 'text-green-400' : 'text-red-400')}>{pctS(sum.avg)}</div>
              <div className="mt-0.5 text-sm text-subtle font-mono-tab">
                S&P 500 {pctS(sum.spyAvg)}{sum.univAvg != null && <> · any stock {pctS(sum.univAvg)}</>} <span className="text-muted">over the same days</span>
              </div>
              <p className="mt-2 text-xs text-muted">Over 5 years of past prices, leaders did better as a group than one at a time: a few large winners carried the average.</p>
            </div>
          )}
          {sum.n > 0 && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Stat label="Typical leader since joining" value={pctS(sum.median)} tone={sum.median == null ? 'text-fg' : sum.median >= 0 ? 'text-green-400' : 'text-red-400'} sub={sum.univMedian != null ? `any stock typical ${pctS(sum.univMedian)}` : `${sum.n} ${sum.n === 1 ? 'stock' : 'stocks'}`} />
              <Stat label="Higher than when it joined" value={of10(sum.higher)} sub={`S&P 500 typical ${pctS(sum.spyMedian)}`} />
              <Stat label="Beat the S&P 500" value={of10(sum.beat)} sub="over the same days" />
              <Stat label="Still leaders today" value={`${stillN} of ${sum.n}`} sub="the rest are held anyway" />
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
                        Joined {day(r.joined_on)} · {ago(r.days)}
                      </span>
                      <span className={clsx('block text-[11px] truncate', r.open ? 'text-green-400' : 'text-muted')}>
                        {r.open ? 'Still a leader' : `Off the list since ${day(r.left_on)}`}
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
        Price change from the close the day a stock became a leader to the latest close — held, even after it left the list. A stock that drops off and comes back within a month counts once. Dividends not included.
        General information, the same for every subscriber — not personalized investment advice. Past results don’t guarantee future results.
      </p>
    </div>
  )
}
