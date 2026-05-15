// Pure market-time helpers — single source of truth for DTE math
// and session classification, extracted so a Deno fixture checker
// can import the REAL functions (a re-implemented test drifts from
// the code and silently passes while prod is broken — exactly the
// failure mode the verdict-fixtures guard exists to prevent).
//
// Both functions take an optional `now` so fixtures can pin a
// deterministic instant. No Deno-runtime or network dependency.

export type MarketSession =
  | 'rth'           // 9:30 AM – 4:00 PM ET, M-F
  | 'pre-market'    // 4:00 AM – 9:30 AM ET, M-F
  | 'after-hours'   // 4:00 PM – 8:00 PM ET, M-F
  | 'overnight'     // 8:00 PM – 4:00 AM next weekday
  | 'weekend'       // Sat / Sun

// Start of "today" at 00:00 UTC, epoch ms. DTE math subtracts a
// midnight-aligned reference so tomorrow's expiry is always 1, never
// 0 (the bug fixed in #202 — `(expMs - Date.now())/86_400_000`
// rounded a <24h gap down to 0 any time of day past noon UTC).
export function startOfTodayUtcMs(now: Date = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
}

// Whole calendar days from today (UTC midnight) to a YYYY-MM-DD
// expiration. Floored at 0. This is the canonical DTE used across
// compute-gex / the verdict / the prompt.
export function dteFor(expirationYmd: string, now: Date = new Date()): number {
  const expMs = new Date(expirationYmd + 'T00:00:00Z').getTime()
  if (!Number.isFinite(expMs)) return 0
  return Math.max(0, Math.round((expMs - startOfTodayUtcMs(now)) / 86_400_000))
}

// DST in effect for the given UTC instant. US rule: 2nd Sunday March
// 02:00 → 1st Sunday November 02:00. We approximate at day
// granularity (the ±1h window around the switch is immaterial to a
// session bucket whose edges are hours wide).
function isUsDst(date: Date): boolean {
  const y = date.getUTCFullYear()
  const marStart = new Date(Date.UTC(y, 2, 1))
  const dstStart = new Date(Date.UTC(y, 2, 1 + ((7 - marStart.getUTCDay()) % 7) + 7))
  const novStart = new Date(Date.UTC(y, 10, 1))
  const dstEnd = new Date(Date.UTC(y, 10, 1 + ((7 - novStart.getUTCDay()) % 7)))
  return date >= dstStart && date < dstEnd
}

// Coarse US-equities session bucket in ET. Holidays/early closes not
// modelled (crons are RTH-windowed; this is a labelling aid, not an
// exchange calendar).
export function classifySession(d: Date = new Date()): MarketSession {
  const offsetHours = isUsDst(d) ? -4 : -5
  const et = new Date(d.getTime() + offsetHours * 60 * 60 * 1000)
  const dow = et.getUTCDay()
  if (dow === 0 || dow === 6) return 'weekend'
  const minutes = et.getUTCHours() * 60 + et.getUTCMinutes()
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return 'pre-market'
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return 'rth'
  if (minutes >= 16 * 60 && minutes < 20 * 60) return 'after-hours'
  return 'overnight'
}
