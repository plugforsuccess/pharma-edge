import { Calendar } from 'lucide-react'
import { useEarnings, isPastAnnouncement } from '../lib/earningsCache'
import { daysUntil } from '../utils/dates'

// Always-visible earnings card. Differs from EarningsBadge in two
// ways:
//
//  1. Renders even when days > 30 (badge hides outside 30d). The
//     card is the "earnings calendar slot" on every ticker detail —
//     it should never just disappear; if there's no upcoming print
//     within the cache window (60d) it says so explicitly.
//
//  2. Shows the underlying data the badge omits: exact date, BMO/AMC,
//     days until, consensus EPS estimate when available.
//
// Drop-in for any ticker-detail surface (Markets ticker header,
// SignalDetail metadata strip, OpenPositions expanded view, etc.).
// Width-agnostic — fits its container.

export default function EarningsCard({ ticker, className = '' }) {
  const er = useEarnings(ticker)
  const days = er?.earnings_date ? daysUntil(er.earnings_date) : null
  const reported = days === 0 && isPastAnnouncement(er?.announcement_time)
  const hasUpcoming = er?.earnings_date && days != null && days >= 0

  // Color: red within 7d (act soon), amber 8-30d (plan), muted past
  // 30d (visible but not alarming), slate when reported earlier today,
  // zinc when no upcoming print.
  const tone = !hasUpcoming
    ? 'border-border bg-card'
    : reported
      ? 'border-zinc-600/40 bg-zinc-700/10'
      : days <= 7
        ? 'border-rose-500/40 bg-rose-500/[0.04]'
        : days <= 30
          ? 'border-amber-500/40 bg-amber-500/[0.04]'
          : 'border-border bg-card'

  const iconTone = !hasUpcoming
    ? 'text-muted'
    : reported
      ? 'text-zinc-400'
      : days <= 7
        ? 'text-rose-300'
        : days <= 30
          ? 'text-amber-300'
          : 'text-subtle'

  const timeBadge = er?.announcement_time === 'BMO' || er?.announcement_time === 'AMC'
    ? er.announcement_time
    : null

  return (
    <div className={`rounded-lg border px-3 py-2.5 ${tone} ${className}`}>
      <div className="flex items-center gap-2 mb-1">
        <Calendar size={11} className={iconTone} />
        <span className="text-[10px] uppercase tracking-wider text-subtle font-semibold">
          Next earnings
        </span>
      </div>
      {hasUpcoming ? (
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm font-mono-tab tabular-nums text-fg">
            {er.earnings_date}
          </span>
          {timeBadge && (
            <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-border bg-bg-elev/40 text-subtle font-semibold">
              {timeBadge}
            </span>
          )}
          <span className={`text-xs ${days <= 7 && !reported ? 'text-rose-300' : days <= 30 && !reported ? 'text-amber-300' : 'text-muted'}`}>
            {reported
              ? '· reported today'
              : days === 0
                ? '· today'
                : days === 1
                  ? '· tomorrow'
                  : `· in ${days}d`}
          </span>
          {er?.consensus_eps != null && (
            <span className="text-[10px] text-muted ml-auto">
              cons EPS <span className="text-subtle font-mono-tab">${Number(er.consensus_eps).toFixed(2)}</span>
            </span>
          )}
        </div>
      ) : (
        <div className="text-xs text-muted">
          No earnings scheduled in the next 60 days.
        </div>
      )}
    </div>
  )
}
