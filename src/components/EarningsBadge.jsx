import { useEarnings, isPastAnnouncement } from '../lib/earningsCache'
import { daysUntil } from '../utils/dates'

// Visual gate against the unforced-error trade: holding short premium
// through an earnings print. Renders nothing when the ticker has no
// upcoming earnings in the next 30 days; otherwise a compact pill:
//   * red — earnings within 7 days (act now)
//   * amber — earnings within 30 days (plan around)
//
// `compact` toggles the label between "ER 3d" (tight rows, picker
// cells) and "Earnings in 3d" (position cards, signal headers).
// `withTime` appends BMO/AMC when known — useful on the spot pill
// where "ER 1d AMC" reads as a clear next-trading-day flag.
export default function EarningsBadge({ ticker, compact = false, withTime = false, className = '' }) {
  const er = useEarnings(ticker)
  if (!er?.earnings_date) return null
  const days = daysUntil(er.earnings_date)
  if (days == null || days < 0 || days > 30) return null
  // Three day-0 states:
  //   * Pre-print  → red (act now, this is the hazard window)
  //   * Post-print → muted slate (informational — explains intraday
  //                  IV crush + price action, but no action needed)
  //   * 8–30 days  → amber (plan around)
  //   * 1–7 days   → red (act now)
  const reported = days === 0 && isPastAnnouncement(er.announcement_time)
  const tone = reported
    ? 'bg-zinc-700/40 text-zinc-300 border-zinc-600/40'
    : days <= 7
      ? 'bg-rose-500/20 text-rose-300 border-rose-500/40'
      : 'bg-amber-500/15 text-amber-300 border-amber-500/40'
  const timeLabel = withTime && (er.announcement_time === 'BMO' || er.announcement_time === 'AMC')
    ? ` ${er.announcement_time}`
    : ''
  const label = reported
    ? (compact ? `Reported${timeLabel}` : `Reported today${timeLabel}`)
    : (compact ? `ER ${days}d${timeLabel}` : `Earnings in ${days}d${timeLabel}`)
  const title = reported
    ? `${String(ticker).toUpperCase()} reported earnings this morning${er.announcement_time === 'BMO' || er.announcement_time === 'AMC' ? ` (${er.announcement_time})` : ''} — IV crush + post-print move in flight`
    : `${String(ticker).toUpperCase()} earnings: ${er.earnings_date}${er.announcement_time && er.announcement_time !== 'UNKNOWN' ? ` (${er.announcement_time})` : ''}`
  return (
    <span
      className={`inline-flex items-center text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded border font-semibold whitespace-nowrap ${tone} ${className}`}
      title={title}
    >
      {label}
    </span>
  )
}
