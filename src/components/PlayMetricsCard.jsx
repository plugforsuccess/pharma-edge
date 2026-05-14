// PlayMetricsCard — at-scan vs live recompute of a play's risk metrics.
//
// Shows three metrics side-by-side: PoP, R/R, EV edge. Each tile shows
// the "at scan" number (struck through, muted) and the live number
// (primary). Up/down arrow next to the live number signals direction
// of change vs scan.
//
// When live degrades materially (R/R drops > 50%, or PoP drops > 20pp,
// or EV flips positive → negative), an amber banner appears above
// the tiles explaining what changed.
//
// Calls refresh-play-quote on mount + every 30s while the page is open.

import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'

const REFRESH_INTERVAL_MS = 30_000

// Map the scanner's "BEAR_CALL_CREDIT" type strings to the kebab-case
// structure the edge function accepts. refresh-play-quote handles
// both forms, but we normalize for clarity.
function normalizeStructure(play) {
  if (play.structure) return play.structure
  const t = play.type
  if (t === 'BULL_CALL') return 'bull_call_spread'
  if (t === 'BEAR_PUT') return 'bear_put_spread'
  if (t === 'BEAR_CALL_CREDIT') return 'bear_call_spread'
  if (t === 'BULL_PUT_CREDIT') return 'bull_put_spread'
  if (t === 'IRON_CONDOR') return 'IRON_CONDOR'
  return null
}

function fmtPctBp(bp) {
  if (bp == null || !Number.isFinite(Number(bp))) return '—'
  return `${Math.round(Number(bp) / 100)}%`
}
function fmtRr(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  return Number(n).toFixed(2)
}
function fmtBp(bp) {
  if (bp == null || !Number.isFinite(Number(bp))) return '—'
  const n = Number(bp)
  return `${n >= 0 ? '+' : ''}${n}bp`
}
function fmtMoney(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  return `$${Number(n).toFixed(2)}`
}

function popDelta(scanBp, liveBp) {
  if (scanBp == null || liveBp == null) return 'neutral'
  const diff = liveBp - scanBp
  if (Math.abs(diff) < 200) return 'neutral'
  return diff > 0 ? 'up' : 'down'
}
function rrDelta(scan, live) {
  if (scan == null || live == null || scan <= 0) return 'neutral'
  const pct = (live - scan) / scan
  if (Math.abs(pct) < 0.05) return 'neutral'
  return pct > 0 ? 'up' : 'down'
}
function evDelta(scanBp, liveBp) {
  if (scanBp == null || liveBp == null) return 'neutral'
  const diff = liveBp - scanBp
  if (Math.abs(diff) < 50) return 'neutral'
  return diff > 0 ? 'up' : 'down'
}

function hasMaterialDegradation(scan, live) {
  const scanRr = Number(scan?.risk_reward)
  const liveRr = Number(live?.risk_reward)
  if (Number.isFinite(scanRr) && Number.isFinite(liveRr) && scanRr > 0) {
    if ((scanRr - liveRr) / scanRr > 0.5) return true
  }
  const scanPop = Number(scan?.entry_pop_bp)
  const livePop = Number(live?.entry_pop_bp)
  if (Number.isFinite(scanPop) && Number.isFinite(livePop)) {
    if ((scanPop - livePop) / 100 > 20) return true
  }
  const scanEv = Number(scan?.ev_edge_bp)
  const liveEv = Number(live?.ev_edge_bp)
  if (Number.isFinite(scanEv) && Number.isFinite(liveEv)) {
    if (scanEv > 0 && liveEv <= 0) return true
  }
  return false
}

export default function PlayMetricsCard({ play }) {
  const [live, setLive] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const structure = normalizeStructure(play)

  const isIC = play.type === 'IRON_CONDOR'
  const fetchLive = useCallback(async () => {
    if (!structure) return
    const reqBody = isIC
      ? {
          ticker: play.ticker,
          structure: 'IRON_CONDOR',
          long_put_strike: Number(play.long_put_strike),
          short_put_strike: Number(play.short_put_strike),
          short_call_strike: Number(play.short_call_strike),
          long_call_strike: Number(play.long_call_strike),
          expiration: play.expiration,
        }
      : {
          ticker: play.ticker,
          structure,
          long_strike: Number(play.long_strike),
          short_strike: Number(play.short_strike),
          expiration: play.expiration,
        }
    const { data, error: e } = await supabase.functions.invoke('refresh-play-quote', {
      body: reqBody,
    })
    if (e) return { error: e.message }
    if (!data?.success) return { error: data?.error || 'live quote failed' }
    return { data: data.data }
  }, [
    play.ticker, structure, isIC, play.expiration,
    play.long_strike, play.short_strike,
    play.long_put_strike, play.short_put_strike,
    play.short_call_strike, play.long_call_strike,
  ])

  useEffect(() => {
    if (!structure) {
      setError(`Live recompute not supported for structure: ${play.type ?? 'unknown'}`)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)

    fetchLive().then((res) => {
      if (cancelled || !res) return
      if (res.error) {
        setError(res.error)
        setLive(null)
      } else {
        setError(null)
        setLive(res.data)
      }
      setLoading(false)
    })

    const interval = setInterval(async () => {
      const res = await fetchLive()
      if (cancelled || !res) return
      if (res.data) {
        setLive(res.data)
        setError(null)
      }
    }, REFRESH_INTERVAL_MS)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [fetchLive, structure, play.type])

  const degraded = live && hasMaterialDegradation(play, live)
  const scanPop = play.entry_pop_bp
  const livePop = live?.entry_pop_bp
  const scanRr = Number(play.risk_reward)
  const liveRr = Number(live?.risk_reward)
  const scanEv = play.ev_edge_bp
  const liveEv = live?.ev_edge_bp

  return (
    <section className="bg-card border border-border rounded-xl p-4 space-y-3">
      <header className="flex items-center justify-between">
        <h3 className="text-zinc-300 text-[11px] font-semibold uppercase tracking-wider">
          Risk metrics
        </h3>
        <span className="text-[10px] text-zinc-500">
          {loading
            ? 'Loading live…'
            : live
              ? `Live · ${live.quote_age_seconds ?? 0}s old`
              : 'Live unavailable'}
        </span>
      </header>

      {degraded && (
        <div className="bg-amber-950/30 border border-amber-900/40 rounded-lg px-3 py-2">
          <p className="text-amber-200 text-[11px] leading-relaxed">
            <span className="font-semibold">Trade quality has degraded.</span>{' '}
            Live R/R is {fmtRr(liveRr)} vs {fmtRr(scanRr)} at scan.{' '}
            {scanEv > 0 && liveEv <= 0 && 'EV edge flipped negative. '}
            Recompute below reflects current Polygon mids — not the cached scan.
          </p>
        </div>
      )}

      <div className="grid grid-cols-3 gap-2">
        <MetricTile
          label="PoP"
          scanValue={fmtPctBp(scanPop)}
          liveValue={live ? fmtPctBp(livePop) : null}
          loading={loading}
          delta={popDelta(scanPop, livePop)}
        />
        <MetricTile
          label="R/R"
          scanValue={fmtRr(scanRr)}
          liveValue={live ? fmtRr(liveRr) : null}
          loading={loading}
          delta={rrDelta(scanRr, liveRr)}
        />
        <MetricTile
          label="EV edge"
          scanValue={fmtBp(scanEv)}
          liveValue={live ? fmtBp(liveEv) : null}
          loading={loading}
          delta={evDelta(scanEv, liveEv)}
        />
      </div>

      {live && (
        <div className="grid grid-cols-3 gap-2 pt-2 border-t border-border">
          <SmallStat
            label={live.is_credit ? 'Credit mid' : 'Debit mid'}
            value={fmtMoney(live.is_credit ? live.credit_mid : live.debit_mid)}
          />
          <SmallStat
            label="Max profit"
            value={`$${Math.round(Number(live.max_profit_dollars ?? live.max_profit_per_spread * 100))}`}
            valueClass="text-emerald-400"
          />
          <SmallStat
            label="Max loss"
            value={`$${Math.round(Number(live.max_loss_dollars ?? live.max_loss_per_spread * 100))}`}
            valueClass="text-rose-400"
          />
          {live.structure === 'IRON_CONDOR' ? (
            <SmallStat
              label="Breakevens"
              value={`${fmtMoney(live.breakeven_lower)} – ${fmtMoney(live.breakeven_upper)}`}
            />
          ) : (
            <SmallStat label="Breakeven" value={fmtMoney(live.breakeven)} />
          )}
          <SmallStat label="Spot" value={fmtMoney(live.spot)} />
          <SmallStat label="IV used" value={live.iv_used != null ? `${(live.iv_used * 100).toFixed(0)}%` : '—'} />
        </div>
      )}

      {error && !live && (
        <p className="text-xs text-rose-400 leading-relaxed">
          Couldn't fetch live quote: {error}. Numbers shown are from scan only.
        </p>
      )}
    </section>
  )
}

function MetricTile({ label, scanValue, liveValue, loading, delta }) {
  const arrow = delta === 'down' ? '↓' : delta === 'up' ? '↑' : ''
  const arrowColor = delta === 'down' ? 'text-rose-400'
    : delta === 'up' ? 'text-emerald-400'
    : 'text-zinc-500'

  return (
    <div className="bg-bg rounded-lg border border-border px-2 py-1.5">
      <p className="text-[10px] text-zinc-500 uppercase tracking-wider">{label}</p>
      <div className="flex items-baseline gap-1.5 mt-0.5">
        <span className="text-[11px] text-zinc-600 line-through">{scanValue}</span>
        {loading ? (
          <span className="text-xs text-zinc-500 animate-pulse">…</span>
        ) : liveValue ? (
          <>
            <span className="text-sm font-semibold text-white">{liveValue}</span>
            {arrow && <span className={`text-xs ${arrowColor}`}>{arrow}</span>}
          </>
        ) : (
          <span className="text-xs text-zinc-500">—</span>
        )}
      </div>
    </div>
  )
}

function SmallStat({ label, value, valueClass = 'text-white' }) {
  return (
    <div>
      <p className="text-[10px] text-zinc-500 uppercase tracking-wider">{label}</p>
      <p className={`text-xs font-semibold ${valueClass}`}>{value}</p>
    </div>
  )
}
