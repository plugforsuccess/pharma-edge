// Is the US equity market currently in regular trading hours?
// 9:30am ET — 4:00pm ET, Mon–Fri. Holidays NOT excluded — for that
// we'd need a full NYSE calendar; the few false positives on holiday
// Mondays aren't worth the dependency right now (the empty-state UI
// will just say "no prints yet" instead of "markets closed", which
// is also accurate).
//
// Used to drive empty-state copy on Flow, the SourceBadge "after
// hours" variant on Markets, and (eventually) the Tape's live-feed
// gating.

export function isWithinRth() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  })
  const parts = fmt.formatToParts(new Date())
  const wd = parts.find((p) => p.type === 'weekday')?.value
  const hour = Number(parts.find((p) => p.type === 'hour')?.value)
  const minute = Number(parts.find((p) => p.type === 'minute')?.value)
  if (wd === 'Sat' || wd === 'Sun') return false
  const t = hour * 60 + minute
  return t >= 9 * 60 + 30 && t < 16 * 60
}
