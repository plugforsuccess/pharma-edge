import { useEffect, useState } from 'react'
import { Activity, AlertTriangle, CheckCircle2 } from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../lib/supabase'

// Inline GEX context inside the calculator. The point is to make the
// connective tissue between HeatPulse™ and Log-a-Move that the app
// currently makes the user do mentally: when you pick a strike, are
// you sitting next to The Wall? Above or below The Flip?
//
// Auto-fetches once `ticker` + `expiry` are both set, then again
// when either changes (debounced). Skipped on the standalone
// /calculator surface where neither is known.
//
// The "sanity" copy is intentionally conservative — it describes
// where the chosen short strike sits relative to dealer positioning
// without overclaiming a probability edge. Users still have to
// decide; the strip just surfaces the regime.

export default function CalcGexStrip({
  ticker,
  expiry,
  shortStrike,
  longStrike,
  isCredit,
  popPct,
}) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!ticker || !expiry) {
      setData(null)
      return
    }
    let cancelled = false
    const handle = setTimeout(async () => {
      setLoading(true)
      setError(null)
      try {
        const { data: result, error: invokeErr } = await supabase.functions.invoke(
          'compute-gex',
          { body: { ticker: ticker.toUpperCase(), expiration: expiry } },
        )
        if (cancelled) return
        if (invokeErr) {
          let msg = invokeErr.message || 'request failed'
          try {
            const body = await invokeErr.context?.json?.()
            if (body?.error) msg = body.error
          } catch { /* keep generic */ }
          throw new Error(msg)
        }
        if (!result?.success) throw new Error(result?.error || 'compute-gex returned no data')
        setData(result.data)
      } catch (e) {
        if (!cancelled) setError(e.message || 'fetch failed')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 600)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [ticker, expiry])

  if (!ticker || !expiry) return null

  if (loading) {
    return (
      <div className="bg-bg border border-border rounded-xl p-3 text-[10px] text-muted">
        Loading GEX context for {ticker} {expiry}…
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-bg border border-border rounded-xl p-3 flex items-start gap-2">
        <AlertTriangle size={12} className="text-yellow-400 mt-0.5 flex-shrink-0" />
        <p className="text-[10px] text-yellow-400 leading-relaxed">
          GEX context unavailable: {error}
        </p>
      </div>
    )
  }

  if (!data) return null

  const { spot, zero_gamma_strike: flip, largest_positive_strike: wall, source } = data
  const shortNum = toNumOrNull(shortStrike)
  const longNum = toNumOrNull(longStrike)

  // GEX-vs-trade sanity. The heuristic is direction-aware:
  //   - bull put credit / bull call: want spot to drift UP toward
  //     short strike. The wall (positive-gamma magnet) acts as a
  //     ceiling; if short strike is below the wall, the wall is
  //     supportive (dampens upside vol around there). If above the
  //     wall, the trade fights dealer positioning.
  //   - bear call credit / bear put: want spot DOWN. Same logic
  //     mirrored — short strike above the wall is the supportive case.
  //
  // Below-the-flip regime is vol-amplifying (negative gamma), which
  // helps DEBIT spreads (you want movement) and hurts CREDIT spreads
  // (you want stillness).
  const sanity = computeSanity({
    spot,
    flip,
    wall,
    shortStrike: shortNum,
    longStrike: longNum,
    isCredit,
    popPct,
  })

  return (
    <div className="bg-bg border border-border rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity size={12} className="text-amber-400" />
          <span className="text-muted text-[10px] uppercase tracking-wider font-bold">
            GEX context · {ticker}
          </span>
        </div>
        <span
          className={clsx(
            'text-[10px] font-semibold',
            source === 'dxlink' ? 'text-green-400' : 'text-yellow-400',
          )}
        >
          {source === 'dxlink' ? 'LIVE' : '15M'}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        <Cell label="Spot" value={spot} tone="text-fg" />
        <Cell label="The Flip" value={flip} tone="text-amber-400" sub="zero gamma" />
        <Cell label="The Wall" value={wall} tone="text-purple-400" sub="dealer peak" />
      </div>

      {sanity && (
        <div
          className={clsx(
            'rounded-lg p-3 flex items-start gap-2 text-[10px] leading-relaxed border',
            sanity.tone === 'support' && 'bg-green-950/15 border-green-900/30 text-green-400',
            sanity.tone === 'mixed' && 'bg-yellow-950/15 border-yellow-900/30 text-yellow-400',
            sanity.tone === 'against' && 'bg-red-950/15 border-red-900/30 text-red-400',
          )}
        >
          {sanity.tone === 'support' ? (
            <CheckCircle2 size={12} className="mt-0.5 flex-shrink-0" />
          ) : (
            <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
          )}
          <span>{sanity.text}</span>
        </div>
      )}
    </div>
  )
}

function Cell({ label, value, tone, sub }) {
  return (
    <div>
      <p className={clsx('font-bold text-sm', tone)}>
        {value != null ? `$${Number(value).toFixed(2)}` : '—'}
      </p>
      <p className="text-muted text-[10px] uppercase tracking-wider mt-0.5">{label}</p>
      {sub && <p className="text-muted text-[10px]">{sub}</p>}
    </div>
  )
}

function computeSanity({ spot, flip, wall, shortStrike, longStrike, isCredit, popPct }) {
  if (!(spot > 0) || !(wall > 0)) return null
  if (shortStrike == null) return null

  // Direction inferred from where the long strike sits relative to short.
  // For verticals: long < short → bullish (BULL_CALL or BULL_PUT_CREDIT);
  // long > short → bearish (BEAR_PUT or BEAR_CALL_CREDIT).
  const bullish = longNumLessThanShort(longStrike, shortStrike)
  const bearish = longNumGreaterThanShort(longStrike, shortStrike)
  if (!bullish && !bearish) return null

  const shortVsWall = shortStrike - wall
  const wallSupportsBull = shortVsWall <= 0 // wall above short = upside ceiling damped
  const wallSupportsBear = shortVsWall >= 0 // wall below short = downside floor damped

  const supportive = (bullish && wallSupportsBull) || (bearish && wallSupportsBear)
  const popHigh = typeof popPct === 'number' && popPct >= 60

  if (supportive && popHigh) {
    return {
      tone: 'support',
      text: `Dealer positioning supports the implied probability — wall at $${wall.toFixed(2)} sits ${
        bullish ? 'above' : 'below'
      } your short strike, helping cap moves against the trade.`,
    }
  }
  if (supportive) {
    return {
      tone: 'support',
      text: `Wall at $${wall.toFixed(2)} sits ${
        bullish ? 'above' : 'below'
      } your short strike — dealer hedging tends to dampen the side that hurts this trade.`,
    }
  }
  if (popHigh) {
    return {
      tone: 'against',
      text: `Implied PoP looks high (${popPct}%) but dealer wall at $${wall.toFixed(2)} sits ${
        bullish ? 'below' : 'above'
      } your short — GEX positioning contradicts the IV read.`,
    }
  }
  return {
    tone: 'mixed',
    text: `Wall at $${wall.toFixed(2)} sits ${
      bullish ? 'below' : 'above'
    } your short strike. Dealer hedging amplifies moves that hurt this trade — size carefully.`,
  }
}

function longNumLessThanShort(longStrike, shortStrike) {
  return typeof longStrike === 'number' && typeof shortStrike === 'number' && longStrike < shortStrike
}
function longNumGreaterThanShort(longStrike, shortStrike) {
  return typeof longStrike === 'number' && typeof shortStrike === 'number' && longStrike > shortStrike
}

function toNumOrNull(value) {
  if (value === '' || value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
