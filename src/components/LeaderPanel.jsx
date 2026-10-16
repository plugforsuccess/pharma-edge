import clsx from 'clsx'
import { Check, X } from 'lucide-react'
import { LEADER, leaderMisses } from '../utils/leaders'

// The entry chart's status card (owner, 2026-10-16: the signal suite,
// Triple record and plan cards are sunset): is this stock a leader today?
// The five Leaders checks (src/utils/leaders.js) with today's values, and
// the leader-timing study's record. Leaders are bought any day they
// qualify — the study found a timing signal added nothing.

const pct = (x, d = 1) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d)}%`)
const money = (x) => (x == null ? '—' : `$${Number(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const dayLabel = (t) => (t ? new Date(`${t}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '')

export default function LeaderPanel({ traits, close, asOf, spyLoading }) {
  const misses = leaderMisses(traits)
  const yes = traits && misses.length === 0
  const sma200 = traits?.vs200 != null && close ? close / (1 + traits.vs200) : null
  const rows = [
    ['mom12', `Up more than ${Math.round(LEADER.mom12 * 100)}% over the past year`, pct(traits?.mom12, 0), 'skipping the last month'],
    ['vs200', `At least ${Math.round(LEADER.vs200 * 100)}% above the 200-day`, pct(traits?.vs200), sma200 ? `200-day ${money(sma200)}` : null],
    ['slope200', '200-day rising steeply', pct(traits?.slope200), `needs +${(LEADER.slope200 * 100).toFixed(1)}% in 20 days`],
    ['volRank', 'Options cheap for this stock', traits?.volRank == null ? '—' : `${Math.round(traits.volRank * 100)}th pct`, `volatility in its cheaper ${Math.round(LEADER.volRankMax * 100)}%`],
    ['spyUp', 'S&P 500 above its 200-day', traits?.spyUp == null ? (spyLoading ? '…' : '—') : traits.spyUp ? 'Yes' : 'No', 'the market is in an uptrend'],
  ]
  const met = rows.filter(([k]) => !misses.includes(k)).length
  return (
    <section className="bg-card border border-border rounded-2xl mb-4 overflow-hidden">
      <div className="px-5 pt-5 pb-4">
        <div className="text-[11px] uppercase tracking-[0.14em] text-muted font-semibold">Leaders rule{asOf ? ` · ${dayLabel(asOf)}` : ''}</div>
        <div className="mt-2 flex items-end gap-3">
          <div className="flex-1">
            <div className={clsx('text-[34px] leading-10 font-semibold tracking-tight', yes ? 'text-green-400' : 'text-fg')}>{yes ? 'LEADER' : 'NOT A LEADER'}</div>
            <div className="text-sm text-subtle">{traits ? `${met} of 5 checks met` : 'Not enough price history yet'}</div>
          </div>
          <div className="flex items-end gap-1 pb-1" aria-hidden>
            {[0, 1, 2, 3, 4].map((i) => <span key={i} className={clsx('w-2.5 rounded-sm', i < met ? (yes ? 'bg-green-400' : 'bg-amber-400') : 'bg-bg-elev')} style={{ height: 10 + i * 6 }} />)}
          </div>
        </div>
        {yes && <p className="mt-2 text-sm text-subtle">A leader can be bought any day it qualifies — no timing signal needed.</p>}
      </div>
      <ul className="border-t border-hairline divide-y divide-hairline">
        {rows.map(([k, label, value, sub]) => {
          const ok = traits && !misses.includes(k)
          return (
            <li key={k} className="px-5 py-3 flex items-center gap-3 min-h-[56px]">
              <span className={clsx('shrink-0 h-7 w-7 rounded-full flex items-center justify-center', ok ? 'bg-green-400/15 text-green-400' : 'bg-red-400/15 text-red-400')}>
                {ok ? <Check size={15} aria-label="met" /> : <X size={15} aria-label="not met" />}
              </span>
              <span className="flex-1 min-w-0 text-sm text-fg">{label}</span>
              <span className="text-right">
                <span className="block text-sm font-mono-tab text-fg">{value}</span>
                {sub && <span className="block text-[11px] text-muted">{sub}</span>}
              </span>
            </li>
          )
        })}
      </ul>
      <p className="px-5 py-3 border-t border-hairline text-[11px] text-muted">
        Leaders bought any day, 2024–26: 60% made money, the typical trade +50% (at-the-money 2-year call with the exit plan). Any stock, any day: 52%, +7%. Estimates from past prices, not a forecast.
      </p>
    </section>
  )
}
