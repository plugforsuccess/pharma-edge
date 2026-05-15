// Today's Plays — cross-ticker ranked feed.
//
// Reads the latest top_plays_feed row, auto-refreshes every 60s.
// Tap a play → /play/:claude_call_id (the decision-context page).
// The Log CTA is on the detail page; this list is read + tap.
//
// Display rules:
//   * ConvictionDots show within-tier ranking even when every play
//     is the same tier (a row of FAINTs needs to be ordered)
//   * Quiet-market banner when 0 plays clear CLEAR tier
//   * Universe coverage stat in header (e.g. "2/19 tickers")

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Flame } from 'lucide-react'
import { supabase } from '../lib/supabase'
import ConvictionDots, { tierFor } from './ConvictionDots'

const REFRESH_INTERVAL_MS = 60_000

function popPct(bp) {
  if (bp == null || !Number.isFinite(Number(bp))) return null
  return `${Math.round(Number(bp) / 100)}%`
}

function minutesAgo(iso) {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return 'just now'
  const mins = Math.floor(ms / 60_000)
  if (mins === 0) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  const rem = mins % 60
  return rem === 0 ? `${hrs}h ago` : `${hrs}h ${rem}m ago`
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
          'computed_at, ranked_plays, tickers_succeeded, tickers_failed, total_plays_after_filter, universe, pricing_rejections',
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

  function handleClick(play) {
    // The detail page handles its own data fetch from claude_call_id —
    // we just need to navigate. State is not the data source here;
    // the URL is canonical so deep-linking + refresh work.
    if (play?.claude_call_id) {
      navigate(`/play/${play.claude_call_id}`)
    }
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
  const universeSize = Array.isArray(feed?.universe) ? feed.universe.length : 19
  const tickersSucceeded = feed?.tickers_succeeded ?? 0

  // Empty state. Distinguish a genuine no-setup scan from a scan where
  // Claude proposed plays that all died at live price-verification —
  // conflating the two is what made "0 plays all day" undiagnosable.
  if (plays.length === 0) {
    const rej = feed?.pricing_rejections || null
    const proposed = Number(rej?.proposed) || 0
    const pricingKills = Number(rej?.pricing) || 0
    // "Pricing-degraded" = Claude had setups but the quote provider
    // couldn't price the legs. That's an infra problem, not a market
    // read — say so plainly instead of implying a quiet tape.
    const pricingDegraded = proposed > 0 && pricingKills > 0 &&
      pricingKills >= (proposed - (Number(rej?.verified) || 0)) * 0.5

    return (
      <section className="bg-card border border-border rounded-xl p-4 space-y-2">
        <div className="flex items-center gap-2">
          <Flame size={14} className="text-amber-400" />
          <h2 className="text-white text-sm font-semibold">Today's Plays</h2>
        </div>
        {pricingDegraded ? (
          <p className="text-muted text-xs leading-relaxed">
            <span className="text-amber-300 font-semibold">
              Not a quiet market — a data issue.
            </span>{' '}
            The scanner generated {proposed} setup{proposed === 1 ? '' : 's'} but
            couldn't get live option quotes to verify {pricingKills === proposed ? 'any' : pricingKills} of
            them (pricing provider degraded). These are suppressed rather
            than shown unpriced — no fabricated numbers. They'll surface
            once quotes recover.
            {feed?.computed_at && (
              <span className="block mt-1 text-[10px] text-zinc-500">
                Last scan {minutesAgo(feed.computed_at)} · {tickersSucceeded}/{universeSize} tickers ·
                {' '}{pricingKills} dropped at pricing
              </span>
            )}
          </p>
        ) : (
          <p className="text-muted text-xs leading-relaxed">
            No high-conviction plays right now. The scanner runs every
            30 minutes during market hours.
            {feed?.computed_at && (
              <span className="block mt-1 text-[10px] text-zinc-500">
                Last scan {minutesAgo(feed.computed_at)} · {tickersSucceeded}/{universeSize} tickers
              </span>
            )}
          </p>
        )}
      </section>
    )
  }

  // How many plays clear CLEAR tier? Drives the quiet-market banner.
  const highConvictionCount = plays.filter((p) =>
    tierFor(p.ev_edge_bp) !== 'FAINT',
  ).length

  return (
    <section className="bg-card border border-border rounded-xl p-4 space-y-3">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Flame size={14} className="text-amber-400" />
          <h2 className="text-white text-sm font-semibold">Today's Plays</h2>
        </div>
        <span className="text-[10px] text-zinc-500">
          {minutesAgo(feed.computed_at)} · {tickersSucceeded}/{universeSize} tickers
        </span>
      </header>

      {/* Quiet-market callout when no LOUD or CLEAR plays */}
      {highConvictionCount === 0 && (
        <div className="bg-amber-950/30 border border-amber-900/40 rounded-lg px-3 py-2">
          <p className="text-amber-200 text-[11px] leading-relaxed">
            <span className="font-semibold">Quiet market.</span> Scanner found {plays.length} setup{plays.length === 1 ? '' : 's'}{' '}
            across {tickersSucceeded} of {universeSize} tickers but none cleared CLEAR conviction.
            Lower-conviction plays below — wait for stronger signals or skip today.
          </p>
        </div>
      )}

      <ul className="space-y-1.5">
        {plays.map((play, i) => {
          const pop = popPct(play.entry_pop_bp)
          const rr = Number.isFinite(Number(play.risk_reward))
            ? Number(play.risk_reward).toFixed(1)
            : '—'
          return (
            <li key={`${play.claude_call_id ?? play.ticker}-${i}`}>
              <button
                type="button"
                onClick={() => handleClick(play)}
                disabled={!play.claude_call_id}
                className="w-full flex items-center gap-3 rounded-lg border border-border bg-bg px-3 py-2.5 text-left hover:border-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <ConvictionDots edge={play.ev_edge_bp} />
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
                  <div className="text-[11px] text-zinc-300 font-semibold">
                    PoP {pop ?? '—'}
                  </div>
                  <div className="text-[10px] text-zinc-500">
                    {play.ev_edge_bp != null
                      ? `${play.ev_edge_bp >= 0 ? '+' : ''}${play.ev_edge_bp}bp`
                      : ''}
                  </div>
                </div>
              </button>
            </li>
          )
        })}
      </ul>

      <p className="text-[10px] text-muted leading-relaxed pt-2 border-t border-border">
        Cross-ticker scan. Same R/R + EV gates as per-ticker Suggested Plays.
        Tap a row to see Claude's full thesis + position sizing.
      </p>
    </section>
  )
}
