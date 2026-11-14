import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import EarningsLine from './EarningsLine'
import clsx from 'clsx'
import { loserChecks, BOTH_LIT, FRESH_JUMP } from '../utils/holdingRisks'
import { bearPlan, BEAR_RECORD } from '../utils/loserTrades'

// The entry chart's status card for a Stopped-believing stock (owner, 2026-11-14:
// "for stopped believing stocks why is the leader rules shown … display the loser
// rules"). Pre-revenue stocks never pass the Leaders rule, so a scanned stock shows
// the four checks behind the list instead: the jump, not holding it, shorts rising,
// price falling over the same window. Facts only — a lit check is a fact, not a call.
const dayLabel = (t) => (t ? new Date(`${t}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '')
const HEAD = {
  both: ['ON THE LIST', 'Both list facts lit', 'text-red-300'],
  one: ['ONE FACT LIT', 'One of the two list facts', 'text-amber-300'],
  fresh: ['FRESH LOSER', 'Jumped in the past week', 'text-amber-300'],
  none: ['NOT ON THE LIST', 'Neither list fact is lit', 'text-fg'],
}

export default function LoserPanel({ row, bars = null, owner = false }) {
  const { status, checks, lit } = loserChecks(row)
  const plan = useMemo(() => (owner ? bearPlan(bars) : null), [owner, bars])
  const [title, sub, tone] = HEAD[status]
  // The jump record row for this jump: earnings on the jump and the next report date.
  const [rec, setRec] = useState(null)
  const ev = row?.catalyst?.event, tk = row?.ticker
  useEffect(() => {
    if (!ev || !tk) return undefined
    let cancelled = false
    supabase.from('jump_record').select('earnings_jump, report_date, next_report, next_report_est').eq('ticker', tk).eq('jump_date', ev).maybeSingle()
      .then(({ data }) => { if (!cancelled) setRec(data ?? null) })
    return () => { cancelled = true }
  }, [tk, ev])
  return (
    <section className="bg-card border border-border rounded-2xl mb-4 overflow-hidden">
      <div className="px-5 pt-5 pb-4">
        <div className="text-[11px] uppercase tracking-[0.14em] text-muted font-semibold">Loser rules{row?.as_of ? ` · ${dayLabel(row.as_of)}` : ''}</div>
        <div className="mt-2 flex items-end gap-3">
          <div className="flex-1">
            <div className={clsx('text-[34px] leading-10 font-semibold tracking-tight', tone)}>{title}</div>
            <div className="text-sm text-subtle">{sub} · {lit} of {checks.length} checks lit</div>
            {rec && <EarningsLine rec={rec} />}
          </div>
          <div className="flex items-end gap-1 pb-1" aria-hidden>
            {checks.map((c, i) => <span key={c.key} className={clsx('w-2.5 rounded-sm', c.lit ? 'bg-red-400' : 'bg-bg-elev')} style={{ height: 10 + i * 6 }} />)}
          </div>
        </div>
      </div>
      <ul className="border-t border-hairline divide-y divide-hairline">
        {checks.map((c) => (
          <li key={c.key} className="px-5 py-3 flex items-center gap-3 min-h-[56px]">
            <span className={clsx('shrink-0 h-7 w-7 rounded-full flex items-center justify-center', c.lit ? 'bg-red-400/15' : 'bg-bg-elev')} aria-label={c.lit ? 'lit' : 'not lit'}>
              <span className={clsx('h-2.5 w-2.5 rounded-full', c.lit ? 'bg-red-400' : 'border border-muted')} />
            </span>
            <span className="flex-1 min-w-0 text-sm text-fg">{c.label}</span>
            <span className="text-right shrink-0">
              <span className="block text-sm font-mono-tab text-fg whitespace-nowrap">{c.value}</span>
              {c.sub && <span className="block text-[11px] text-muted">{c.sub}</span>}
            </span>
          </li>
        ))}
      </ul>
      {(status === 'both' || status === 'fresh') && (
        <p className="px-5 py-3 border-t border-hairline text-[11px] text-muted">
          {status === 'both'
            ? `In the test, a stock with both facts lit was ${Math.round(Math.abs(BOTH_LIT.median) * 100)}% lower six months later at the median, and doubled one time in ${Math.round(1 / BOTH_LIT.doubled)}.`
            : `In the test of ${FRESH_JUMP.n.toLocaleString()} past jumps like this (2024 →), the stock was ${Math.round(Math.abs(FRESH_JUMP.median126) * 100)}% lower six months later at the median; ${Math.round(FRESH_JUMP.fell40 * 100)}% fell 40%+ and one in ${Math.round(1 / FRESH_JUMP.doubled)} doubled.`}
          {' '}Past prices, not a forecast.
        </p>
      )}
      {owner && plan && <BearCard plan={plan} record={status === 'fresh' ? BEAR_RECORD.fresh : status === 'both' || status === 'one' ? BEAR_RECORD.list : null} />}
    </section>
  )
}

// Owner only (owner, 2026-11-14: "for losers we care about puts and shorts only"):
// the three instruments the bear tests used, priced today with the tests' model, and the
// tests' recorded result for this setup. Subscribers never see a trade (no adviser activity).
const usd = (x) => (x >= 100 ? `$${Math.round(x).toLocaleString('en-US')}` : `$${x.toFixed(2)}`)
const pc = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(0)}%`
function BearCard({ plan, record }) {
  const { put, spread, short } = plan
  const rows = [
    ['Put', `${put.days}-day $${put.strike.toFixed(2)} put`, `≈${usd(put.cost * 100)}`, `breakeven ${usd(put.breakeven)} · needs ${pc(-put.needs)}`],
    ['Put spread', `${spread.days}-day $${spread.long.toFixed(2)} / $${spread.short.toFixed(2)}`, `≈${usd(spread.debit * 100)}`, `${Math.round((spread.ratio ?? 0) * 100)}% of the ${usd(spread.width * 100)} width${spread.withinCap ? '' : ' · over the 40% cap'}`],
    ['Short', `shares at ${usd(short.price)}`, 'borrow', `${short.borrows.map((b) => `${Math.round(b * 100)}%`).join('–')} a year is typical · tested with a +${Math.round(short.stop * 100)}% stop`],
  ]
  return (
    <div className="border-t border-hairline">
      <div className="px-5 pt-3 flex items-baseline justify-between gap-3">
        <span className="text-[11px] uppercase tracking-[0.14em] text-amber-300 font-semibold">Puts & shorts · owner only</span>
        <span className={clsx('text-[11px] font-semibold text-right', plan.tradeable ? 'text-green-300' : 'text-red-300')}>{plan.tradeable ? 'Options likely' : `Options unlikely: ${plan.why.join(', ')}`}</span>
      </div>
      <ul className="divide-y divide-hairline">
        {rows.map(([k, what, cost, sub]) => (
          <li key={k} className="px-5 py-2.5 flex items-center gap-3">
            <span className="flex-1 min-w-0">
              <span className="block text-sm text-fg">{k} <span className="text-subtle">· {what}</span></span>
              <span className="block text-[11px] text-muted">{sub}</span>
            </span>
            <span className="shrink-0 text-sm font-mono-tab text-fg">{cost}</span>
          </li>
        ))}
      </ul>
      <p className="px-5 py-3 border-t border-hairline text-[11px] text-muted">
        {record
          ? `Tested (${record.n} trades ${record.label}, 2024 →): put ${pc(record.put)}, spread ${pc(record.spread)}, short ${pc(record.short)} on average. None passed.`
          : 'No test covers this setup.'}
        {' '}Priced at 1.3× its 60-day volatility with 2% slippage, as in the tests — estimates, not quotes. Check the live chain.
      </p>
    </div>
  )
}
