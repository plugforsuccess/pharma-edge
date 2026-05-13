// Today's Plays — cross-ticker ranked feed.
//
// Reads the latest row from top_plays_feed (populated by the
// scan-universe-plays cron every 15 min during RTH). Auto-refreshes
// every 60s so a user opening the app sees fresh data within a
// minute of a new scan committing.
//
// Tap a play → /log with the play pre-filled, claude_call_id
// threaded through, and the OTHER feed plays as claude_other_plays.
// That deep-links the user into the same logging flow Suggested
// Plays uses today — full post-mortem provenance preserved.

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Flame } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { logAsSignal } from '../lib/logAsSignal'

const REFRESH_INTERVAL_MS = 60_000

// Conviction tiers from ev_edge_bp (basis points over breakeven PoP):
//   >= 1500 = LOUD  (15pp+ edge — high conviction)
//   >=  500 = CLEAR (5-15pp edge — meaningful edge)
//   >=    0 = FAINT (positive but small)
// Negative edges are filtered server-side, shouldn't reach the feed.
function tierFor(play) {
  const edge = Number(play?.ev_edge_bp ?? 0)
  if (edge >= 1500) return { label: 'LOUD', cls: 'text-emerald-400', bar: 'bg-emerald-400' }
  if (edge >= 500) return { label: 'CLEAR', cls: 'text-amber-400', bar: 'bg-amber-400' }
  return { label: 'FAINT', cls: 'text-zinc-400', bar: 'bg-zinc-500' }
}

function popPct(bp) {
  if (bp == null || !Number.isFinite(Number(bp))) return null
  return `${Math.round(Number(bp) / 100)}%`
}

function minutesAgo(iso) {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return 'just now'
  const mins = Math.floor(ms / 60_000)
  return mins === 0 ? 'just now' : `${mins}m ago`
}

export default function TodaysPlaysFeed() {
  const navigate = useNavigate()
  const [feed, setFeed] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const { data, error: e } = await supabase
        .from('top_plays_feed')
        .select(
          'computed_at, ranked_plays, tickers_succeeded, tickers_failed, total_plays_after_filter',
        )
        .order('computed_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (cancelled) return
      if (e) {
        setError(e.message)
        setFeed(null)
      } else {
        setError(null)
        setFeed(data)
      }
      setLoading(false)
    }
    load()
    const interval = setInterval(load, REFRESH_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  function handleClick(play, allPlays) {
    // Pass the full feed minus this play as claude_other_plays so the
    // counterfactual record on signals captures everything the scanner
    // proposed at this moment in time, not just same-ticker alternatives.
    const otherPlays = allPlays.filter((p) => p !== play)
    logAsSignal(
      navigate,
      play,
      play.ticker,
      play.spot ?? null,
      null,
      {
        claudeCallId: play.claude_call_id ?? null,
        otherPlays,
      },
    )
  }

  if (loading) {
    return (
      <section className="bg-card border border-border rounded-xl p-4">
        <div className="text-muted text-xs">Loading today's plays…</div>
      </section>
    )
  }

  if (error) {
    return (
      <section className="bg-card border border-border rounded-xl p-4">
        <div className="text-red-400 text-xs">Couldn't load feed: {error}</div>
      </section>
    )
  }

  const plays = Array.isArray(feed?.ranked_plays) ? feed.ranked_plays : []

  if (plays.length === 0) {
    return (
      <section className="bg-card border border-border rounded-xl p-4 space-y-2">
        <div className="flex items-center gap-2">
          <Flame size={14} className="text-amber-400" />
          <h2 className="text-white text-sm font-semibold">Today's Plays</h2>
        </div>
        <p className="text-muted text-xs leading-relaxed">
          No high-conviction plays right now. The scanner runs every
          15 minutes during market hours.
          {feed?.computed_at && (
            <span className="block mt-1 text-[10px] text-zinc-500">
              Last scan {minutesAgo(feed.computed_at)} · {feed.tickers_succeeded ?? 0} tickers
            </span>
          )}
        </p>
      </section>
    )
  }

  return (
    <section className="bg-card border border-border rounded-xl p-4 space-y-3">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Flame size={14} className="text-amber-400" />
          <h2 className="text-white text-sm font-semibold">Today's Plays</h2>
        </div>
        <span className="text-[10px] text-muted">
          {minutesAgo(feed.computed_at)} · {feed.tickers_succeeded ?? 0} tickers
        </span>
      </header>

      <ul className="space-y-1.5">
        {plays.map((play, i) => {
          const tier = tierFor(play)
          const pop = popPct(play.entry_pop_bp)
          const rr =
            Number.isFinite(Number(play.risk_reward))
              ? Number(play.risk_reward).toFixed(1)
              : '—'
          return (
            <li key={`${play.ticker}-${i}`}>
              <button
                type="button"
                onClick={() => handleClick(play, plays)}
                className="w-full flex items-center gap-3 rounded-lg border border-border bg-bg px-3 py-2.5 text-left hover:border-zinc-700 transition-colors"
              >
                <div className={`w-1 h-9 rounded-full flex-shrink-0 ${tier.bar}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-bold text-white">{play.ticker}</span>
                    <span className="text-zinc-400 truncate">{play.strategy}</span>
                  </div>
                  <div className="text-[11px] text-zinc-500 truncate">
                    ${play.long_strike}/${play.short_strike} · {play.dte ?? '—'}DTE · R/R {rr}
                  </div>
                </div>
                <div className="text-right flex-shrink-0">
                  <div className={`text-[10px] font-semibold ${tier.cls}`}>{tier.label}</div>
                  <div className="text-[11px] text-zinc-500">PoP {pop ?? '—'}</div>
                </div>
              </button>
            </li>
          )
        })}
      </ul>

      <p className="text-[10px] text-muted leading-relaxed pt-2 border-t border-border">
        Cross-ticker scan. Same R/R + EV gates as per-ticker Suggested Plays.
        Tap any row to deep-link the calculator.
      </p>
    </section>
  )
}
