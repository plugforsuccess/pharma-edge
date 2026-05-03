import { differenceInCalendarDays, parseISO, startOfDay } from 'date-fns'

// Postgres returns DATE columns as 'YYYY-MM-DD' strings. `new Date('2026-05-10')`
// parses as UTC midnight, which produces an off-by-one against `new Date()` (local)
// in negative-UTC timezones. parseISO + startOfDay normalises both sides to local
// day boundaries.
export function daysUntil(dateStr) {
  if (!dateStr) return null
  return differenceInCalendarDays(parseISO(dateStr), startOfDay(new Date()))
}
