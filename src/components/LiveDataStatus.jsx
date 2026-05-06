import { useEffect, useState } from 'react'
import { Activity, AlertTriangle } from 'lucide-react'
import { supabase } from '../lib/supabase'

// Single-line status banner shown across /markets, /flow, and Suggested
// Plays so the user knows when the dxlink-worker is offline (and why
// every page in the live-data stack therefore looks empty).
//
// Logic:
//   - Read max(updated_at) from public.dxlink_quotes
//   - During RTH (M–F 9:30–16:00 ET): stale = updated_at older than 2 min
//     → show CRIMSON "Live data offline" banner
//   - Outside RTH: stale = updated_at older than 18 hours OR null
//     → show AMBER "After-hours" banner (informational, not an error)
//   - Fresh: render nothing
//
// The component re-checks on a 60s interval so that the banner shows up
// without a hard refresh when the worker comes back.

const RTH_STALE_MS = 2 * 60 * 1000
const AFTER_HOURS_STALE_MS = 18 * 60 * 60 * 1000

export default function LiveDataStatus() {
  const [lastUpdate, setLastUpdate] = useState(undefined) // undefined=loading, null=no rows, ms=ts
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    let cancelled = false
    async function check() {
      const { data } = await supabase
        .from('dxlink_quotes')
        .select('updated_at')
        .order('updated_at', { ascending: false })
        .limit(1)
      if (cancelled) return
      const ts = data?.[0]?.updated_at
      setLastUpdate(ts ? new Date(ts).getTime() : null)
      setNow(Date.now())
    }
    check()
    const id = setInterval(check, 60_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  if (lastUpdate === undefined) return null // loading — keep quiet

  const inRth = isRegularTradingHours(now)
  const ageMs = lastUpdate == null ? Infinity : now - lastUpdate
  const stale = inRth ? ageMs > RTH_STALE_MS : ageMs > AFTER_HOURS_STALE_MS
  if (!stale) return null

  const tone = inRth ? 'crimson' : 'amber'
  const Icon = inRth ? AlertTriangle : Activity
  const colors =
    tone === 'crimson'
      ? 'bg-red-950/30 border-red-900/50 text-red-300'
      : 'bg-amber-950/20 border-amber-900/40 text-amber-300'

  return (
    <div
      className={`border rounded-lg px-3 py-2 flex items-start gap-2 text-xs ${colors}`}
    >
      <Icon size={13} className="shrink-0 mt-0.5" />
      <div className="leading-relaxed flex-1 min-w-0">
        {inRth ? (
          <>
            <span className="font-semibold">Live data offline.</span>{' '}
            The dxlink-worker hasn't streamed in {formatAgo(ageMs)} —
            GEX, Flow, and Suggested Plays are running off cached or
            Yahoo-delayed data.
          </>
        ) : (
          <>
            <span className="font-semibold">After-hours.</span>{' '}
            Live stream resumes at the next RTH open. Last tick {formatAgo(ageMs)}.
          </>
        )}
      </div>
    </div>
  )
}

// Returns true when `now` (ms) falls inside US regular trading hours.
// RTH = M–F 9:30am–4:00pm America/New_York. We avoid Date.toLocaleString
// timezone parsing in a hot path by using the wallclock-NY constructor.
function isRegularTradingHours(now) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  })
  const parts = fmt.formatToParts(new Date(now))
  const wd = parts.find((p) => p.type === 'weekday')?.value
  const hour = Number(parts.find((p) => p.type === 'hour')?.value)
  const minute = Number(parts.find((p) => p.type === 'minute')?.value)
  if (wd === 'Sat' || wd === 'Sun') return false
  const t = hour * 60 + minute
  return t >= 9 * 60 + 30 && t < 16 * 60
}

function formatAgo(ms) {
  if (!Number.isFinite(ms)) return 'never'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}
