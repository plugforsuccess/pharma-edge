import { useEarnings } from '../lib/earningsCache'
import { daysUntil } from '../utils/dates'

// Returns true if today is the print day AND the print has already
// happened (past 9:30 ET for BMO, past 16:00 ET for AMC). The badge
// uses this to disappear after the event has passed instead of
// nagging through the rest of the session.
//
// UNKNOWN announcement_time stays visible all day on day 0 — we
// can't tell when the print lands, so safest to keep the warning up.
function isPastAnnouncement(announcementTime) {
  if (announcementTime !== 'BMO' && announcementTime !== 'AMC') return false
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(new Date())
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  const etMinutes = hour * 60 + minute
  if (announcementTime === 'BMO' && etMinutes >= 9 * 60 + 30) return true
  if (announcementTime === 'AMC' && etMinutes >= 16 * 60) return true
  return false
}

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
  // Day-of: hide once the print has actually happened (BMO past
  // 9:30 ET, AMC past 16:00 ET). Without this, the badge nags the
  // user with a stale ER 0D warning for hours after the hazard.
  if (days === 0 && isPastAnnouncement(er.announcement_time)) return null
  const tone = days <= 7
    ? 'bg-rose-500/20 text-rose-300 border-rose-500/40'
    : 'bg-amber-500/15 text-amber-300 border-amber-500/40'
  const timeLabel = withTime && (er.announcement_time === 'BMO' || er.announcement_time === 'AMC')
    ? ` ${er.announcement_time}`
    : ''
  const label = compact
    ? `ER ${days}d${timeLabel}`
    : `Earnings in ${days}d${timeLabel}`
  const title = `${String(ticker).toUpperCase()} earnings: ${er.earnings_date}${er.announcement_time && er.announcement_time !== 'UNKNOWN' ? ` (${er.announcement_time})` : ''}`
  return (
    <span
      className={`inline-flex items-center text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded border font-semibold whitespace-nowrap ${tone} ${className}`}
      title={title}
    >
      {label}
    </span>
  )
}
