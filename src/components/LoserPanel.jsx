import clsx from 'clsx'
import { loserChecks, BOTH_LIT, FRESH_JUMP } from '../utils/holdingRisks'

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

export default function LoserPanel({ row }) {
  const { status, checks, lit } = loserChecks(row)
  const [title, sub, tone] = HEAD[status]
  return (
    <section className="bg-card border border-border rounded-2xl mb-4 overflow-hidden">
      <div className="px-5 pt-5 pb-4">
        <div className="text-[11px] uppercase tracking-[0.14em] text-muted font-semibold">Loser rules{row?.as_of ? ` · ${dayLabel(row.as_of)}` : ''}</div>
        <div className="mt-2 flex items-end gap-3">
          <div className="flex-1">
            <div className={clsx('text-[34px] leading-10 font-semibold tracking-tight', tone)}>{title}</div>
            <div className="text-sm text-subtle">{sub} · {lit} of {checks.length} checks lit</div>
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
    </section>
  )
}
