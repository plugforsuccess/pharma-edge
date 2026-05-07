import { useEffect, useMemo, useState } from 'react'
import { Activity, TrendingDown, TrendingUp } from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../lib/supabase'

// Market Pulse hero — the Tape's top-of-page anchor.
//
// Answers "what's the market doing right now?" in one card without
// the user having to navigate to /markets:
//   - Live spot for the active ticker (polled from dxlink_quotes
//     equity row every 2s)
//   - Intraday change vs prev_close
//   - GEX regime: positive (pin / vol-suppressed) vs negative
//     (vol-amplified) based on net total_gex sign + spot's position
//     relative to the zero-gamma flip
//   - The Flip + The Wall levels for the chosen expiration
//   - Source badge so the user knows whether they're looking at
//     LIVE DXLink data or 15M-delayed Yahoo
//
// Driven by compute-gex's non-matrix shape (single-expiration
// snapshot). Refreshes when `ticker` changes; the spot tick comes
// from a separate equity-row poll so we don't hammer compute-gex.

export default function MarketPulse({ ticker }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [liveSpot, setLiveSpot] = useState(null)

  // Pull the GEX snapshot when ticker changes. compute-gex caches 5
  // minutes server-side, so flipping back and forth between tickers
  // is cheap.
  useEffect(() => {
    if (!ticker) return
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const { data: result, error: invokeErr } = await supabase.functions.invoke(
          'compute-gex',
          { body: { ticker: ticker.toUpperCase() } },
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
        if (!result?.success) throw new Error(result?.error || 'no data')
        setData(result.data)
      } catch (e) {
        if (!cancelled) setError(e.message || 'fetch failed')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [ticker])

  // Live spot poll — equity row in dxlink_quotes ticks every quote
  // frame from the dxlink-worker. 2s cadence is enough for a hero
  // surface; the matrix uses the same hook elsewhere.
  useEffect(() => {
    if (!ticker) return
    let cancelled = false
    async function tick() {
      const { data } = await supabase
        .from('dxlink_quotes')
        .select('mid, last, bid, ask, prev_close, updated_at')
        .eq('symbol', ticker.toUpperCase())
        .eq('kind', 'equity')
        .maybeSingle()
      if (cancelled || !data) return
      const age = Date.now() - new Date(data.updated_at).getTime()
      if (age > 30_000) return // stale; let the snapshot's spot speak
      let s = Number(data.mid)
      if (!Number.isFinite(s)) s = Number(data.last)
      if (!Number.isFinite(s) && Number.isFinite(Number(data.bid)) && Number.isFinite(Number(data.ask))) {
        s = (Number(data.bid) + Number(data.ask)) / 2
      }
      if (Number.isFinite(s) && s > 0) {
        setLiveSpot({ value: s, prevClose: Number(data.prev_close) || null })
      }
    }
    tick()
    const id = setInterval(tick, 2000)
    return () => { cancelled = true; clearInterval(id) }
  }, [ticker])

  const view = useMemo(() => deriveView(data, liveSpot), [data, liveSpot])

  if (loading && !data) {
    return (
      <div className="surface rounded-2xl p-4 mb-5 animate-pulse">
        <div className="h-3 w-24 bg-white/5 rounded mb-3" />
        <div className="h-8 w-40 bg-white/5 rounded mb-4" />
        <div className="grid grid-cols-3 gap-3">
          <div className="h-12 bg-white/5 rounded" />
          <div className="h-12 bg-white/5 rounded" />
          <div className="h-12 bg-white/5 rounded" />
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="surface rounded-2xl p-4 mb-5 border border-yellow-900/40">
        <p className="eyebrow text-yellow-400">Market pulse · {ticker}</p>
        <p className="text-yellow-400 text-xs mt-2">{error}</p>
      </div>
    )
  }

  if (!view) return null

  return (
    <div className="surface rounded-2xl p-4 mb-5">
      <div className="flex items-center justify-between mb-2">
        <p className="eyebrow inline-flex items-center gap-1.5">
          <Activity size={11} className="text-amber-400" />
          Market Pulse · {ticker}
        </p>
        <span
          className={clsx(
            'text-[10px] font-bold tracking-wider',
            view.source === 'dxlink' ? 'text-green-400' : 'text-yellow-400',
          )}
        >
          {view.source === 'dxlink' ? 'LIVE' : '15M DELAYED'}
        </span>
      </div>

      <div className="flex items-baseline gap-3 mb-3">
        <span className="font-display num-tab text-3xl text-fg">
          ${view.spot.toFixed(2)}
        </span>
        {view.changePct != null && (
          <span
            className={clsx(
              'inline-flex items-center gap-1 text-sm font-mono-tab tabular-nums',
              view.changePct >= 0 ? 'text-green-400' : 'text-[#f25068]',
            )}
          >
            {view.changePct >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
            {view.changePct >= 0 ? '+' : ''}{view.changePct.toFixed(2)}%
          </span>
        )}
      </div>

      {/* Regime callout — the plain-English read of dealer
          positioning. Two flavors: positive-gamma "pin" environment
          (spot inside the wall cluster, vol gets dampened) vs
          negative-gamma "amplify" (below the flip, dealers hedge
          against the move so vol expands). */}
      <p
        className={clsx(
          'text-xs leading-relaxed mb-3',
          view.regimeTone === 'positive' && 'text-green-400',
          view.regimeTone === 'negative' && 'text-[#f25068]',
          view.regimeTone === 'neutral' && 'text-subtle',
        )}
      >
        {view.regimeText}
      </p>

      <div className="grid grid-cols-3 gap-2">
        <PulseCell
          label="The Flip"
          value={view.flip != null ? `$${view.flip.toFixed(2)}` : '—'}
          sub="zero gamma"
          tone="amber"
        />
        <PulseCell
          label="The Wall"
          value={view.wall != null ? `$${view.wall.toFixed(2)}` : '—'}
          sub="dealer peak"
          tone="purple"
        />
        <PulseCell
          label="Net GEX"
          value={view.totalGex != null ? formatGex(view.totalGex) : '—'}
          sub={view.expiration ?? ''}
          tone={view.totalGex >= 0 ? 'green' : 'red'}
        />
      </div>
    </div>
  )
}

function PulseCell({ label, value, sub, tone }) {
  const toneClass = {
    amber: 'text-amber-400',
    purple: 'text-purple-400',
    green: 'text-green-400',
    red: 'text-[#f25068]',
    neutral: 'text-fg',
  }[tone] ?? 'text-fg'
  return (
    <div className="bg-bg-elev/40 border border-border rounded-lg p-2 text-center">
      <p className={clsx('font-mono-tab tabular-nums text-sm font-semibold', toneClass)}>
        {value}
      </p>
      <p className="eyebrow text-[10px] mt-0.5">{label}</p>
      {sub && <p className="text-muted text-[10px] truncate">{sub}</p>}
    </div>
  )
}

function deriveView(snapshot, liveSpot) {
  if (!snapshot) return null
  const spot = liveSpot?.value ?? snapshot.spot
  if (!Number.isFinite(spot)) return null

  const prevClose = liveSpot?.prevClose ?? null
  const changePct =
    prevClose && prevClose > 0 ? ((spot - prevClose) / prevClose) * 100 : null

  const flip = snapshot.zero_gamma_strike
  const wall = snapshot.largest_positive_strike
  const totalGex = snapshot.total_gex
  const expiration = snapshot.expiration

  // Regime classification:
  //   positive: spot above flip → positive-gamma side, dealers long
  //     gamma → pin / vol-suppressed
  //   negative: spot below flip → negative-gamma → vol amplified
  //   neutral: no flip available
  let regimeTone = 'neutral'
  let regimeText = `Snapshot from ${snapshot.expiration ?? 'next expiration'}.`
  if (Number.isFinite(flip) && Number.isFinite(spot)) {
    if (spot > flip) {
      regimeTone = 'positive'
      const wallText = Number.isFinite(wall) ? ` Wall at $${wall.toFixed(2)}.` : ''
      regimeText = `Positive gamma above $${flip.toFixed(2)} flip — dealers sell rallies, buy dips. Pin environment.${wallText}`
    } else {
      regimeTone = 'negative'
      regimeText = `Below the $${flip.toFixed(2)} flip — dealer hedging amplifies moves. Trend / vol-expansion regime.`
    }
  }

  return {
    spot,
    changePct,
    flip,
    wall,
    totalGex,
    expiration,
    source: snapshot.source,
    regimeTone,
    regimeText,
  }
}

function formatGex(v) {
  if (!Number.isFinite(v)) return '—'
  const abs = Math.abs(v)
  const sign = v >= 0 ? '+' : '-'
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(0)}M`
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`
  return `${sign}$${abs.toFixed(0)}`
}
