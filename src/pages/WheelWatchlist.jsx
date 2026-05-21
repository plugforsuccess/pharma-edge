import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Star, ChevronRight, AlertTriangle } from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { WHEEL_CANDIDATES } from '../lib/tickerUniverse'
import EarningsBadge from '../components/EarningsBadge'

// Wheel Picks — the curated dividend-paying names the owner will
// actually wheel. Distinct from /wheel (the scanner output) and from
// the personal watchlist (free-form per-user saved tickers): this is
// the strategy-doc canonical list, defined in WHEEL_CANDIDATES.
//
// Sizing is dynamic. max_contracts per row = floor( (account × 20%) /
// (live_price × 100) ), so as account size or share price moves, the
// row sizing updates automatically. account_size comes from
// profile.account_size (user-set in Settings, or auto-synced from
// Tastytrade NLV when wired). When account_size is unset the page
// renders a CTA prompting the user to set it — without it, contract
// sizing is impossible.
//
// Rows where max_contracts < 1 are filtered out: that means the
// candidate is too expensive even for a 1-contract bullet at the
// current account size. Showing them would just be noise.
//
// Replaces /leaderboard in the mobile bottom nav per owner — daily
// driver should be "where's today's wheel setup?" not "who's winning
// the public leaderboard?"

const CONCENTRATION_CAP_PCT = 0.20  // 20% per-ticker rule from CLAUDE.md

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
  const { profile } = useAuth()
  const accountSize = Number(profile?.account_size) || 0
  const maxPerTicker = accountSize * CONCENTRATION_CAP_PCT

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

  // Decorate every candidate with live price + computed max_contracts.
  // When a price isn't available we fall back to null and the row
  // hides the sizing label rather than guessing.
  const decorated = useMemo(() => {
    return WHEEL_CANDIDATES.map((c) => {
      const q = quotes.get(c.symbol)
      const price = q?.mid ?? q?.bid ?? null
      const prev = q?.prev_close ?? null
      const pct = price != null && prev != null && prev > 0
        ? ((price - prev) / prev) * 100
        : null
      const maxContracts = price != null && maxPerTicker > 0
        ? Math.floor(maxPerTicker / (price * 100))
        : null
      return { ...c, price, pct, maxContracts }
    })
  }, [quotes, maxPerTicker])

  // Filter: when account_size is set, hide candidates whose live
  // price exceeds the 20% cap even at 1 contract. When it isn't set,
  // show everything (the empty-state CTA above takes priority).
  const filtered = accountSize > 0
    ? decorated.filter((c) => c.maxContracts == null || c.maxContracts >= 1)
    : decorated

  const hiddenCount = decorated.length - filtered.length

  const byTier = [1, 2, 3].map((tier) => ({
    tier,
    items: filtered.filter((c) => c.tier === tier),
  })).filter((g) => g.items.length > 0)

  return (
    // pb-24 explicitly guards against any layout pad regression that
    // would let the fixed mobile bottom nav cover the last row. The
    // Layout's main wrapper already pads, this is belt+suspenders.
    <div className="px-4 py-4 pb-24 max-w-2xl mx-auto">
      <header className="mb-4">
        <div className="flex items-center gap-2 mb-1">
          <Star size={16} className="text-amber-400 fill-amber-400" />
          <h1 className="text-lg font-semibold">Wheel Picks</h1>
        </div>
        <p className="text-xs text-subtle leading-relaxed">
          Dividend payers curated for three income streams: dividend
          hold + short-put premium + covered-call premium. Max
          contracts per row enforces the 20% per-ticker cap based on
          your account size. Tap to evaluate GEX + IV before placing.
        </p>
      </header>

      {accountSize <= 0 ? (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 px-4 py-4 mb-4">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="text-amber-400 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-amber-200 mb-1">
                Set your account size
              </div>
              <p className="text-xs text-subtle leading-relaxed">
                Contract sizing depends on the 20% per-ticker cap, which
                needs your account size to compute.{' '}
                <Link to="/settings" className="text-amber-300 underline">
                  Open Settings →
                </Link>
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="text-[10px] text-muted mb-4">
          Account size <span className="text-fg font-mono-tab">${accountSize.toLocaleString()}</span>
          {' · '}
          per-ticker cap <span className="text-fg font-mono-tab">${maxPerTicker.toLocaleString()}</span>
          {hiddenCount > 0 && (
            <>
              {' · '}
              <span className="text-rose-300">{hiddenCount} hidden</span> (too expensive at this account size)
            </>
          )}
        </div>
      )}

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
              const pctTone = c.pct == null
                ? 'text-muted'
                : c.pct >= 0 ? 'text-green-400' : 'text-red-400'
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
                      {c.maxContracts != null && c.maxContracts > 0 && (
                        <span className="text-[10px] text-muted uppercase tracking-wider">
                          {c.maxContracts}c max
                        </span>
                      )}
                      <EarningsBadge ticker={c.symbol} compact withTime />
                    </div>
                    <div className="text-xs text-subtle truncate mt-0.5">
                      {c.label}
                    </div>
                  </div>
                  {c.price != null && (
                    <div className="text-right shrink-0">
                      <div className="text-sm font-mono-tab tabular-nums text-fg leading-none">
                        ${c.price.toFixed(2)}
                      </div>
                      {c.pct != null && (
                        <div className={`text-[10px] tabular-nums leading-none mt-1 ${pctTone}`}>
                          {c.pct >= 0 ? '+' : ''}{c.pct.toFixed(2)}%
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
        rows without a price haven't streamed recently. Max contracts
        = floor((account × 20%) / (price × 100)) — change account size
        in <Link to="/settings" className="text-amber-300 underline">Settings</Link>.
      </div>
    </div>
  )
}
