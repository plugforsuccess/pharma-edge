import clsx from 'clsx'
import { Check, X } from 'lucide-react'
import { LEADER, leaderMisses } from '../utils/leaders'
import { QUALITY, QUALITY_OIL } from '../utils/quality'

// The entry chart's status card (owner, 2026-10-16: the signal suite,
// Triple record and plan cards are sunset): is this stock a leader today?
// The five Leaders checks (src/utils/leaders.js) with today's values, and
// the leader-timing study's record. Leaders are bought any day they
// qualify — the study found a timing signal added nothing. Not-yet copy
// reads "NOT YET", never "NOT A LEADER" (owner, 2026-10-16).

const pct = (x, d = 1) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d)}%`)
const money = (x) => (x == null ? '—' : `$${Number(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const dayLabel = (t) => (t ? new Date(`${t}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '')

// The cash-flow check (owner, 2026-10-20: only stocks that pass are listed),
// from the nightly company_quality row: plain words, one reason at most.
function qualityRow(q) {
  if (q === undefined) return ['quality', 'Strong cash flow', '…', null, null]
  if (q === null) return ['quality', 'Strong cash flow', '—', 'not checked yet', false]
  if (q.rule === 'fund') return ['quality', 'Strong cash flow', 'Fund', 'no company to check', true]
  const p = q.rule === 'oil' ? QUALITY_OIL : QUALITY
  const m = q.misses ?? []
  const value = q.fcf_margin == null ? '—' : `${Math.round(q.fcf_margin * 100)}% of sales`
  const sub = m.includes('no data') ? 'no US annual report on file'
    : m.includes('fcf') ? 'spends more cash than it makes'
    : m.includes('margin') ? `needs ${Math.round(p.fcfMarginMin * 100)}% of sales kept as cash`
    : m.includes('debt') ? `debt ${q.net_debt_years?.toFixed(1)} years of cash flow · max ${p.netDebtYearsMax}`
    : m.includes('dilution') ? `shares up ${Math.round((q.share_growth ?? 0) * 100)}% in a year · max ${Math.round(p.shareGrowthMax * 100)}%`
    : q.net_debt_years != null && q.net_debt_years > 0 ? `debt ${q.net_debt_years.toFixed(1)} years of cash flow` : 'more cash than debt'
  return ['quality', q.rule === 'oil' ? 'Strong cash flow (oil)' : 'Strong cash flow', m.includes('no data') ? '—' : value, sub, q.pass === true]
}

export default function LeaderPanel({ traits, close, asOf, spyLoading, advanced = false, quality }) {
  const priceMisses = leaderMisses(traits)
  const q = qualityRow(quality)
  const misses = q[4] === false ? [...priceMisses, 'quality'] : priceMisses
  const yes = traits && misses.length === 0 && q[4] !== null
  const sma200 = traits?.vs200 != null && close ? close / (1 + traits.vs200) : null
  const rows = [
    ['mom12', `Up more than ${Math.round(LEADER.mom12 * 100)}% over the past year`, pct(traits?.mom12, 0), 'skipping the last month'],
    ['vs200', `At least ${Math.round(LEADER.vs200 * 100)}% above the 200-day`, pct(traits?.vs200), sma200 ? `200-day ${money(sma200)}` : null],
    ['slope200', '200-day rising steeply', pct(traits?.slope200), `needs +${(LEADER.slope200 * 100).toFixed(1)}% in 20 days`],
    ['volRank', 'Options cheap for this stock', traits?.volRank == null ? '—' : `${Math.round(traits.volRank * 100)}th pct`, `volatility in its cheaper ${Math.round(LEADER.volRankMax * 100)}%`],
    q.slice(0, 4),
  ]
  // The S&P check is no longer part of the rule (owner, 2026-10-19); the
  // market's trend stays visible here and on the market card.
  const met = rows.filter(([k]) => !misses.includes(k)).length
  return (
    <section className="bg-card border border-border rounded-2xl mb-4 overflow-hidden">
      <div className="px-5 pt-5 pb-4">
        <div className="text-[11px] uppercase tracking-[0.14em] text-muted font-semibold">Leaders rule{asOf ? ` · ${dayLabel(asOf)}` : ''}</div>
        <div className="mt-2 flex items-end gap-3">
          <div className="flex-1">
            <div className={clsx('text-[34px] leading-10 font-semibold tracking-tight', yes ? 'text-green-400' : 'text-fg')}>{yes ? 'LEADER' : 'NOT YET'}</div>
            <div className="text-sm text-subtle">{traits ? `${met} of ${rows.length} leader checks met` : 'Not enough price history yet'}</div>
          </div>
          <div className="flex items-end gap-1 pb-1" aria-hidden>
            {rows.map((_, i) => <span key={i} className={clsx('w-2.5 rounded-sm', i < met ? (yes ? 'bg-green-400' : 'bg-amber-400') : 'bg-bg-elev')} style={{ height: 10 + i * 6 }} />)}
          </div>
        </div>
        {yes && <p className="mt-2 text-sm text-subtle">A leader can be bought any day it qualifies — no timing signal needed.</p>}
      </div>
      <ul className="border-t border-hairline divide-y divide-hairline">
        {rows.map(([k, label, value, sub]) => {
          const ok = k === 'quality' ? q[4] === true : traits && !misses.includes(k)
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
      <p className="px-5 py-3 border-t border-hairline text-xs text-subtle">
        Market: the S&P 500 is {traits?.spyUp == null ? (spyLoading ? '…' : 'unknown') : traits.spyUp ? <span className="text-green-400">above</span> : <span className="text-red-400">below</span>} its 200-day average. Shown for context, not part of the rule.
      </p>
      {advanced && (
        <p className="px-5 py-3 border-t border-hairline text-[11px] text-muted">
          Leaders bought any day, 2024–26: 60% made money, the typical trade +50% (at-the-money 2-year call with the exit plan). Any stock, any day: 52%, +7%. Estimates from past prices, not a forecast.
        </p>
      )}
    </section>
  )
}
