// Cash Moves — compact wheel-CSP strip for the HeatPulse™ (Pulse)
// surface. Surfaces the SAME wheel_suggestions feed the /wheel page
// renders, condensed to the top few cash-secured puts so the Pulse
// page shows what the matrix supports across strategies (Claude
// spreads via SuggestedPlays + deterministic wheel CSPs here).
//
// The wheel feed is universe-wide (a scan), NOT scoped to the
// currently-selected matrix ticker — labelled as such so it isn't
// mistaken for a per-ticker suggestion.
//
// The two non-negotiable, owner-locked UX contracts are preserved
// here exactly as on /wheel:
//   1. UNVERIFIED catalyst is LOUD, never a silent green check.
//   2. An empty feed is EXPLAINED (per-condition tally), never a sad
//      zero.
// Plus the softened-gate honesty rule: a low-confidence IV-rank or
// wall-stability pass is shown as a caveat, not hidden.

import { useEffect, useMemo, useState } from 'react'
import { RefreshCw, AlertTriangle } from 'lucide-react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { supabase } from '../lib/supabase'

const TOP_N = 3

const REASON_LABEL = {
  net_gex_negative: 'negative net GEX',
  pin_prob_low: 'pin probability < 35%',
  spot_at_extreme: 'spot at a wall extreme',
  expected_move_high: 'expected move ≥ 80% to wall',
  iv_rank_low: 'IV rank < 30',
  iv_history_insufficient: 'thin IV history',
  walls_migrating: 'walls migrated 2+ strikes',
  wall_history_insufficient: 'thin wall history',
  opex_within_dte: 'OPEX within DTE',
  earnings_within_dte: 'earnings within DTE',
  macro_within_dte: 'macro event within DTE',
  yield_below_min: 'yield below minimum',
  no_csp_strike: 'no qualifying CSP strike',
  no_csp_quote: 'no live CSP quote',
  no_target_expiration: 'no monthly in DTE band',
  no_gex: 'no GEX data',
  no_walls: 'walls undefined',
  no_spot: 'no spot price',
  stale_matrix: 'stale matrix',
  stale_eod_data: 'overnight data',
}

export default function SuggestedWheel() {
  const [row, setRow] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    supabase
      .from('wheel_suggestions')
      .select('*')
      .order('computed_at', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data, error: err }) => {
        if (cancelled) return
        if (err) {
          setError(err.message)
          setRow(null)
        } else {
          setRow(data)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const suggestions = useMemo(
    () => (Array.isArray(row?.ranked_suggestions) ? row.ranked_suggestions : []),
    [row],
  )
  const top = suggestions.slice(0, TOP_N)
  const anyUnverified = useMemo(
    () =>
      top.some((s) => {
        const c = s?.catalyst_check || {}
        return c.earnings === 'UNVERIFIED' || c.macro === 'UNVERIFIED'
      }),
    [top],
  )

  // Loading / error / not-yet-scanned are quiet — this is a secondary
  // strip on the Pulse page, not the primary surface.
  if (loading) {
    return <div className="bg-card border border-border rounded-xl h-28 animate-pulse" />
  }
  if (error || !row) return null

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 flex items-center justify-between gap-3 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <RefreshCw size={15} className="text-amber-400 shrink-0" />
          <div className="min-w-0">
            <p className="text-fg text-sm font-semibold leading-tight">The Wheel</p>
            <p className="text-muted text-[10px] leading-tight">
              Cash-secured puts across the universe
            </p>
          </div>
        </div>
        <Link
          to="/wheel"
          className="text-amber-400 hover:text-amber-300 text-[11px] font-medium shrink-0"
        >
          View all →
        </Link>
      </div>

      {anyUnverified && (
        <div className="px-4 py-2 bg-amber-950/40 border-b border-amber-900/60 flex items-start gap-2">
          <AlertTriangle size={13} className="text-amber-400 mt-0.5 shrink-0" />
          <p className="text-amber-200 text-[11px] leading-relaxed">
            <span className="font-semibold">Catalyst not verified.</span> No
            earnings/macro feed wired — confirm no earnings or macro event
            before expiry manually before selling any put below.
          </p>
        </div>
      )}

      {top.length === 0 ? (
        <ExplainedEmpty row={row} />
      ) : (
        <div className="divide-y divide-border">
          {top.map((s, i) => (
            <WheelRow key={`${s.ticker}-${s.leg}-${i}`} s={s} />
          ))}
          {suggestions.length > TOP_N && (
            <Link
              to="/wheel"
              className="block px-4 py-2 text-center text-muted hover:text-fg text-[11px]"
            >
              +{suggestions.length - TOP_N} more on The Wheel
            </Link>
          )}
        </div>
      )}
    </div>
  )
}

function WheelRow({ s }) {
  const c = s?.catalyst_check || {}
  const unverified = c.earnings === 'UNVERIFIED' || c.macro === 'UNVERIFIED'
  const lowConf = []
  if (s?.iv_rank_confidence === 'low') lowConf.push('IV rank')
  if (s?.wall_stable_confidence === 'low') lowConf.push('wall stability')

  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-fg font-bold text-sm">{s.ticker}</span>
            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wide border text-red-300 bg-red-950 border-red-800">
              CSP
            </span>
          </div>
          <p className="text-muted text-[11px] truncate mt-0.5">
            Sell put · {fmtStrike(s.strike)} · {fmtDate(s.expiration)}
            {s.dte != null && <> · {s.dte}DTE</>}
            {s.delta != null && <> · {Math.abs(Number(s.delta)).toFixed(2)}Δ</>}
          </p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-green-400 font-bold text-sm font-mono-tab tabular-nums">
            {fmtPct(s.annualized_pct)}
          </div>
          <div className="text-muted text-[10px]">
            {fmtUsd(s.premium)} prem
          </div>
        </div>
      </div>

      {(unverified || lowConf.length > 0) && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {unverified && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-amber-950/50 border border-amber-900/60 text-amber-300">
              <AlertTriangle size={10} /> catalyst unverified
            </span>
          )}
          {lowConf.length > 0 && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-zinc-900 border border-border text-muted">
              low-confidence: {lowConf.join(' + ')}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

// Never a silent zero — show the per-condition tally inline.
function ExplainedEmpty({ row }) {
  const summary = rejectionSummary(row?.gate_rejections)
  return (
    <div className="px-4 py-4 text-center space-y-1.5">
      <p className="text-subtle text-xs">
        No wheel CSPs cleared all seven conditions
        {row?.tickers_scanned != null && <> ({row.tickers_scanned} scanned)</>}.
      </p>
      {summary && (
        <p className="text-muted text-[11px] leading-relaxed">{summary}</p>
      )}
      <Link
        to="/wheel"
        className="inline-block text-amber-400 hover:text-amber-300 text-[11px] font-medium pt-1"
      >
        See the full breakdown →
      </Link>
    </div>
  )
}

function rejectionSummary(gateRejections) {
  if (!gateRejections || typeof gateRejections !== 'object') return null
  const counts = {}
  for (const reasons of Object.values(gateRejections)) {
    for (const r of Array.isArray(reasons) ? reasons : [reasons]) {
      counts[r] = (counts[r] || 0) + 1
    }
  }
  const parts = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([reason, n]) => `${n} ${REASON_LABEL[reason] || reason}`)
  return parts.length ? parts.join(' · ') : null
}

function fmtStrike(v) {
  if (v == null) return '—'
  return `$${Number(v).toFixed(Number(v) % 1 === 0 ? 0 : 2)}`
}
function fmtUsd(v) {
  if (v == null) return '—'
  return `$${Number(v).toFixed(2)}`
}
function fmtPct(v) {
  if (v == null) return '—'
  return `${Number(v).toFixed(1)}%`
}
function fmtDate(d) {
  if (!d) return '—'
  const dt = new Date(`${d}T00:00:00`)
  if (Number.isNaN(dt.getTime())) return String(d)
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
