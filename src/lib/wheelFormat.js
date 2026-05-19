// Cash Moves — shared wheel presentation helpers.
//
// Single source of truth for the wheel-strategy UI surfaces (/wheel,
// the SuggestedWheel strip on Pulse, and the on-demand WheelAnalyze
// panel). Centralised so the locked UX contracts — the 7-condition
// labels, the human reason text for every gate code, the
// explained-rejection tally — never drift between surfaces.

// The 7 entry conditions, in spec order. `key` matches the boolean the
// scanner writes into each suggestion's `conditions` object.
export const CONDITIONS = [
  { key: 'net_gex_positive', label: 'Net GEX +', hint: 'Dealers long gamma (pinning regime)' },
  { key: 'pin_prob_ok', label: 'Pin ≥ 35%', hint: 'Pin probability at or above 35%' },
  { key: 'spot_between_walls', label: 'In channel', hint: 'Spot inside the channel and ≥2% above the put wall' },
  { key: 'expected_move_ok', label: 'EM cushion', hint: 'Spot is ≥1 expected move above the put wall' },
  { key: 'iv_rank_ok', label: 'IVR ≥ 30', hint: 'IV rank at or above 30' },
  { key: 'walls_stable', label: 'Wall holding', hint: 'Put wall not eroding — a rising/flat wall is fine; only a >1 EM fall rejects' },
  { key: 'catalyst_clear', label: 'No catalyst', hint: 'No earnings / FOMC / CPI within DTE' },
]

export const REASON_LABEL = {
  net_gex_negative: 'negative net GEX',
  pin_prob_low: 'pin probability < 35%',
  spot_at_extreme: 'spot not clear of the put wall',
  expected_move_high: 'less than 1 EM of room to the put wall',
  iv_rank_low: 'IV rank < 30',
  iv_history_insufficient: 'thin IV history',
  put_wall_eroding: 'put wall eroding (support fell > 1 EM)',
  walls_migrating: 'put wall migrated (legacy)',
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
  no_chain: 'no option chain',
}

export function reasonText(code) {
  return REASON_LABEL[code] || code
}

// Tally a gate_rejections object ({ticker: [codes]}) into a one-line
// human summary, most-common first. `limit` caps the distinct reasons
// shown (the compact strip uses 4; the full pages pass Infinity).
export function rejectionSummary(gateRejections, limit = Infinity) {
  if (!gateRejections || typeof gateRejections !== 'object') return null
  const counts = {}
  for (const reasons of Object.values(gateRejections)) {
    for (const r of Array.isArray(reasons) ? reasons : [reasons]) {
      counts[r] = (counts[r] || 0) + 1
    }
  }
  const parts = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([reason, n]) => `${n} ${reasonText(reason)}`)
  return parts.length ? parts.join(' · ') : null
}

export function fmtStrike(v) {
  if (v == null) return '—'
  return `$${Number(v).toFixed(Number(v) % 1 === 0 ? 0 : 2)}`
}

export function fmtUsd(v) {
  if (v == null) return '—'
  return `$${Number(v).toFixed(2)}`
}

export function fmtUsd0(v) {
  if (v == null) return '—'
  return `$${Math.round(Number(v)).toLocaleString()}`
}

export function fmtPct(v) {
  if (v == null) return '—'
  return `${Number(v).toFixed(1)}%`
}

export function fmtDate(d) {
  if (!d) return '—'
  const dt = new Date(`${d}T00:00:00`)
  if (Number.isNaN(dt.getTime())) return String(d)
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// Compact signed $ abbreviation for large net-GEX magnitudes.
export function fmtGex(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—'
  const n = Number(v)
  const a = Math.abs(n)
  const sign = n < 0 ? '−' : ''
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(1)}B`
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)}M`
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(0)}K`
  return `${sign}$${a.toFixed(0)}`
}

export function formatRelative(iso) {
  if (!iso) return 'just now'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`
  return `${Math.round(ms / 86_400_000)}d ago`
}
