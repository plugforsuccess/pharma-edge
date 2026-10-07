import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { ChevronRight } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { SWING_PLAN } from '../utils/momentumList'

// Charts → Momentum (owner, 2026-10-07: "1 and 3"; the one entry family whose
// stock picks held up in the pre-registered tests). Written nightly by
// scripts/rank-confluence.mjs → momentum_picks: the stocks with the best
// 12-month return (skipping the last month), above their 200-day, top tenth
// of the universe. Each row: the call the replay would price (0.75 delta,
// ~2 years, Black-Scholes on 60-day vol — an estimate, not a quote), its cost
// and share of the account, the plan (SWING_PLAN: sell the whole call at
// +75%, else after 18 months), and the other picks it moves with. The record
// line is the tested result of exactly this plan (momentum_record()), with
// its random-entry control, so the strength and the caveat sit together.
const money = (x, d = 0) => `$${Number(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`
const about = (x) => `about ${money(x >= 1000 ? Math.round(x / 100) * 100 : Math.round(x / 10) * 10)}`
const pctS = (x, d = 0) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d)}%`)
const day = (t) => (t ? new Date(`${t}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '')
const monthYear = (t) => (t ? new Date(`${t}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : '')
const SHOW = 10

function RecordLine({ rec }) {
  const a = rec?.all
  if (!a?.n) return null
  const years = Object.entries(rec.by_year ?? {}).sort(([x], [y]) => x.localeCompare(y))
  const losing = years.filter(([, v]) => v?.avg < 0).map(([y]) => y)
  const rnd = rec.random
  return (
    <p className="mt-2 text-xs leading-5 text-muted">
      Tested on {a.n.toLocaleString('en-US')} past trades with this plan: hit the target{' '}
      <span className="text-fg font-mono-tab">{Math.round(a.hitRate * 100)}%</span> of the time, averaging{' '}
      <span className={clsx('font-mono-tab', a.avg >= 0 ? 'text-green-400' : 'text-rose-300')}>{pctS(a.avg)}</span> per trade on the call
      {losing.length ? <>; lost money in {losing.join(', ')}</> : null}.
      {rnd?.reps ? <> Random days on the same stocks did about the same ({pctS(rnd.avg)}): the edge is which stocks move, not the day you buy.</> : null}
      {' '}Past results, not a forecast.
    </p>
  )
}

export default function MomentumList() {
  const [rows, setRows] = useState(null)
  const [rec, setRec] = useState(null)
  const [accountSize, setAccountSize] = useState(null)
  const [all, setAll] = useState(false)

  useEffect(() => {
    let cancelled = false
    supabase.from('momentum_picks').select('as_of').order('as_of', { ascending: false }).limit(1).maybeSingle()
      .then(({ data }) => {
        if (!data?.as_of) { if (!cancelled) setRows([]); return }
        return supabase.from('momentum_picks').select('*').eq('as_of', data.as_of).order('rank')
          .then(({ data: d, error }) => { if (!cancelled) setRows(error ? [] : d ?? []) })
      })
    supabase.rpc('momentum_record').then(({ data }) => { if (!cancelled) setRec(data ?? null) })
    supabase.auth.getUser().then(({ data }) => {
      if (!data?.user) return
      return supabase.from('profiles').select('account_size').eq('id', data.user.id).maybeSingle()
        .then(({ data: p }) => { if (!cancelled && p?.account_size > 0) setAccountSize(Number(p.account_size)) })
    })
    return () => { cancelled = true }
  }, [])

  // Groups of picks that move together (same lead ticker, 2+ members).
  const clusters = useMemo(() => {
    const m = new Map()
    for (const r of rows ?? []) { if (!m.has(r.move_group)) m.set(r.move_group, []); m.get(r.move_group).push(r.ticker) }
    return [...m.values()].filter((g) => g.length >= 3).sort((a, b) => b.length - a.length)
  }, [rows])

  if (rows && rows.length === 0) return null
  const list = rows ? (all ? rows : rows.slice(0, SHOW)) : null
  const asOf = rows?.[0]?.as_of

  return (
    <section className="bg-card border border-border rounded-2xl mb-5 overflow-hidden">
      <div className="px-5 pt-5 pb-3">
        <div className="flex items-baseline gap-2">
          <h2 className="flex-1 text-sm font-semibold">Momentum</h2>
          {asOf && <span className="text-[11px] text-muted">as of {day(asOf)}</span>}
        </div>
        <p className="mt-1 text-xs text-subtle">
          The strongest stocks of the past year, above their 200-day: the top tenth of {rows?.[0]?.eligible ?? '…'} names. The plan: {SWING_PLAN.label.toLowerCase()}.
        </p>
        <RecordLine rec={rec} />
        {clusters.length > 0 && (
          <p className="mt-2 text-xs leading-5 text-amber-300">
            {clusters.map((g) => g.join(', ')).join(' · ')} move together — owning several is closer to one bet than many.
          </p>
        )}
      </div>
      {list === null ? (
        <div className="px-5 pb-5 space-y-2" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="h-14 rounded-xl bg-bg-elev animate-pulse" />)}</div>
      ) : (
        <>
          <ul className="border-t border-hairline divide-y divide-hairline">
            {list.map((r) => {
              const t = r.trade
              const per = t ? t.cost * 100 : null
              const share = per && accountSize ? per / accountSize : null
              const target = t ? t.cost * (1 + SWING_PLAN.target) * 100 : null
              return (
                <li key={r.ticker}>
                  <Link to={`/charts/entry/${encodeURIComponent(r.ticker)}`} className="block px-5 py-3.5 hover:bg-bg-elev/40 transition">
                    <div className="flex items-baseline gap-2">
                      <span className="text-[11px] text-muted font-mono-tab w-5">#{r.rank}</span>
                      <span className="text-[15px] font-semibold">{r.ticker}</span>
                      <span className="text-xs text-subtle font-mono-tab">{money(r.close, 2)}</span>
                      <span className="flex-1" />
                      <span className="text-xs font-mono-tab text-green-400">{pctS(r.score)} <span className="text-muted">12 mo</span></span>
                      <ChevronRight size={14} className="text-muted" aria-hidden />
                    </div>
                    {t && (
                      <p className="mt-1.5 text-sm leading-5">
                        Buy the {monthYear(t.expiry)} ${t.strike} call — {about(per)} per contract
                        {share != null && <span className={clsx(share > 0.05 ? 'text-amber-300' : 'text-subtle')}> · {(share * 100).toFixed(1)}% of your account</span>}
                      </p>
                    )}
                    {t && <p className="text-xs text-subtle leading-5">Sell at {about(target)} per contract (+{Math.round(SWING_PLAN.target * 100)}%), or after 18 months.</p>}
                    <p className="mt-1 text-[11px] text-muted leading-4">
                      {pctS(r.vs200)} vs its 200-day · {r.off_high != null && r.off_high < -0.005 ? `${pctS(r.off_high)} off its high` : 'at its high'} · swings {Math.round((r.hv60 ?? 0) * 100)}% a year
                      {r.peers?.length ? <> · moves with {r.peers.slice(0, 4).join(', ')}{r.peers.length > 4 ? '…' : ''}</> : null}
                    </p>
                  </Link>
                </li>
              )
            })}
          </ul>
          {rows.length > SHOW && (
            <button type="button" onClick={() => setAll((v) => !v)} className="w-full min-h-[44px] border-t border-hairline text-xs font-semibold text-subtle hover:text-fg">
              {all ? 'Show top 10' : `Show all ${rows.length}`}
            </button>
          )}
          <p className="px-5 py-3 border-t border-hairline text-[11px] text-muted">
            Call prices are estimates from recent volatility, not quotes — check the chain before buying. Size each at 5% of the account or less. <Link to="/charts/record" className="text-violet-300">Forward record</Link>
          </p>
        </>
      )}
    </section>
  )
}
