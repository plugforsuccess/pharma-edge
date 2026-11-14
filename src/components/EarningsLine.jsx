import clsx from 'clsx'

const day = (t) => (t ? new Date(`${t}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '')

// Earnings on a jump: whether it came on a report (SEC 8-K item 2.02) and the next one.
export default function EarningsLine({ rec }) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
      <span className={clsx('rounded-full px-2 py-0.5 font-semibold', rec.earnings_jump ? 'bg-amber-500/15 text-amber-300' : 'bg-border/60 text-subtle')}>
        {rec.earnings_jump ? `On earnings · ${day(rec.report_date)}` : 'Not on earnings'}
      </span>
      <span className="text-muted">Next report {rec.next_report ? `${day(rec.next_report)}${rec.next_report_est ? ' (est.)' : ''}` : 'unknown'}</span>
    </div>
  )
}

