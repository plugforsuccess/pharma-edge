import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Calendar } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { getEarnings, isPastAnnouncement } from '../lib/earningsCache'
import { daysUntil } from '../utils/dates'

// Persistent dashboard strip — "this week's earnings on your stuff".
// Renders only tickers the user actually cares about (open positions
// ∪ active signals ∪ watchlist) AND that are reporting in the next 7
// calendar days. Hidden entirely when nothing qualifies, so it's not
// chrome when there's nothing to act on.
//
// This is the placement the badge can't be: a header strip the user
// can't scroll past on the morning open. The per-row badges in
// OpenPositions / SignalDetail / Markets remain — those are the
// in-context reminders; this is the at-a-glance "what's pressing"
// view.
//
// Each chip is a Link to /markets?ticker=X so tapping lands you on
// the matrix for that name, ready to evaluate the close/roll.

const WINDOW_DAYS = 7

export default function EarningsThisWeek() {
  const { user } = useAuth()
  const [byTicker, setByTicker] = useState(new Map())
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!user?.id) return
    let cancelled = false
    ;(async () => {
      // Union of: open positions, active signals (incl. watch-only),
      // and watchlist. We want this strip to scream about ANY name
      // the user has touched — overcaution is the point.
      const [posRes, sigRes, wlRes] = await Promise.all([
        supabase.from('open_positions').select('ticker').eq('user_id', user.id).eq('status', 'open'),
        supabase.from('signals').select('ticker').eq('user_id', user.id).eq('status', 'active'),
        supabase.from('watchlist').select('ticker').eq('user_id', user.id),
      ])
      if (cancelled) return
      const tickers = new Set()
      for (const row of posRes.data ?? []) tickers.add(String(row.ticker || '').toUpperCase())
      for (const row of sigRes.data ?? []) tickers.add(String(row.ticker || '').toUpperCase())
      for (const row of wlRes.data ?? []) tickers.add(String(row.ticker || '').toUpperCase())
      const list = Array.from(tickers).filter(Boolean)
      // getEarnings shares the session cache with every EarningsBadge,
      // so this isn't N queries — it's a single batched lookup on the
      // first dashboard load, free thereafter for 5 min.
      const results = await Promise.all(list.map((t) => getEarnings(t)))
      if (cancelled) return
      const map = new Map()
      list.forEach((t, i) => {
        if (results[i]?.earnings_date) map.set(t, results[i])
      })
      setByTicker(map)
      setReady(true)
    })()
    return () => { cancelled = true }
  }, [user?.id])

  const upcoming = useMemo(() => {
    const out = []
    for (const [ticker, row] of byTicker) {
      const days = daysUntil(row.earnings_date)
      if (days == null || days < 0 || days > WINDOW_DAYS) continue
      // Keep same-day rows even after the print — they explain the
      // intraday move + IV crush, so removing them blanks the strip
      // exactly when the user wants context. Mark them so the chip
      // can render muted instead of red.
      const reported = days === 0 && isPastAnnouncement(row.announcement_time)
      out.push({ ticker, ...row, days, reported })
    }
    return out.sort((a, b) => a.days - b.days)
  }, [byTicker])

  if (!ready || upcoming.length === 0) return null

  return (
    <section className="mb-5">
      <div className="rounded-xl border border-rose-500/30 bg-rose-500/[0.04] px-3 py-2 flex items-center gap-3 overflow-x-auto">
        <div className="flex items-center gap-1.5 shrink-0">
          <Calendar size={12} className="text-rose-300" />
          <span className="text-[10px] uppercase tracking-wider font-semibold text-rose-300 whitespace-nowrap">
            Earnings this week
          </span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {upcoming.map((r) => {
            const dayLabel = r.reported
              ? 'reported'
              : r.days === 0 ? 'today' : r.days === 1 ? 'tomorrow' : `${r.days}d`
            const timeLabel = !r.reported && (r.announcement_time === 'BMO' || r.announcement_time === 'AMC')
              ? ` ${r.announcement_time}`
              : ''
            const stateColor = r.reported ? 'text-zinc-400' : 'text-rose-300'
            const hoverBg = r.reported ? 'hover:bg-zinc-700/20' : 'hover:bg-rose-500/10'
            return (
              <Link
                key={r.ticker}
                to={`/markets?ticker=${r.ticker}`}
                className={`inline-flex items-center gap-1.5 text-xs font-mono-tab text-fg hover:text-amber-300 transition-colors whitespace-nowrap px-1.5 py-0.5 rounded ${hoverBg}`}
                title={r.reported
                  ? `${r.ticker} reported earnings this morning${r.announcement_time === 'BMO' || r.announcement_time === 'AMC' ? ` (${r.announcement_time})` : ''} — IV crush + post-print move in flight`
                  : `${r.ticker} earnings: ${r.earnings_date}${r.announcement_time && r.announcement_time !== 'UNKNOWN' ? ` (${r.announcement_time})` : ''}`}
              >
                <span className="font-semibold">{r.ticker}</span>
                <span className={`${stateColor} text-[10px]`}>
                  {dayLabel}{timeLabel}
                </span>
              </Link>
            )
          })}
        </div>
      </div>
    </section>
  )
}
