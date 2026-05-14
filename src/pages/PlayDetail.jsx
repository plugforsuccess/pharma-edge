// PlayDetail — /play/:claude_call_id
//
// The decision-context page between Today's Plays feed and LogSignal.
// Renders the full thesis Claude generated, the matrix at scan time,
// personalized position sizing, what-invalidates-this list, and the
// other plays from the same scan (counterfactual context). The Log
// CTA at the bottom is what actually commits to the signal flow —
// with full provenance (claude_call_id + chosen + others).
//
// Data: the play object lives in top_plays_feed.ranked_plays as a
// jsonb element. We find the latest feed row containing a play with
// the URL's claude_call_id, then pick that play + its peers.

import { useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { logAsSignal } from '../lib/logAsSignal'
import ConvictionDots, { tierFor } from '../components/ConvictionDots'
import MatrixSummaryCard from '../components/MatrixSummaryCard'
import PlayMetricsCard from '../components/PlayMetricsCard'
import { ArrowLeft, ExternalLink, FileText } from 'lucide-react'

function fmtMoney(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  return `$${Math.abs(Number(n)).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
}
// Render the strike pair with explicit long/short + call/put labels so
// a user who doesn't know "Bear Call Spread" by name still sees which
// leg they buy and which they sell. The play object stores long_strike
// (what you buy) and short_strike (what you sell) regardless of
// strategy — option type comes from the strategy.
function describeLegs(play) {
  if (play.type === 'IRON_CONDOR') {
    // Four legs: long_put (lower wing), short_put + short_call (body),
    // long_call (upper wing). Render all four so the reader can see
    // both wing widths at a glance.
    const lp = play.long_put_strike
    const sp = play.short_put_strike
    const sc = play.short_call_strike
    const lc = play.long_call_strike
    if ([lp, sp, sc, lc].every((k) => Number.isFinite(Number(k)))) {
      return `Long $${lp}P · Short $${sp}P · Short $${sc}C · Long $${lc}C`
    }
    return `$${play.long_strike} / $${play.short_strike}`
  }
  const opt = (() => {
    switch (play.type) {
      case 'BULL_CALL':
      case 'BEAR_CALL_CREDIT':
        return 'call'
      case 'BEAR_PUT':
      case 'BULL_PUT_CREDIT':
        return 'put'
      default:
        return null
    }
  })()
  const long = `$${play.long_strike}`
  const short = `$${play.short_strike}`
  if (opt === null) return `${long} / ${short}`
  return `Long ${long} ${opt} · Short ${short} ${opt}`
}
const TIER_TEXT = {
  LOUD:  'text-emerald-400',
  CLEAR: 'text-amber-400',
  FAINT: 'text-zinc-400',
}

export default function PlayDetail() {
  const { claude_call_id: claudeCallId } = useParams()
  const navigate = useNavigate()
  const { profile } = useAuth()
  const [feedRow, setFeedRow] = useState(null)
  // matrix_at_call snapshot from the claude_calls row that produced
  // this play. Lets the compact MatrixSummaryCard show what dealer
  // positioning looked like at scan time, not at view time.
  const [matrixAtCall, setMatrixAtCall] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      // Two independent reads in parallel: the feed row (for play +
      // other plays) and the claude_calls row (for matrix_at_call).
      // Each is single-row + indexed so the fan-out is essentially free.
      const [feedRes, callRes] = await Promise.all([
        supabase
          .from('top_plays_feed')
          .select('id, computed_at, ranked_plays, tickers_succeeded, universe, pricing_source')
          .order('computed_at', { ascending: false })
          .limit(20),
        supabase
          .from('claude_calls')
          .select('matrix_at_call')
          .eq('id', claudeCallId)
          .maybeSingle(),
      ])
      if (cancelled) return
      if (feedRes.error) {
        setError(feedRes.error.message)
        setLoading(false)
        return
      }
      const row = (feedRes.data ?? []).find((r) =>
        Array.isArray(r.ranked_plays) &&
        r.ranked_plays.some((p) => p?.claude_call_id === claudeCallId),
      )
      if (!row) {
        setError('Play not found. The scan may have rotated out of the feed.')
        setLoading(false)
        return
      }
      setFeedRow(row)
      // Matrix snapshot is best-effort — old plays from before the
      // matrix-persistence rollout will have null matrix_at_call. The
      // detail page still renders, the matrix card just doesn't.
      setMatrixAtCall(callRes.data?.matrix_at_call ?? null)
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [claudeCallId])

  const play = useMemo(() => {
    if (!feedRow) return null
    const found = feedRow.ranked_plays.find((p) => p?.claude_call_id === claudeCallId)
    if (!found) return null
    // Row-level pricing_source is the source of truth for plays scanned
    // before per-play stamping rolled out. Newer plays carry their own
    // pricing_source; fall back to the row when missing.
    return { ...found, pricing_source: found.pricing_source ?? feedRow.pricing_source ?? 'estimated' }
  }, [feedRow, claudeCallId])

  const otherPlays = useMemo(() => {
    if (!feedRow || !play) return []
    return feedRow.ranked_plays.filter((p) => p !== play)
  }, [feedRow, play])

  if (loading) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-red-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (error || !play) {
    return (
      <div className="min-h-screen bg-bg px-4 py-12 max-w-md mx-auto">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="text-zinc-400 text-sm mb-6 inline-flex items-center gap-1"
        >
          <ArrowLeft size={14} /> Back
        </button>
        <div className="bg-card border border-border rounded-xl p-6 text-center">
          <p className="text-white text-sm font-display mb-1">Play unavailable</p>
          <p className="text-muted text-xs">{error || 'Not found.'}</p>
        </div>
      </div>
    )
  }

  const tier = tierFor(play.ev_edge_bp)
  const matrix = matrixAtCall || play.matrix_snapshot || null
  const accountSize = Number(profile?.account_size) || 25000
  const maxLoss = Number(play.max_loss_per_spread) || 0
  const maxProfit = Number(play.max_profit_per_spread) || 0
  const suggestedContracts =
    maxLoss > 0 ? Math.max(1, Math.floor((accountSize * 0.02) / maxLoss)) : 1
  const totalRisk = maxLoss * suggestedContracts
  const totalProfit = maxProfit * suggestedContracts

  const minutesAgo = feedRow?.computed_at
    ? Math.max(0, Math.floor((Date.now() - new Date(feedRow.computed_at).getTime()) / 60_000))
    : null

  function handleLog() {
    logAsSignal(navigate, play, play.ticker, matrix?.spot ?? null, null, {
      claudeCallId: play.claude_call_id ?? claudeCallId,
      otherPlays,
    })
  }

  return (
    <div className="min-h-screen bg-bg pb-32">
      <div className="px-4 lg:px-6 pt-6 mx-auto lg:max-w-2xl w-full space-y-3">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="text-zinc-400 text-xs inline-flex items-center gap-1 hover:text-white"
        >
          <ArrowLeft size={12} /> Back
        </button>

        {/* ── Header card ──────────────────────────────────────── */}
        <section className="bg-card border border-border rounded-xl p-4 space-y-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-white text-xl font-bold">{play.ticker}</span>
              <span className="text-zinc-400 text-sm">· {play.strategy}</span>
            </div>
            <p className="text-zinc-300 text-xs">
              {describeLegs(play)}
            </p>
            <p className="text-zinc-500 text-[11px] mt-0.5">
              {play.dte ?? '—'}DTE · exp {play.expiration}
            </p>
          </div>
          <div className="flex items-center gap-3 pt-1">
            <ConvictionDots edge={play.ev_edge_bp} size="lg" />
            <span className={`text-xs font-semibold ${TIER_TEXT[tier]}`}>{tier}</span>
          </div>
          {minutesAgo != null && (
            <p className="text-[10px] text-zinc-500 pt-1 border-t border-border">
              From scan {minutesAgo === 0 ? 'just now' : `${minutesAgo}m ago`} ·
              {' '}{feedRow.tickers_succeeded ?? '?'}/{(feedRow.universe ?? []).length || '?'} tickers
            </p>
          )}
        </section>

        {/* Plays scanned before the verified-pricing rollout carry
            heuristic numbers from Claude — flag them so the user
            knows the scan-time metrics aren't market-anchored. */}
        {play.pricing_source === 'estimated' && (
          <div className="bg-amber-950/30 border border-amber-900/40 rounded-lg px-3 py-2">
            <p className="text-amber-200 text-[11px] leading-relaxed">
              <span className="font-semibold">Scan-time numbers are estimated.</span>{' '}
              This play was scanned before live Polygon pricing was wired in.
              The struck-through metrics below are heuristics, not market mids — trust
              the live recompute.
            </p>
          </div>
        )}

        {/* ── Live risk metrics ─────────────────────────────────
            At-scan numbers (struck-through, muted) vs live Polygon
            recompute (primary). Refreshes every 30s while open.
            Surfaces a degradation banner when R/R has compressed
            >50%, PoP dropped >20pp, or EV flipped negative. */}
        <PlayMetricsCard play={play} />

        {/* ── Matrix summary + narrative ───────────────────────── */}
        {matrix && (
          <>
            <MatrixSummaryCard
              matrix={matrix}
              variant="compact"
              play={{
                strategy: play.strategy,
                long_strike: play.long_strike,
                short_strike: play.short_strike,
                dte: play.dte,
                thesis_kind: play.target_thesis_kind,
              }}
            />
            <Link
              to={`/markets?ticker=${play.ticker}`}
              className="text-xs text-red-400 hover:text-red-300 inline-flex items-center gap-1 px-1"
            >
              View live matrix <ExternalLink size={11} />
            </Link>
          </>
        )}

        {/* ── Claude's thesis ──────────────────────────────────── */}
        {play.rationale && (
          <section className="bg-card border border-border rounded-xl p-4 space-y-2">
            <h3 className="text-zinc-300 text-[11px] font-semibold uppercase tracking-wider">
              Claude's thesis
            </h3>
            {play.market_view && (
              <p className="text-zinc-200 text-sm font-medium">{play.market_view}</p>
            )}
            <p className="text-zinc-400 text-xs leading-relaxed">{play.rationale}</p>
            {play.rolloff_note && (
              <p className="text-amber-300 text-[11px] leading-relaxed pt-1 border-t border-border">
                <span className="font-semibold">Gamma roll-off:</span> {play.rolloff_note}
              </p>
            )}
          </section>
        )}

        {/* ── Position sizing ──────────────────────────────────── */}
        <section className="bg-card border border-border rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-zinc-300 text-[11px] font-semibold uppercase tracking-wider">
              Position sizing
            </h3>
            <Link
              to="/learn/rules"
              className="text-[10px] text-zinc-500 hover:text-white"
            >
              for ${accountSize.toLocaleString()} acct →
            </Link>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            <Row label="Suggested contracts" value={String(suggestedContracts)} />
            <Row label="Max risk" value={fmtMoney(totalRisk)} valueClass="text-red-400" />
            <Row label="Max profit" value={fmtMoney(totalProfit)} valueClass="text-emerald-400" />
            <Row label="Per-spread debit" value={fmtMoney(maxLoss)} />
          </div>
          <p className="text-[10px] text-zinc-500 pt-1 border-t border-border">
            Sized to 2% rule. Adjust account size in <Link to="/learn/rules" className="text-zinc-400 hover:text-white underline">Rules</Link>.
          </p>
        </section>

        {/* ── What invalidates ─────────────────────────────────── */}
        <section className="bg-card border border-red-900/30 rounded-xl p-4 space-y-2">
          <h3 className="text-red-300 text-[11px] font-semibold uppercase tracking-wider">
            What invalidates this trade
          </h3>
          <ul className="text-zinc-400 text-xs space-y-1.5 leading-relaxed">
            {play.what_invalidates && <li>• {play.what_invalidates}</li>}
            {play.target_thesis_kind === 'pin_to' && (
              <li>• Spot breaks out of the {play.target_king_node?.replace('_', ' ')} ${play.target_strike}</li>
            )}
            {play.target_thesis_kind === 'break_through' && (
              <li>• {play.target_king_node?.replace('_', ' ')} at ${play.target_strike} holds (wall doesn't fail)</li>
            )}
            {play.target_thesis_kind === 'fade' && (
              <li>• Spot extends further from ${play.target_strike} instead of reverting</li>
            )}
            <li>• GEX regime flips (current: {matrix?.regime || (matrix?.net_gex > 0 ? 'A' : 'B') || '?'})</li>
            <li>• Wall migrates &gt;$2 from target strike</li>
          </ul>
        </section>

        {/* ── Other plays from this scan ──────────────────────── */}
        {otherPlays.length > 0 && (
          <section className="bg-card border border-border rounded-xl p-4 space-y-2">
            <h3 className="text-zinc-300 text-[11px] font-semibold uppercase tracking-wider">
              Other plays from this scan
            </h3>
            <p className="text-[10px] text-zinc-500 leading-relaxed">
              Counterfactual context — what Claude proposed that you didn't pick.
              All saved on the signal record for post-mortems.
            </p>
            <div className="-mx-4 px-4 overflow-x-auto">
              <div className="flex gap-2 pb-1" style={{ width: 'max-content' }}>
                {otherPlays.slice(0, 8).map((p, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => navigate(`/play/${p.claude_call_id}`)}
                    className="flex-shrink-0 bg-bg border border-border rounded-lg p-2.5 text-left min-w-[140px] hover:border-zinc-700 transition-colors"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-white text-xs font-bold">{p.ticker}</span>
                      <ConvictionDots edge={p.ev_edge_bp} />
                    </div>
                    <p className="text-[10px] text-zinc-500 truncate">{p.strategy}</p>
                    <p className="text-[10px] text-zinc-500">
                      ${p.long_strike}/${p.short_strike} · {p.dte ?? '—'}DTE
                    </p>
                  </button>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* CTA — Log this trade flows you into the calculator step
            inside LogSignal anyway, so a standalone "Open in
            calculator" button (the /calculator route was retired)
            would have been a dead end. */}
        <div className="space-y-2 pt-2">
          <button
            type="button"
            onClick={handleLog}
            className="w-full bg-red-600 hover:bg-red-500 text-white text-sm font-semibold rounded-lg py-3 inline-flex items-center justify-center gap-2"
          >
            <FileText size={14} /> Log this trade
          </button>
        </div>
      </div>
    </div>
  )
}

function Row({ label, value, valueClass = 'text-white' }) {
  return (
    <>
      <span className="text-zinc-500">{label}</span>
      <span className={`text-right font-medium ${valueClass}`}>{value}</span>
    </>
  )
}
