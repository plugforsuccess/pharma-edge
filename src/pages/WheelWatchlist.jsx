import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Star, ChevronRight } from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../lib/supabase'
import { WHEEL_CANDIDATES } from '../lib/tickerUniverse'
import EarningsBadge from '../components/EarningsBadge'

// Wheel Picks — the curated dividend-paying ≤$30-ish names the owner
// will actually wheel. Distinct from /wheel (the scanner output from
// wheel_suggestions) and from the personal watchlist (free-form
// per-user saved tickers): this is the strategy-doc canonical list,
// hardcoded in WHEEL_CANDIDATES with tier + max_contracts already
// computed from the 20% account-concentration cap.
//
// Replaces /leaderboard in the mobile bottom nav per owner — daily
// driver should be "where's today's wheel setup?" not "who's winning
// the public leaderboard?"
//
// Each row is a tap target to /markets?ticker=X so the user can
// evaluate GEX + IV before placing the put. Live price + day change
// come from dxlink_quotes (single batched query for all candidates);
// when the worker hasn't ticked recently, the row just hides those
// fields rather than blocking the screen.

const TIER_LABEL = {
  1: 'T1 · highest conviction',
  2: 'T2 · solid with caveats',
  3: 'T3 · higher risk / backfill',
}

const TIER_TONE = {
  1: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
  2: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  3: 'bg-zinc-500/15 text-zinc-300 border-zinc-500/40',
}

export default function WheelWatchlist() {
  const [quotes, setQuotes] = useState(new Map())

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const symbols = WHEEL_CANDIDATES.map((c) => c.symbol)
      const { data, error } = await supabase
        .from('dxlink_quotes')
        .select('symbol, mid, bid, ask, prev_close, updated_at')
        .in('symbol', symbols)
        .eq('kind', 'equity')
      if (cancelled || error) return
      const map = new Map()
      for (const r of data ?? []) {
        map.set(String(r.symbol).toUpperCase(), r)
      }
      setQuotes(map)
    })()
    return () => { cancelled = true }
  }, [])

  // Group candidates by tier so the user gets the conviction ordering
  // first. Tier 1 should always be the first thing scanned.
  const byTier = [1, 2, 3].map((tier) => ({
    tier,
    items: WHEEL_CANDIDATES.filter((c) => c.tier === tier),
  })).filter((g) => g.items.length > 0)

  return (
    <div className="px-4 py-4 max-w-2xl mx-auto">
      <header className="mb-4">
        <div className="flex items-center gap-2 mb-1">
          <Star size={16} className="text-amber-400 fill-amber-400" />
          <h1 className="text-lg font-semibold">Wheel Picks</h1>
        </div>
        <p className="text-xs text-subtle leading-relaxed">
          Dividend payers curated for three income streams: dividend
          hold + short-put premium + covered-call premium. Each row's
          max contracts enforces the 20% per-ticker cap on a $75K
          account. Tap to evaluate GEX + IV before placing.
        </p>
      </header>

      {byTier.map(({ tier, items }) => (
        <section key={tier} className="mb-5">
          <div className="flex items-center gap-2 mb-2">
            <span
              className={clsx(
                'text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border font-semibold',
                TIER_TONE[tier],
              )}
            >
              {TIER_LABEL[tier]}
            </span>
            <span className="text-[10px] text-muted">
              {items.length} {items.length === 1 ? 'name' : 'names'}
            </span>
          </div>
          <div className="space-y-1.5">
            {items.map((c) => {
              const q = quotes.get(c.symbol)
              const price = q?.mid ?? q?.bid ?? null
              const prev = q?.prev_close ?? null
              const pct = price != null && prev != null && prev > 0
                ? ((price - prev) / prev) * 100
                : null
              const pctTone = pct == null
                ? 'text-muted'
                : pct >= 0 ? 'text-green-400' : 'text-red-400'
              return (
                <Link
                  key={c.symbol}
                  to={`/markets?ticker=${c.symbol}`}
                  className="flex items-center gap-3 px-3 py-3 rounded-lg bg-card border border-border hover:border-amber-400/40 transition group"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-base font-semibold text-fg font-mono-tab">
                        {c.symbol}
                      </span>
                      <span className="text-[10px] text-muted uppercase tracking-wider">
                        {c.max_contracts}c max
                      </span>
                      <EarningsBadge ticker={c.symbol} compact withTime />
                    </div>
                    <div className="text-xs text-subtle truncate mt-0.5">
                      {c.label}
                    </div>
                  </div>
                  {price != null && (
                    <div className="text-right shrink-0">
                      <div className="text-sm font-mono-tab tabular-nums text-fg leading-none">
                        ${price.toFixed(2)}
                      </div>
                      {pct != null && (
                        <div className={`text-[10px] tabular-nums leading-none mt-1 ${pctTone}`}>
                          {pct >= 0 ? '+' : ''}{pct.toFixed(2)}%
                        </div>
                      )}
                    </div>
                  )}
                  <ChevronRight size={14} className="text-muted group-hover:text-amber-400 shrink-0" />
                </Link>
              )
            })}
          </div>
        </section>
      ))}

      <div className="mt-6 text-[10px] text-muted leading-relaxed border-t border-border pt-4">
        Live prices come from <code className="text-fg">dxlink_quotes</code>;
        if a row shows no price the worker hasn't streamed that ticker
        recently. Tier promotion / max_contracts edits happen in
        <code className="text-fg"> src/lib/tickerUniverse.js</code>.
      </div>
    </div>
  )
}
