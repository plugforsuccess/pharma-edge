import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, X, AlertTriangle, RefreshCw, Check, Clock, Target, Shield, Info } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import Spinner from '../components/Spinner'
import { computeThesisVerdict } from '../utils/thesisVerdict'

// Detail view for a single open_position. Shows entry, live mid, P&L,
// triggered alerts, and a "Close Position" flow that submits an inverse
// debit/credit spread to record the close (and hashes the outcome via
// the existing outcome flow when the position is linked to a signal).
//
// Manual close path (no broker call): user enters an exit credit and
// taps Save — we update the row to status='closed' and compute the
// realized P&L. This is the path most users will take if they're
// trading on Robinhood / outside the app.

export default function PositionDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user, profile } = useAuth()
  const [searchParams] = useSearchParams()
  const [pos, setPos] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // Auto-open the close form when arriving via OpenPositions row X.
  const [closeMode, setCloseMode] = useState(searchParams.get('close') === '1')
  const [exitCredit, setExitCredit] = useState('')
  const [closing, setClosing] = useState(false)
  // Wall-timing context. Lazy-fetched after the position loads — we
  // need pos.ticker to ask compute-gex for the live matrix, then we
  // surface the relationship between the wall's expiration and the
  // trade's expiration. Non-blocking; the rest of the page renders
  // without waiting.
  // Bumped by the header Refresh button (and the auto-refresh
  // interval below) to force the compute-gex effect to re-fetch
  // live wall/spot/move data. Without this the effect only re-runs
  // when pos.ticker/expiration/strikes change — which they don't
  // across a refresh — so tapping Refresh felt like a no-op.
  const [refreshTick, setRefreshTick] = useState(0)
  const [wallInfo, setWallInfo] = useState(null)
  // Move context derived from the same compute-gex fetch — today's
  // realized move vs the option market's expected move, plus an
  // expected move scaled to the trade's remaining DTE (using iv_used
  // returned from the matrix payload).
  const [moveInfo, setMoveInfo] = useState(null)
  // Linked signal row, loaded so we can read entry_gex_snapshot for
  // the entry-vs-now diff card. Skipped for manual positions without
  // a signal_id link.
  const [signalRow, setSignalRow] = useState(null)
  // Per-leg Greeks pulled from dxlink_quotes. Populated when the
  // worker is subscribed to the spread's strikes; shows "—" otherwise.
  // Per-spread net = long − short (long-leg Greeks dominate exposure
  // for debit spreads). Multiply by 100 × contracts for total dollar-
  // denominated values where the card calls them out explicitly.
  const [legGreeks, setLegGreeks] = useState(null)
  // Live Tastytrade working orders matching the signal's ticker +
  // expiration. Populated by the get-working-orders edge function.
  // Refresh button on the card re-runs the fetch.
  const [workingOrders, setWorkingOrders] = useState(null)
  const [workingOrdersLoading, setWorkingOrdersLoading] = useState(false)
  const [workingOrdersError, setWorkingOrdersError] = useState(null)
  // Bracket-edit modal state. Holds the order being edited (or null).
  // Modal owns its own inline form fields; we only need to know which
  // order is open here so the Save handler can dispatch + refresh.
  const [editingOrder, setEditingOrder] = useState(null)

  async function load() {
    setLoading(true)
    setError(null)
    const { data, error: err } = await supabase
      .from('open_positions')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    setLoading(false)
    if (err) {
      setError(err.message)
      return
    }
    if (!data) {
      setError('Position not found.')
      return
    }
    setPos(data)
    if (data.last_mid_per_spread != null) {
      setExitCredit(String(data.last_mid_per_spread))
    }
  }

  useEffect(() => {
    if (id) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  useEffect(() => {
    if (!pos?.ticker) return
    let cancelled = false
    ;(async () => {
      const { data, error: gexErr } = await supabase.functions.invoke('compute-gex', {
        body: { ticker: pos.ticker, matrix: true },
      })
      if (cancelled) return
      if (gexErr || !data?.success || !data?.data?.largest) return
      const wallExp = data.data.largest.expiration
      const wallStrike = data.data.largest.strike
      const wallDte = daysUntil(wallExp)
      const tradeDte = daysUntil(pos.expiration)
      const diff = wallDte - tradeDte
      let label
      let tone
      let interpretation
      if (Math.abs(diff) <= 1) {
        label = 'Trade closes at the wall\'s peak gamma window'
        tone = 'amber'
        interpretation = 'Full wall magnetism in force during your hold. Pin probability is at its strongest right at expiration.'
      } else if (diff > 1) {
        label = `Wall peaks in ${diff} day${diff === 1 ? '' : 's'} — after your trade closes`
        tone = 'subtle'
        interpretation = pinOrBreakInterpretation(pos, wallStrike, /*wallAfter=*/true)
      } else {
        label = `Wall already peaked ${Math.abs(diff)} day${Math.abs(diff) === 1 ? '' : 's'} ago — gamma rolling off`
        tone = 'neg'
        interpretation = 'The dominant gamma cluster anchoring this thesis has already expired. Dealer hedges have rolled off; price discovery is freer.'
      }
      setWallInfo({
        wallStrike,
        wallExp,
        wallDte,
        tradeDte,
        diff,
        label,
        tone,
        interpretation,
        spot: data.data.spot,
        netGex: data.data.net_gex,
      })

      // Move context. Server returns prev_close + 1-day expected
      // move; we scale to the trade's remaining DTE locally so we
      // don't need a separate cache key per DTE on the server.
      const ivUsed = data.data.iv_used
      const spot = data.data.spot
      const prevClose = data.data.prev_close
      const expectedToday = data.data.expected_move_today
      const expectedTodayPct = data.data.expected_move_today_pct
      const realizedToday = data.data.realized_move_today
      const realizedTodayPct = data.data.realized_move_today_pct
      const realizedPctOfToday = data.data.realized_pct_of_today
      // sqrt-of-time scaling for the trade's remaining DTE
      const expectedTrade = ivUsed && tradeDte > 0
        ? spot * ivUsed * Math.sqrt(tradeDte / 365)
        : null
      const expectedTradePct = expectedTrade && spot > 0 ? expectedTrade / spot : null
      setMoveInfo({
        spot,
        prevClose: prevClose ?? null,
        expectedToday: expectedToday ?? null,
        expectedTodayPct: expectedTodayPct ?? null,
        realizedToday: realizedToday ?? null,
        realizedTodayPct: realizedTodayPct ?? null,
        realizedPctOfToday: realizedPctOfToday ?? null,
        expectedTrade,
        expectedTradePct,
        tradeDte,
        ivUsed: ivUsed ?? null,
      })
    })()
    return () => { cancelled = true }
  }, [pos?.ticker, pos?.expiration, pos?.long_strike, pos?.short_strike, pos?.strategy_type, refreshTick])

  // Auto-refresh the live data every 60s while the tab is visible.
  // compute-gex has a 5-min server cache so most ticks are cheap; the
  // point is to make sure the spot/wall/move data tracks the market
  // without forcing the user to keep tapping Refresh. Pauses when the
  // tab is backgrounded so we don't burn bandwidth in a stale tab.
  useEffect(() => {
    if (!pos?.ticker) return
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        setRefreshTick((t) => t + 1)
      }
    }, 60_000)
    return () => clearInterval(id)
  }, [pos?.ticker])

  // Pull the linked signal so the entry-vs-now diff card can read
  // signal.entry_gex_snapshot. Best-effort: rows without a signal_id
  // (manual position adds) skip this entirely.
  useEffect(() => {
    if (!pos?.signal_id) {
      setSignalRow(null)
      return
    }
    let cancelled = false
    ;(async () => {
      const { data } = await supabase
        .from('signals')
        .select('id, entry_gex_snapshot, logged_at, signal_source, target_king_node, target_strike, target_expiration, target_thesis_kind, regime_at_entry')
        .eq('id', pos.signal_id)
        .maybeSingle()
      if (!cancelled) setSignalRow(data ?? null)
    })()
    return () => { cancelled = true }
  }, [pos?.signal_id])

  // Live Tastytrade working orders for this signal. Skipped silently
  // if pos has no signal_id (open_position not linked back to a logged
  // signal — happens for manually-added rows).
  async function loadWorkingOrders() {
    if (!pos?.signal_id) return
    setWorkingOrdersLoading(true)
    setWorkingOrdersError(null)
    const { data, error: woErr } = await supabase.functions.invoke('get-working-orders', {
      body: { signal_id: pos.signal_id },
    })
    setWorkingOrdersLoading(false)
    if (woErr) {
      setWorkingOrdersError(woErr.message ?? 'fetch failed')
      return
    }
    if (!data?.success) {
      setWorkingOrdersError(data?.error ?? 'fetch failed')
      return
    }
    setWorkingOrders(data.data?.working_orders ?? [])
  }
  useEffect(() => {
    loadWorkingOrders()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos?.signal_id])

  // Per-leg Greeks fetch from dxlink_quotes. The worker subscribes to
  // front-2 expirations within ATM ± 25%, so this only finds rows for
  // spreads inside that window — far-OTM or back-month legs come back
  // null and the NetGreeksCard renders "—" honestly. Match by OCC
  // symbol when present (most accurate); otherwise fall back to the
  // (underlying, expiration_date, strike, option_type) compound key.
  useEffect(() => {
    if (!pos?.ticker || !pos?.expiration || !pos?.long_strike || !pos?.short_strike) return
    let cancelled = false
    ;(async () => {
      const isCall = (pos.strategy_type || '').toLowerCase().includes('call')
      const optionType = isCall ? 'C' : 'P'
      let query = supabase
        .from('dxlink_quotes')
        .select('symbol, strike, option_type, delta, gamma, theta, vega, iv, mid, updated_at')
        .eq('underlying', pos.ticker)
        .eq('kind', 'option')
        .eq('expiration_date', pos.expiration)
        .eq('option_type', optionType)
        .in('strike', [Number(pos.long_strike), Number(pos.short_strike)])
      const { data, error: gErr } = await query
      if (cancelled) return
      if (gErr || !Array.isArray(data) || data.length === 0) {
        setLegGreeks({ long: null, short: null, available: false })
        return
      }
      const longRow = data.find((r) => Number(r.strike) === Number(pos.long_strike))
      const shortRow = data.find((r) => Number(r.strike) === Number(pos.short_strike))
      setLegGreeks({
        long: longRow ?? null,
        short: shortRow ?? null,
        // We consider the data "available" only when BOTH legs return
        // a row. A one-sided fetch produces a misleading net (the
        // missing leg's Greeks aren't zero, they're unknown).
        available: Boolean(longRow && shortRow),
      })
    })()
    return () => { cancelled = true }
  }, [pos?.ticker, pos?.expiration, pos?.long_strike, pos?.short_strike, pos?.strategy_type, refreshTick])

  async function handleClose() {
    if (!pos || !exitCredit) return
    const credit = Number(exitCredit)
    if (!Number.isFinite(credit) || credit < 0) {
      setError('Exit credit must be a positive number')
      return
    }
    setClosing(true)
    setError(null)

    const realized =
      (credit - pos.entry_debit_per_spread) * pos.contracts * 100
    const { error: updateErr } = await supabase
      .from('open_positions')
      .update({
        status: 'closed',
        closed_at: new Date().toISOString(),
        exit_credit_per_spread: credit,
        realized_pnl: realized,
      })
      .eq('id', pos.id)
    setClosing(false)
    if (updateErr) {
      setError(updateErr.message)
      return
    }
    await load()
    setCloseMode(false)
  }

  // Dynamic thesis verdict — computed client-side from already-loaded
  // data so the banner renders the moment the page is interactive.
  // Server-side monitor-positions writes the same value to
  // pos.last_verdict on every poll for push-notification transitions;
  // we surface the live computation here so users don't have to wait
  // for the next cron tick to see drift.
  //
  // CRITICAL: this useMemo MUST sit before the early returns below.
  // React's Rules of Hooks require hook calls to happen in the same
  // order on every render. If we hit `if (loading) return` before
  // useMemo on the first render and only call useMemo on later
  // renders, the hook count changes and React crashes the page.
  const verdict = useMemo(() => {
    if (!pos) return null
    // Build the live snapshot from whatever data we have. Prefer
    // wallInfo (which carries the wall strike/expiration), but fall
    // back to moveInfo when wallInfo is null — happens whenever
    // compute-gex's Yahoo path returns a payload without `largest`,
    // which leaves wallInfo unset. moveInfo only carries spot, but
    // the structured verdict's break_through path only needs spot
    // anyway, so we can still render a meaningful verdict.
    const liveSnapshot = wallInfo
      ? {
          spot: wallInfo.spot,
          net_gex: wallInfo.netGex,
          largest_wall: {
            strike: wallInfo.wallStrike,
            expiration: wallInfo.wallExp,
            gex_net: 0, // not used by verdict
          },
        }
      : Number.isFinite(moveInfo?.spot)
        ? {
            spot: moveInfo.spot,
            net_gex: null,
            largest_wall: null,
          }
        : null
    return computeThesisVerdict(signalRow?.entry_gex_snapshot, liveSnapshot, {
      long_strike: Number(pos?.long_strike),
      short_strike: Number(pos?.short_strike),
      strategy_type: pos?.strategy_type,
      expiration: pos?.expiration ?? null,
      // Phase 3a structured thesis fields. When present, the verdict
      // takes the structured path; when null, falls back to heuristics.
      target_king_node: signalRow?.target_king_node ?? null,
      target_strike: signalRow?.target_strike ?? null,
      target_expiration: signalRow?.target_expiration ?? null,
      target_thesis_kind: signalRow?.target_thesis_kind ?? null,
      regime_at_entry: signalRow?.regime_at_entry ?? null,
    })
  }, [
    pos,
    wallInfo,
    moveInfo?.spot,
    signalRow?.entry_gex_snapshot,
    signalRow?.target_king_node,
    signalRow?.target_strike,
    signalRow?.target_thesis_kind,
  ])

  if (loading) {
    return (
      <div className="px-4 lg:px-6 py-12 max-w-md lg:max-w-3xl mx-auto flex items-center justify-center gap-2">
        <Spinner size="md" />
        <span className="text-xs text-subtle">Loading position…</span>
      </div>
    )
  }

  if (error && !pos) {
    return (
      <div className="px-4 lg:px-6 py-6 max-w-md lg:max-w-3xl mx-auto space-y-3">
        <button
          onClick={() => navigate(-1)}
          className="text-xs text-subtle hover:text-fg inline-flex items-center gap-1"
        >
          <ArrowLeft size={12} /> Back
        </button>
        <p className="text-sm text-crimson">{error}</p>
      </div>
    )
  }

  if (!pos) return null

  // Compute live P&L from the per-leg mid prices the dxlink-worker
  // streams into dxlink_quotes. The DB columns `pos.last_mid_per_spread`
  // and `pos.last_pnl_pct` are only updated by a periodic worker (every
  // few minutes at best, and not at all outside RTH), so reading those
  // gave users a stale P&L. legGreeks.long.mid + legGreeks.short.mid
  // refresh every 60s via the auto-refresh effect and are typically
  // <30s stale during RTH.
  //
  // Only computed for debit spreads (BULL_CALL / BEAR_PUT) — credit
  // spreads use a different entry sign convention worth handling
  // separately. Falls back to the stale DB columns whenever live data
  // isn't available (legs out of streaming window, worker down, both
  // legs >5 min stale, etc).
  const live = (() => {
    if (!legGreeks?.available) return null
    const longMid = Number(legGreeks.long?.mid)
    const shortMid = Number(legGreeks.short?.mid)
    if (!Number.isFinite(longMid) || !Number.isFinite(shortMid)) return null
    const strat = (pos.strategy_type || '').toLowerCase()
    const isDebit = strat === 'bull_call_spread' || strat === 'bear_put_spread'
    if (!isDebit) return null
    const currentMid = longMid - shortMid
    const entry = Number(pos.entry_debit_per_spread)
    if (!Number.isFinite(entry) || entry <= 0) return null
    const pnlPerSpread = currentMid - entry
    const pnlPct = (pnlPerSpread / entry) * 100
    const pnlDollars = pnlPerSpread * pos.contracts * 100
    const newest = Math.max(
      legGreeks.long?.updated_at ? new Date(legGreeks.long.updated_at).getTime() : 0,
      legGreeks.short?.updated_at ? new Date(legGreeks.short.updated_at).getTime() : 0,
    )
    const stale = newest > 0 && Date.now() - newest > 5 * 60_000
    if (stale) return null
    return { currentMid, pnlPerSpread, pnlPct, pnlDollars, asOf: newest }
  })()

  const dte = daysUntil(pos.expiration)
  const pnl = live?.pnlPct ?? pos.last_pnl_pct
  const currentMid = live?.currentMid ?? pos.last_mid_per_spread
  const pnlTone =
    pnl == null ? 'text-fg' : pnl >= 0 ? 'text-green-400' : 'text-crimson'
  // Filter out trigger types we've retired so legacy JSONB rows
  // (e.g. position_dte_21 fired before 2026-05-09) don't render as
  // empty/raw rows in the Triggers Fired card.
  const triggers = Object.entries(pos.triggers_fired || {}).filter(
    ([type]) => niceTriggerLabel(type) != null,
  )

  return (
    <div className="px-4 lg:px-6 py-5 max-w-md lg:max-w-3xl mx-auto space-y-4">
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate(-1)}
          className="p-2 -ml-2 text-subtle hover:text-fg"
          aria-label="Back"
        >
          <ArrowLeft size={20} />
        </button>
        <div className="flex-1">
          <h1 className="text-lg font-semibold leading-tight">{pos.ticker}</h1>
          <p className="text-xs text-subtle">
            {pos.strategy_type.replace(/_/g, ' ')} · {pos.contracts} contract
            {pos.contracts > 1 ? 's' : ''}
          </p>
        </div>
        <button
          onClick={() => {
            setRefreshTick((t) => t + 1)
            load()
            loadWorkingOrders()
          }}
          disabled={loading}
          className="p-2 text-subtle hover:text-fg disabled:opacity-50"
          aria-label="Refresh"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="bg-card border border-border rounded-xl p-4 space-y-3">
        <div className="flex items-baseline justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted">
              Spread
            </div>
            <div className="font-mono-tab text-base font-medium">
              ${formatStrike(pos.long_strike)} / ${formatStrike(pos.short_strike)}
            </div>
            <div className="text-[10px] text-subtle">
              {pos.expiration} · <span className={dte <= 21 ? 'text-amber-400' : ''}>{dte}d</span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wider text-muted">
              Live P&L
            </div>
            <div className={`text-2xl font-mono-tab font-semibold ${pnlTone}`}>
              {pnl != null ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(0)}%` : '—'}
            </div>
            <div className="text-[10px] text-subtle">
              {live?.asOf
                ? `live · ${agoString(new Date(live.asOf).toISOString())}`
                : pos.last_polled_at
                ? `delayed · ${agoString(pos.last_polled_at)}`
                : 'awaiting first poll'}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs pt-2 border-t border-border">
          <Stat label="Entry debit" value={`$${fmt(pos.entry_debit_per_spread)}`} />
          <Stat label="Current mid" value={currentMid != null ? `$${fmt(currentMid)}` : '—'} />
          <Stat
            label="Total risk"
            value={`$${fmt(pos.entry_debit_per_spread * pos.contracts * 100)}`}
            tone="neg"
          />
          <Stat
            label="Live value"
            value={currentMid != null ? `$${fmt(currentMid * pos.contracts * 100)}` : '—'}
          />
        </div>

        <DataFreshnessRow pos={pos} />
      </div>

      <DebugBanner
        searchParams={searchParams}
        pos={pos}
        signalRow={signalRow}
        wallInfo={wallInfo}
        moveInfo={moveInfo}
        verdict={verdict}
      />

      {/* ── TIER 1 — DECIDE ─────────────────────────────────────────
          Surfaces that answer "what should I do this minute?". The
          eye lands on the verdict, drops to the locked thesis (so
          the verdict's "intact / drifting / invalidated" reads
          against what was actually committed), then descends through
          emergency + actionable cards. Pin Risk and Time Pressure
          self-hide when their condition isn't met — when they DO
          render, they're near the top because acting on them is
          urgent. */}

      <ThesisVerdictBanner verdict={verdict} signalRow={signalRow} />

      {pos.thesis && (
        <div className="bg-card border border-border rounded-xl p-3 space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-muted">
            Thesis
          </div>
          <p className="text-xs text-subtle leading-relaxed">{pos.thesis}</p>
        </div>
      )}

      <PinRiskWarning pos={pos} moveInfo={moveInfo} />

      <PnLLadderCard pos={pos} />

      <DistanceToActionCard pos={pos} moveInfo={moveInfo} />

      <TimePressureCard pos={pos} />

      {/* ── TIER 2 — CONTEXT ────────────────────────────────────────
          Why does the trade look the way it does. Wall timing first
          (anchors the rest of the page's framing), then drift +
          Greek surfaces. None of these are gated on a condition —
          they're always-visible reference data. */}

      {wallInfo && <WallTimingCard pos={pos} wallInfo={wallInfo} />}

      <EntrySnapshotDiffCard
        snapshot={signalRow?.entry_gex_snapshot}
        moveInfo={moveInfo}
        wallInfo={wallInfo}
      />

      {moveInfo && (moveInfo.realizedToday != null || moveInfo.expectedTrade != null) && (
        <div className="bg-card border border-border rounded-xl p-3 space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-muted">
            Move context
          </div>
          {moveInfo.realizedToday != null && moveInfo.expectedToday != null && (
            <div className="space-y-1">
              <div className="text-xs flex items-baseline justify-between">
                <span className="text-subtle">Today realized</span>
                <span
                  className={`font-mono-tab ${
                    moveInfo.realizedToday >= 0 ? 'text-green-400' : 'text-crimson'
                  }`}
                >
                  {moveInfo.realizedToday >= 0 ? '+' : ''}${Math.abs(moveInfo.realizedToday).toFixed(2)}
                  {moveInfo.realizedTodayPct != null && (
                    <span className="text-muted ml-1">
                      ({moveInfo.realizedTodayPct >= 0 ? '+' : ''}
                      {(moveInfo.realizedTodayPct * 100).toFixed(2)}%)
                    </span>
                  )}
                </span>
              </div>
              <div className="text-xs flex items-baseline justify-between">
                <span className="text-subtle">Today expected ±</span>
                <span className="font-mono-tab text-fg">
                  ${moveInfo.expectedToday.toFixed(2)}
                  {moveInfo.expectedTodayPct != null && (
                    <span className="text-muted ml-1">
                      ({(moveInfo.expectedTodayPct * 100).toFixed(2)}%)
                    </span>
                  )}
                </span>
              </div>
              {moveInfo.realizedPctOfToday != null && (
                <div className="text-[11px] text-subtle leading-relaxed pt-1">
                  {moveInfo.realizedPctOfToday >= 1 ? (
                    <span className="text-amber-400">
                      Already past today's expected range ({(moveInfo.realizedPctOfToday * 100).toFixed(0)}% consumed) — vol expansion in progress.
                    </span>
                  ) : moveInfo.realizedPctOfToday >= 0.7 ? (
                    <>
                      <span className="text-amber-400">{(moveInfo.realizedPctOfToday * 100).toFixed(0)}% of today's expected range consumed</span>
                      {' '}— most of the day's move is in the books; remaining drift likely small.
                    </>
                  ) : (
                    <>
                      <span className="text-fg">{(moveInfo.realizedPctOfToday * 100).toFixed(0)}% of today's expected range consumed</span>
                      {' '}— room left for the day's expected move.
                    </>
                  )}
                </div>
              )}
            </div>
          )}
          {moveInfo.expectedTrade != null && moveInfo.tradeDte > 0 && (
            <div className="text-xs flex items-baseline justify-between pt-2 border-t border-border">
              <span className="text-subtle">
                Expected ± over remaining {moveInfo.tradeDte}d
              </span>
              <span className="font-mono-tab text-fg">
                ${moveInfo.expectedTrade.toFixed(2)}
                {moveInfo.expectedTradePct != null && (
                  <span className="text-muted ml-1">
                    ({(moveInfo.expectedTradePct * 100).toFixed(1)}%)
                  </span>
                )}
              </span>
            </div>
          )}
          {moveInfo.prevClose == null && (
            <div className="text-[10px] text-muted italic">
              Previous close not yet available — realized move pending.
            </div>
          )}
        </div>
      )}

      <NetGreeksCard pos={pos} legGreeks={legGreeks} />

      <ProbabilityConeCard pos={pos} moveInfo={moveInfo} />

      {/* ── TIER 3 — PLAN + ADMIN ───────────────────────────────────
          Reference, not decision input. Exit-plan + sizing first
          (the rules), then broker-side admin (working orders +
          historical triggers). */}

      <ExitPlanReminderCard pos={pos} />

      <AccountContextCard pos={pos} profile={profile} />

      <BracketOrderStatusCard
        pos={pos}
        workingOrders={workingOrders}
        loading={workingOrdersLoading}
        error={workingOrdersError}
        onRefresh={loadWorkingOrders}
        onEdit={(o) => setEditingOrder(o)}
      />

      <BracketEditModal
        order={editingOrder}
        signalId={pos?.signal_id}
        onClose={() => setEditingOrder(null)}
        onSaved={() => {
          setEditingOrder(null)
          loadWorkingOrders()
        }}
      />

      {triggers.length > 0 && (
        <div className="bg-card border border-border rounded-xl p-3 space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-muted">
            Triggers fired
          </div>
          {triggers.map(([type, ts]) => (
            <div key={type} className="flex items-center gap-2 text-xs">
              <AlertTriangle size={12} className="text-amber-400" />
              <span className="text-fg">{niceTriggerLabel(type)}</span>
              <span className="text-muted ml-auto">{agoString(ts)}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── TIER 4 — ACTION ─────────────────────────────────────── */}

      {pos.status === 'open' && !closeMode && (
        <button
          onClick={() => setCloseMode(true)}
          className="w-full bg-amber-400 hover:bg-amber-300 text-bg font-semibold rounded-xl py-3 text-sm transition"
        >
          Close Position
        </button>
      )}

      {pos.status === 'open' && closeMode && (
        <div className="bg-card border border-amber-400/40 rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2">
            <X size={14} className="text-amber-400" />
            <h3 className="text-sm font-semibold">Close at exit credit</h3>
          </div>
          <p className="text-[11px] text-subtle leading-relaxed">
            Enter the credit per spread you received (or expect to receive)
            on close. Realized P&L is computed automatically across all{' '}
            {pos.contracts} contracts.
          </p>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-muted block mb-1">
              Exit credit per spread ($)
            </label>
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              value={exitCredit}
              onChange={(e) => setExitCredit(e.target.value)}
              className={inputClass}
            />
          </div>
          {exitCredit && Number.isFinite(Number(exitCredit)) && (
            <PreviewRealized
              entry={pos.entry_debit_per_spread}
              exit={Number(exitCredit)}
              contracts={pos.contracts}
            />
          )}
          {error && (
            <div className="bg-red-950/30 border border-red-900/50 text-red-400 text-xs rounded p-2">
              {error}
            </div>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => setCloseMode(false)}
              className="flex-1 bg-bg-elev border border-border text-fg text-sm font-medium rounded-lg py-2"
            >
              Cancel
            </button>
            <button
              onClick={handleClose}
              disabled={closing || !exitCredit}
              className="flex-1 bg-amber-400 text-bg text-sm font-semibold rounded-lg py-2 hover:bg-amber-300 disabled:opacity-50"
            >
              {closing ? 'Closing…' : 'Confirm Close'}
            </button>
          </div>
        </div>
      )}

      {pos.status !== 'open' && (
        <div className="bg-card border border-border rounded-xl p-4 space-y-2">
          <div className="flex items-center gap-2">
            <Check size={14} className="text-green-400" />
            <h3 className="text-sm font-semibold capitalize">{pos.status}</h3>
          </div>
          <Stat label="Closed at" value={pos.closed_at ? new Date(pos.closed_at).toLocaleString() : '—'} />
          <Stat label="Exit credit" value={pos.exit_credit_per_spread != null ? `$${fmt(pos.exit_credit_per_spread)}` : '—'} />
          <Stat
            label="Realized P&L"
            value={pos.realized_pnl != null ? `${pos.realized_pnl >= 0 ? '+' : ''}$${fmt(pos.realized_pnl)}` : '—'}
            tone={pos.realized_pnl != null && pos.realized_pnl >= 0 ? 'pos' : 'neg'}
          />
        </div>
      )}
    </div>
  )
}

function PreviewRealized({ entry, exit, contracts }) {
  const realized = (exit - entry) * contracts * 100
  const tone = realized >= 0 ? 'text-green-400' : 'text-crimson'
  return (
    <div className="bg-bg-elev border border-border rounded-md p-2 text-xs">
      <span className="text-muted">Realized P&L: </span>
      <span className={`font-mono-tab font-semibold ${tone}`}>
        {realized >= 0 ? '+' : ''}${fmt(realized)}
      </span>
    </div>
  )
}

// Spread structure helpers shared across the cards below. The
// long/short orientation depends on whether the spread is a debit
// (long ITM closer to spot) or credit, but for max-profit /
// max-loss math what matters is the width and the entry credit/debit
// the user paid/collected. We currently only model debit spreads on
// this page (per CLAUDE.md spreads-only rule + Cash Moves' default
// suggester output).
function spreadGeometry(pos) {
  if (!pos) return null
  const long = Number(pos.long_strike)
  const short = Number(pos.short_strike)
  const entry = Number(pos.entry_debit_per_spread)
  if (![long, short, entry].every(Number.isFinite)) return null
  const width = Math.abs(short - long)
  const maxProfit = width - entry  // per share
  const maxLoss = entry            // per share
  const isCall = (pos.strategy_type || '').toLowerCase().includes('call')
  // Bull call: spot needs to rise above breakeven (long_strike + debit)
  // Bear put:  spot needs to fall below breakeven (long_strike − debit)
  const breakeven = isCall ? long + entry : long - entry
  const direction = isCall ? 'up' : 'down'
  return { long, short, entry, width, maxProfit, maxLoss, breakeven, isCall, direction }
}

// Visual P&L ladder — horizontal bar showing where current spread
// mark sits between entry, 50% target, and max profit, plus where
// the stop floor would be at the standard 50%-of-debit rule.
// Dynamic thesis verdict banner. Shows whether entry-time dealer
// positioning still supports the trade. Replaces the old static
// thesis card — the original frozen thesis text appears inside the
// banner so the user can always see what they committed to, with the
// live verdict on top.
//
// Server-side monitor-positions writes the same verdict to
// open_positions.last_verdict on each cron tick; the push notifications
// fire on transitions there, not here. This client-side computation
// just gives the user an immediate read on page load.
// Dev-only diagnostic banner. Shown only when ?debug=1 is in the
// URL — not gated on environment so we can debug live PWA-cached
// installs without redeploying. Surfaces the data-load state of every
// piece the verdict useMemo depends on so we can tell at a glance
// whether the issue is "data missing in DB" / "fetch failed" / "old
// cached bundle missing the new SELECT" / "verdict logic bailed early".
function DebugBanner({ searchParams, pos, signalRow, wallInfo, moveInfo, verdict }) {
  if (searchParams.get('debug') !== '1') return null
  const checks = [
    ['pos loaded', !!pos, pos ? `id=${String(pos.id).slice(0, 8)} signal_id=${pos.signal_id ? String(pos.signal_id).slice(0, 8) : 'null'}` : 'null'],
    ['signalRow loaded', !!signalRow, signalRow ? `id=${String(signalRow.id ?? '').slice(0, 8)}` : 'null (fetch pending or RLS denied)'],
    ['entry_gex_snapshot', !!signalRow?.entry_gex_snapshot, signalRow?.entry_gex_snapshot ? `spot=${signalRow.entry_gex_snapshot.spot} net_gex=${signalRow.entry_gex_snapshot.net_gex}` : 'null'],
    ['target_thesis_kind', signalRow?.target_thesis_kind != null, signalRow?.target_thesis_kind ?? 'null (heuristic path)'],
    ['target_strike', signalRow?.target_strike != null, signalRow?.target_strike ?? 'null'],
    ['wallInfo', !!wallInfo, wallInfo ? `spot=${wallInfo.spot} netGex=${wallInfo.netGex} wall=${wallInfo.wallStrike}@${wallInfo.wallExp}` : 'null (compute-gex returned no `largest`)'],
    ['moveInfo.spot', Number.isFinite(moveInfo?.spot), moveInfo?.spot ?? 'undefined'],
    ['verdict', !!verdict, verdict ? `state=${verdict.state} reasons=${verdict.reasons?.length ?? 0}` : 'null'],
  ]
  return (
    <div className="bg-amber-950/30 border border-amber-400/40 rounded-lg p-2 text-[10px] font-mono space-y-0.5">
      <div className="text-amber-400 uppercase tracking-wider font-semibold text-[9px]">
        Debug · ?debug=1
      </div>
      {checks.map(([label, ok, detail]) => (
        <div key={label} className="flex items-baseline justify-between gap-2">
          <span className={ok ? 'text-green-400' : 'text-crimson'}>
            {ok ? '✓' : '✗'} {label}
          </span>
          <span className="text-muted text-right truncate ml-2">{String(detail)}</span>
        </div>
      ))}
    </div>
  )
}

function ThesisVerdictBanner({ verdict, signalRow }) {
  if (!verdict) return null

  const palette = (() => {
    switch (verdict.state) {
      case 'invalidated':
        return {
          border: 'border-crimson/50',
          bg: 'bg-red-950/20',
          dot: 'bg-crimson',
          label: 'text-crimson',
          headline: 'Thesis invalidated',
        }
      case 'drifting':
        return {
          border: 'border-amber-400/50',
          bg: 'bg-amber-950/20',
          dot: 'bg-amber-400',
          label: 'text-amber-400',
          headline: 'Thesis drifting',
        }
      case 'intact':
        return {
          border: 'border-green-700/50',
          bg: 'bg-green-950/15',
          dot: 'bg-green-400',
          label: 'text-green-400',
          headline: 'Thesis intact',
        }
      default:
        return {
          border: 'border-border',
          bg: 'bg-card',
          dot: 'bg-muted',
          label: 'text-subtle',
          headline: 'Verdict pending',
        }
    }
  })()

  return (
    <div className={`border ${palette.border} ${palette.bg} rounded-xl p-3 space-y-2`}>
      <div className="flex items-center gap-2">
        <span className={`w-1.5 h-1.5 rounded-full ${palette.dot} ${verdict.state === 'invalidated' ? 'animate-pulse' : ''}`} />
        <span className={`text-[10px] uppercase tracking-wider font-semibold ${palette.label}`}>
          {palette.headline}
        </span>
      </div>
      {verdict.reasons.length > 0 && (
        <ul className="space-y-1 text-xs text-fg leading-relaxed">
          {verdict.reasons.map((r, i) => (
            <li key={i} className="flex gap-1.5">
              <span className="text-muted shrink-0">·</span>
              <span>{r}</span>
            </li>
          ))}
        </ul>
      )}
      {signalRow?.entry_gex_snapshot && verdict.state !== 'not_evaluable' && (
        <div className="text-[10px] text-muted">
          Captured {agoString(signalRow.entry_gex_snapshot.captured_at)} · re-evaluated continuously
        </div>
      )}
    </div>
  )
}

function PnLLadderCard({ pos }) {
  const g = spreadGeometry(pos)
  if (!g) return null
  const current = Number(pos.last_mid_per_spread)
  const hasCurrent = Number.isFinite(current)

  // Define the ladder anchors in spread-mark dollars.
  const stopFloor = g.entry * 0.5            // 50%-of-debit stop
  const target50 = g.entry + g.maxProfit * 0.5
  const target75 = g.entry + g.maxProfit * 0.75
  const maxValue = g.entry + g.maxProfit     // = width

  // Bar runs from stopFloor (left) to maxValue (right). Position
  // current along that range, clamped.
  const range = Math.max(0.01, maxValue - stopFloor)
  const pct = (val) => Math.max(0, Math.min(100, ((val - stopFloor) / range) * 100))
  const currentPct = hasCurrent ? pct(current) : null
  const entryPct = pct(g.entry)
  const target50Pct = pct(target50)
  const target75Pct = pct(target75)

  const profitDollars = hasCurrent
    ? (current - g.entry) * pos.contracts * 100
    : null
  const profitTone = profitDollars == null
    ? 'text-fg'
    : profitDollars >= 0
      ? 'text-green-400'
      : 'text-crimson'

  return (
    <div className="bg-card border border-border rounded-xl p-3 space-y-3">
      <div className="flex items-baseline justify-between">
        <div className="text-[10px] uppercase tracking-wider text-muted">P&L ladder</div>
        {profitDollars != null && (
          <div className={`text-xs font-mono-tab font-semibold ${profitTone}`}>
            {profitDollars >= 0 ? '+' : ''}${fmt(profitDollars)}
          </div>
        )}
      </div>

      <div className="relative h-7">
        {/* Background bar */}
        <div className="absolute inset-x-0 top-3 h-1 bg-border rounded-full" />
        {/* Profit zone shaded */}
        <div
          className="absolute top-3 h-1 bg-green-900/40 rounded-full"
          style={{ left: `${entryPct}%`, width: `${100 - entryPct}%` }}
        />
        {/* Loss zone shaded */}
        <div
          className="absolute top-3 h-1 bg-red-900/40 rounded-full"
          style={{ left: 0, width: `${entryPct}%` }}
        />
        {/* Anchor ticks */}
        <Tick pct={0} label="stop" tone="neg" />
        <Tick pct={entryPct} label="entry" tone="muted" />
        <Tick pct={target50Pct} label="50%" tone="amber" />
        <Tick pct={target75Pct} label="75%" tone="muted" />
        <Tick pct={100} label="max" tone="pos" />
        {/* Current marker */}
        {currentPct != null && (
          <div
            className="absolute top-1 h-5 w-0.5 bg-amber-400"
            style={{ left: `${currentPct}%` }}
            aria-label="Current"
          />
        )}
      </div>

      <div className="grid grid-cols-3 gap-2 text-[10px] text-muted pt-1">
        <div>
          Stop floor<br />
          <span className="text-fg font-mono-tab">${fmt(stopFloor)}</span>
        </div>
        <div>
          50% target<br />
          <span className="text-amber-400 font-mono-tab">${fmt(target50)}</span>
        </div>
        <div>
          Max value<br />
          <span className="text-green-400 font-mono-tab">${fmt(maxValue)}</span>
        </div>
      </div>
    </div>
  )
}

function Tick({ pct, label, tone }) {
  const toneClass =
    tone === 'pos' ? 'text-green-400'
    : tone === 'neg' ? 'text-crimson'
    : tone === 'amber' ? 'text-amber-400'
    : 'text-muted'
  return (
    <>
      <div
        className="absolute top-2 h-3 w-0.5 bg-subtle/40"
        style={{ left: `${pct}%` }}
      />
      <div
        className={`absolute top-5 text-[9px] -translate-x-1/2 ${toneClass}`}
        style={{ left: `${pct}%` }}
      >
        {label}
      </div>
    </>
  )
}

// Distance-to-action — translates spread-mark targets back into
// underlying-price moves the user can compare to the spot they're
// watching. Uses a simple delta heuristic since we don't have the
// option chain Greeks loaded on this page.
function DistanceToActionCard({ pos, moveInfo }) {
  const g = spreadGeometry(pos)
  const [showDetail, setShowDetail] = useState(false)
  if (!g) return null
  const spot = moveInfo?.spot
  if (!Number.isFinite(spot)) return null

  // Net delta heuristic: a vertical debit spread halfway through
  // its profit zone has net delta roughly 0.30-0.40 depending on
  // moneyness. We use 0.35 as a midpoint estimate. This understates
  // delta when the spread is deep ITM and overstates it when far
  // OTM, but it's a reasonable working estimate for "how much spot
  // move converts into how much spread mark move."
  const NET_DELTA_ESTIMATE = 0.35

  const current = Number(pos.last_mid_per_spread) || g.entry
  const target50 = g.entry + g.maxProfit * 0.5
  const stopFloor = g.entry * 0.5

  // Spread mark delta needed to reach each anchor, then translate
  // back to underlying using the net-delta estimate.
  const spreadDeltaToTarget = target50 - current
  const spreadDeltaToStop = stopFloor - current
  const spotMoveToTarget = spreadDeltaToTarget / NET_DELTA_ESTIMATE
  const spotMoveToStop = spreadDeltaToStop / NET_DELTA_ESTIMATE

  const dirSign = g.isCall ? 1 : -1   // bull call needs spot up, bear put needs spot down
  // The direction is already encoded in the spread-delta values:
  //   spotMoveToTarget is POSITIVE — spread needs to rise to hit target
  //   spotMoveToStop is NEGATIVE — spread needs to fall to hit stop
  // Multiplying by dirSign translates spread-direction into spot-direction.
  // Bull call (+1): positive target → spot up, negative stop → spot down.
  // Bear put (−1): positive target → spot down, negative stop → spot up.
  // Same formula for both anchors — the earlier `spot - … * dirSign`
  // flipped the sign twice and put bull-call stops ABOVE current spot.
  const targetSpot = spot + spotMoveToTarget * dirSign
  const stopSpot = spot + spotMoveToStop * dirSign

  const targetMovePct = ((targetSpot - spot) / spot) * 100
  const stopMovePct = ((stopSpot - spot) / spot) * 100

  return (
    <div className="bg-card border border-border rounded-xl p-3 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wider text-muted flex items-center gap-1.5">
          <Target size={10} /> Distance to action
          <InfoToggle open={showDetail} onToggle={() => setShowDetail((s) => !s)} label="Show distance-to-action detail" />
        </div>
        <div className="text-[11px] text-muted font-mono-tab">
          spot ${spot.toFixed(2)}
        </div>
      </div>
      <div className="bg-bg/50 border border-border/50 rounded-lg p-2.5 space-y-1.5">
        <div className="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-1 items-baseline text-[11px]">
          <span className="text-muted uppercase tracking-wider text-[10px]">
            Breakeven
          </span>
          <span className="text-fg font-mono-tab">
            ${g.breakeven.toFixed(2)}
          </span>
          <span className="text-subtle font-mono-tab text-right text-[10px]">
            {(((g.breakeven - spot) / spot) * 100).toFixed(2)}%
          </span>
          <span className="text-muted uppercase tracking-wider text-[10px]">
            50% target
          </span>
          <span className="text-amber-400 font-mono-tab">
            ${targetSpot.toFixed(2)}
          </span>
          <span className="text-subtle font-mono-tab text-right text-[10px]">
            {targetMovePct >= 0 ? '+' : ''}{targetMovePct.toFixed(2)}%
          </span>
          <span className="text-muted uppercase tracking-wider text-[10px]">
            Stop fires
          </span>
          <span className="text-crimson font-mono-tab">
            ${stopSpot.toFixed(2)}
          </span>
          <span className="text-subtle font-mono-tab text-right text-[10px]">
            {stopMovePct >= 0 ? '+' : ''}{stopMovePct.toFixed(2)}%
          </span>
        </div>
        <div className="flex justify-end pt-0.5">
          <span className="text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded border text-muted border-border bg-bg/50">
            ~0.35 net delta
          </span>
        </div>
      </div>
      {showDetail && (
        <p className="text-[11px] text-subtle leading-relaxed">
          Estimated using a midpoint delta — actual fill prices may
          differ on deep ITM or far OTM spreads.
        </p>
      )}
    </div>
  )
}

// Pre-defined exit plan reminder. Pulls from RM_MANAGEMENT.md
// defaults when no custom plan is stored on the position. Once
// signals/positions get an `exit_plan` JSONB column, this reads
// from there instead.
function ExitPlanReminderCard({ pos }) {
  const g = spreadGeometry(pos)
  const [showDetail, setShowDetail] = useState(false)
  if (!g) return null
  const target = g.entry + g.maxProfit * 0.5
  const stop = g.entry * 0.5
  return (
    <div className="bg-card border border-border rounded-xl p-3 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wider text-muted flex items-center gap-1.5">
          <Shield size={10} /> Exit plan
          <InfoToggle open={showDetail} onToggle={() => setShowDetail((s) => !s)} label="Show exit-plan detail" />
        </div>
        <div className="text-[11px] text-muted font-mono-tab">
          standard
        </div>
      </div>
      <div className="bg-bg/50 border border-border/50 rounded-lg p-2.5 space-y-1.5">
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 items-baseline text-[11px]">
          <PlanRow
            label="Profit target"
            detail="50% of max profit"
            value={`$${fmt(target)}`}
            tone="amber"
          />
          <PlanRow
            label="Stop loss"
            detail="50% of debit paid"
            value={`$${fmt(stop)}`}
            tone="neg"
          />
          <PlanRow
            label="Time exit"
            detail="50% of DTE elapsed (whichever first)"
            value="manual"
            tone="muted"
          />
          <PlanRow
            label="Hard cutoff"
            detail="No holds past 2pm on expiration day"
            value="rule"
            tone="muted"
          />
        </div>
        <div className="flex justify-end pt-0.5">
          <span className="text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded border text-amber-400 border-amber-400/30 bg-amber-400/10">
            mirror in bracket
          </span>
        </div>
      </div>
      {showDetail && (
        <p className="text-[11px] text-subtle leading-relaxed">
          Defaults from RISK_MANAGEMENT.md. Your broker bracket should
          mirror the profit/stop levels above.
        </p>
      )}
    </div>
  )
}

// Two-line plan row: label + detail wrap on the left, value on the
// right. Used inside ExitPlanReminderCard's grid (auto + 1fr) so
// the label column auto-sizes to the longest entry and the value
// column right-aligns consistently.
function PlanRow({ label, detail, value, tone }) {
  const toneClass =
    tone === 'amber' ? 'text-amber-400'
    : tone === 'neg' ? 'text-crimson'
    : 'text-fg'
  return (
    <>
      <div>
        <div className="text-fg leading-tight">{label}</div>
        <div className="text-[10px] text-muted leading-tight">{detail}</div>
      </div>
      <div className={`font-mono-tab text-right ${toneClass} font-medium`}>
        {value}
      </div>
    </>
  )
}

// Wall-timing context. Compares the trade's expiration to the
// dominant gamma cluster's expiration. Three tones:
//
//   aligned (|diff| ≤ 1)   → trade closes at the wall's peak gamma
//                            window. Pin pull is at full strength.
//   wall after  (diff > 1) → wall peaks AFTER the trade exits. Pin
//                            pull during the hold is weaker than the
//                            headline GEX number suggests.
//   wall before (diff < -1) → dominant cluster has already rolled
//                             off. Regime can be in transition.
//
// Layout: header (label + strike/date) → status line → two-row
// timing table (trade vs wall) with the gap badge on the right.
// Long interpretation paragraph from the old design is dropped for
// aligned cases (the headline already says everything); kept for
// the misaligned cases where the explanation adds non-obvious
// trading context.
function WallTimingCard({ pos, wallInfo }) {
  const tradeExp = pos.expiration
  const wallExp = wallInfo.wallExp
  const [showDetail, setShowDetail] = useState(false)
  const tone =
    wallInfo.tone === 'amber'
      ? 'text-amber-400'
      : wallInfo.tone === 'neg'
        ? 'text-crimson'
        : 'text-green-400'
  const gapAbs = Math.abs(wallInfo.diff)
  const gapLabel =
    gapAbs === 0
      ? 'aligned'
      : `${wallInfo.diff > 0 ? '+' : '−'}${gapAbs}d gap`
  const gapTone =
    gapAbs <= 1
      ? 'text-green-400 border-green-400/30 bg-green-400/10'
      : 'text-amber-400 border-amber-400/30 bg-amber-400/10'
  const hasInterpretation = Boolean(wallInfo.interpretation)

  return (
    <div className="bg-card border border-border rounded-xl p-3 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wider text-muted flex items-center gap-1.5">
          Wall timing
          {hasInterpretation && (
            <InfoToggle open={showDetail} onToggle={() => setShowDetail((s) => !s)} label="Show wall-timing detail" />
          )}
        </div>
        <div className="text-[11px] text-muted font-mono-tab">
          ${formatStrike(wallInfo.wallStrike)} · {formatFriendlyDate(wallExp)}
        </div>
      </div>
      <div className={`text-xs font-medium ${tone}`}>
        {wallInfo.label}
      </div>
      <div className="bg-bg/50 border border-border/50 rounded-lg p-2.5 space-y-1.5">
        <div className="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-1 items-baseline text-[11px]">
          <span className="text-muted uppercase tracking-wider text-[10px]">
            Trade
          </span>
          <span className="text-fg font-mono-tab">
            {formatFriendlyDate(tradeExp, { long: true })}
          </span>
          <span className="text-subtle font-mono-tab text-right">
            {wallInfo.tradeDte}d
          </span>
          <span className="text-muted uppercase tracking-wider text-[10px]">
            Wall
          </span>
          <span className="text-fg font-mono-tab">
            {formatFriendlyDate(wallExp, { long: true })}
          </span>
          <span className="text-subtle font-mono-tab text-right">
            {wallInfo.wallDte}d
          </span>
        </div>
        <div className="flex justify-end pt-0.5">
          <span
            className={`text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded border ${gapTone}`}
          >
            {gapLabel}
          </span>
        </div>
      </div>
      {showDetail && wallInfo.interpretation && (
        // Folded behind the (i) toggle. The headline at the top of the
        // card already says the key result; this paragraph adds the
        // trading-context rationale for users who want it.
        <p className="text-[11px] text-subtle leading-relaxed">
          {wallInfo.interpretation}
        </p>
      )}
    </div>
  )
}

// Reusable (i) info toggle. Renders as a small bordered chip next to
// a card's header, tap to toggle a `showDetail` state the card reads.
// Used to fold long explanatory paragraphs ("Theta accelerates each
// day…", "Full wall magnetism in force…", etc.) behind a deliberate
// reveal so the page reads compactly by default but the rationale is
// one tap away when the user wants it.
function InfoToggle({ open, onToggle, label = 'Show details' }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={open ? 'Hide details' : label}
      aria-expanded={open}
      className={`shrink-0 w-5 h-5 rounded-full border flex items-center justify-center transition ${
        open
          ? 'border-amber-400/50 text-amber-400 bg-amber-400/10'
          : 'border-border text-muted hover:text-fg hover:border-border-hover'
      }`}
    >
      <Info size={11} strokeWidth={2.25} />
    </button>
  )
}

// "2026-05-12" → "Tue May 12". Always parsed UTC so we don't get
// off-by-one timezone fuckery on a YYYY-MM-DD string. The
// `long: true` option appends the year ("Tue, May 12, 2026") for
// the row-level data inside WallTimingCard where the user
// specifically wants the year visible. Header chips stay short to
// keep the right-aligned metadata compact.
function formatFriendlyDate(iso, opts = {}) {
  if (!iso) return '—'
  const d = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(opts.long ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  })
}

// Time-pressure granularity — translates raw DTE into trading
// sessions remaining + theta-acceleration warning for the final
// 24-48h window where gamma/pin variance dominates. Approximates
// trading sessions by skipping weekends (no holidays handled).
function TimePressureCard({ pos }) {
  const dte = daysUntil(pos.expiration)
  const sessions = tradingSessionsUntil(pos.expiration)
  const finalDay = sessions <= 1
  const tightWindow = sessions <= 3
  const [showDetail, setShowDetail] = useState(false)

  if (dte <= 0) return null
  if (!tightWindow) return null  // only surface this card when time is tight

  // Three-tier headline + tone, matching the WallTimingCard pattern.
  // The headline is a punchy one-liner; the longer copy lives in the
  // detail box below for non-obvious context.
  const { headline, tone, badgeLabel, badgeTone, detail } = (() => {
    if (finalDay) {
      return {
        headline: 'Expiration day — theta + gamma + pin risk all peak',
        tone: 'text-amber-400',
        badgeLabel: 'final day',
        badgeTone: 'text-crimson border-crimson/40 bg-crimson/10',
        detail: 'Close by 11am, hard cutoff 2pm. Bracket order should already be live.',
      }
    }
    if (sessions === 2) {
      return {
        headline: 'Two sessions left',
        tone: 'text-amber-400',
        badgeLabel: 'tightening',
        badgeTone: 'text-amber-400 border-amber-400/40 bg-amber-400/10',
        detail: 'Theta accelerates each day. Plan exit by mid-morning of expiration day.',
      }
    }
    return {
      headline: 'Three sessions left',
      tone: 'text-fg',
      badgeLabel: 'theta zone',
      badgeTone: 'text-amber-400 border-amber-400/30 bg-amber-400/10',
      detail: 'Theta starts to bite. Bracket should fire well before expiration.',
    }
  })()

  return (
    <div className="bg-card border border-border rounded-xl p-3 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wider text-muted flex items-center gap-1.5">
          <Clock size={10} /> Time pressure
          <InfoToggle open={showDetail} onToggle={() => setShowDetail((s) => !s)} label="Show time-pressure detail" />
        </div>
        <div className="text-[11px] text-muted font-mono-tab">
          {formatFriendlyDate(pos.expiration)}
        </div>
      </div>
      <div className={`text-xs font-medium ${tone}`}>
        {headline}
      </div>
      <div className="bg-bg/50 border border-border/50 rounded-lg p-2.5 space-y-1.5">
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-baseline text-[11px]">
          <span className="text-muted uppercase tracking-wider text-[10px]">
            Sessions
          </span>
          <span className="text-fg font-mono-tab text-right">
            {sessions} trading day{sessions === 1 ? '' : 's'}
          </span>
          <span className="text-muted uppercase tracking-wider text-[10px]">
            Calendar
          </span>
          <span className="text-fg font-mono-tab text-right">
            {dte} day{dte === 1 ? '' : 's'}
          </span>
        </div>
        <div className="flex justify-end pt-0.5">
          <span
            className={`text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded border ${badgeTone}`}
          >
            {badgeLabel}
          </span>
        </div>
      </div>
      {showDetail && (
        <p className="text-[11px] text-subtle leading-relaxed">{detail}</p>
      )}
    </div>
  )
}

function tradingSessionsUntil(date) {
  if (!date) return 0
  const target = new Date(date + 'T00:00:00Z')
  const now = new Date()
  let sessions = 0
  const cursor = new Date(now)
  // Round forward to nearest day boundary
  cursor.setUTCHours(0, 0, 0, 0)
  while (cursor < target) {
    const day = cursor.getUTCDay()
    if (day !== 0 && day !== 6) sessions++
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  // The expiration day itself counts if it's a weekday
  const expDay = target.getUTCDay()
  if (expDay !== 0 && expDay !== 6) sessions++
  return sessions
}

// Account-level context — shows risk and max-gain as a percentage of
// the user's account size. Prefers LIVE broker NLV via get-account
// (same pattern as StrikePriceCalculator). Falls back to the manual
// profile.account_size value when:
//   - get-account fails / returns no accounts
//   - the connection is on the Tastytrade sandbox (the cert endpoint
//     returns a fake $100K NLV that would silently mislead 2%-rule
//     sizing)
//
// Without this, a Pro user whose profile.account_size is stale or a
// placeholder (Cameron's was $1M) sees every position render as
// trivially small ("0.04% · within 2% rule") regardless of what their
// real broker NLV is. The 2%-rule badge was lying.
function AccountContextCard({ pos, profile }) {
  const [liveNlv, setLiveNlv] = useState(null)
  const [liveSandbox, setLiveSandbox] = useState(false)
  const [nlvError, setNlvError] = useState(null)
  const [nlvLoading, setNlvLoading] = useState(true)
  const [showDetail, setShowDetail] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { data, error } = await supabase.functions.invoke('get-account')
        if (cancelled) return
        if (error || !data?.success) {
          setNlvError(error?.message || data?.error || 'broker fetch failed')
          return
        }
        const accounts = (data.accounts || []).slice()
        accounts.sort(
          (a, b) =>
            Number(b.net_liquidating_value ?? 0) - Number(a.net_liquidating_value ?? 0),
        )
        const primary = accounts.find((a) => !a.is_paper) || accounts[0]
        if (!primary) {
          setNlvError('no broker accounts on file')
          return
        }
        const sandbox = Boolean(
          data.is_sandbox ?? primary.is_sandbox ?? primary.is_paper,
        )
        const nlv = Number(primary.net_liquidating_value)
        // Refuse the sandbox's fake $100K NLV — silently sizing
        // positions against it is exactly the failure mode this card
        // is meant to prevent.
        setLiveNlv(sandbox || !Number.isFinite(nlv) ? null : nlv)
        setLiveSandbox(sandbox)
      } catch (e) {
        if (!cancelled) setNlvError(e?.message || 'broker fetch failed')
      } finally {
        if (!cancelled) setNlvLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const manualSize = Number(profile?.account_size)
  const accountSize = liveNlv ?? (Number.isFinite(manualSize) ? manualSize : null)
  const source =
    liveNlv != null ? 'broker' : Number.isFinite(manualSize) && manualSize > 0 ? 'manual' : null

  if (!accountSize || accountSize <= 0) return null
  const g = spreadGeometry(pos)
  if (!g) return null

  const totalRisk = g.maxLoss * pos.contracts * 100
  const totalMaxGain = g.maxProfit * pos.contracts * 100
  const riskPct = (totalRisk / accountSize) * 100
  const gainPct = (totalMaxGain / accountSize) * 100
  const overSized = riskPct > 2.1

  return (
    <div className="bg-card border border-border rounded-xl p-3 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wider text-muted flex items-center gap-1.5">
          Account context
          {overSized && (
            <InfoToggle open={showDetail} onToggle={() => setShowDetail((s) => !s)} label="Show sizing detail" />
          )}
        </div>
        <div className="text-right">
          <div className="text-[11px] text-muted font-mono-tab">
            ${fmt(accountSize)} acct
          </div>
          <div className="text-[9px] uppercase tracking-wider text-muted">
            {nlvLoading
              ? 'syncing…'
              : source === 'broker'
              ? 'live · broker NLV'
              : liveSandbox
              ? 'sandbox NLV ignored · using manual'
              : nlvError
              ? 'broker unreachable · using manual'
              : 'manual (Settings)'}
          </div>
        </div>
      </div>
      {overSized && (
        <div className="text-xs font-medium text-crimson">
          Position exceeds the 2% sizing rule
        </div>
      )}
      <div className="bg-bg/50 border border-border/50 rounded-lg p-2.5 space-y-1.5">
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-baseline text-[11px]">
          <span className="text-muted uppercase tracking-wider text-[10px]">
            Risk if max loss
          </span>
          <span className={`font-mono-tab text-right ${overSized ? 'text-crimson' : 'text-fg'}`}>
            ${fmt(totalRisk)} · {riskPct.toFixed(2)}%
          </span>
          <span className="text-muted uppercase tracking-wider text-[10px]">
            Gain if max profit
          </span>
          <span className="font-mono-tab text-right text-green-400">
            ${fmt(totalMaxGain)} · {gainPct.toFixed(2)}%
          </span>
        </div>
        <div className="flex justify-end pt-0.5">
          <span
            className={`text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded border ${
              overSized
                ? 'text-crimson border-crimson/40 bg-crimson/10'
                : 'text-green-400 border-green-400/30 bg-green-400/10'
            }`}
          >
            {overSized ? 'oversized' : 'within 2% rule'}
          </span>
        </div>
      </div>
      {showDetail && overSized && (
        <p className="text-[11px] text-subtle leading-relaxed">
          Consider sizing down on future entries — see RISK_MANAGEMENT.md.
        </p>
      )}
    </div>
  )
}

// Pin risk warning — fires when spot is within $2 (or 0.5%) of
// the short strike on a debit spread. Closing exactly at the strike
// triggers assignment overnight, which converts a defined-risk
// position into uncovered stock exposure.
function PinRiskWarning({ pos, moveInfo }) {
  const g = spreadGeometry(pos)
  if (!g) return null
  const spot = moveInfo?.spot
  if (!Number.isFinite(spot)) return null
  const sessions = tradingSessionsUntil(pos.expiration)
  if (sessions > 1) return null  // only matters near/at expiration day

  const distance = Math.abs(spot - g.short)
  const distancePct = distance / spot
  const inPinZone = distance <= 2 || distancePct <= 0.005
  if (!inPinZone) return null

  return (
    <div className="bg-amber-950/30 border border-amber-700/50 rounded-xl p-3 space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-amber-400">
        <AlertTriangle size={12} /> Pin risk zone
      </div>
      <p className="text-[11px] text-fg leading-relaxed">
        Spot ${spot.toFixed(2)} is within ${distance.toFixed(2)} of your
        short strike ${formatStrike(g.short)}. Close manually before 2pm
        ET to avoid assignment — short legs sitting at-the-money at the
        bell can be exercised, leaving you with overnight stock exposure.
      </p>
    </div>
  )
}

// Probability cone — uses IV-derived expected move over remaining
// trade life to project rough probability of three outcomes:
// max profit, breakeven, max loss. Assumes normal distribution
// (Black-Scholes-ish). Approximation only — real pin/wall regimes
// distort these probabilities meaningfully.
function ProbabilityConeCard({ pos, moveInfo }) {
  const g = spreadGeometry(pos)
  const [showDetail, setShowDetail] = useState(false)
  if (!g) return null
  const spot = moveInfo?.spot
  const sigma = moveInfo?.expectedTrade  // 1-sigma $ move over remaining DTE
  if (!Number.isFinite(spot) || !Number.isFinite(sigma) || sigma <= 0) return null

  // Probability that spot reaches/passes a target by expiration,
  // approximated as 1-CDF of a normal distribution centered at spot
  // with stddev = sigma.
  const probAbove = (target) => {
    const z = (target - spot) / sigma
    return 1 - normCdf(z)
  }
  const probBelow = (target) => 1 - probAbove(target)

  let pMaxProfit, pBreakeven, pMaxLoss
  if (g.isCall) {
    // Bull call: max profit if spot >= short_strike at expiration,
    // breakeven if spot >= breakeven, max loss if spot <= long_strike
    pMaxProfit = probAbove(g.short)
    pBreakeven = probAbove(g.breakeven)
    pMaxLoss = probBelow(g.long)
  } else {
    pMaxProfit = probBelow(g.short)
    pBreakeven = probBelow(g.breakeven)
    pMaxLoss = probAbove(g.long)
  }

  return (
    <div className="bg-card border border-border rounded-xl p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wider text-muted flex items-center gap-1.5">
          Probability cone (by expiration)
          <InfoToggle open={showDetail} onToggle={() => setShowDetail((s) => !s)} label="Show probability-cone caveat" />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 text-xs">
        <ProbCell label="Max profit" pct={pMaxProfit} tone="pos" />
        <ProbCell label="≥ breakeven" pct={pBreakeven} tone="amber" />
        <ProbCell label="Max loss" pct={pMaxLoss} tone="neg" />
      </div>
      {showDetail && (
        <p className="text-[10px] text-muted leading-relaxed pt-1 border-t border-border">
          IV-implied probabilities. Pin/wall regimes distort the
          distribution — treat as a rough baseline, not a guarantee.
        </p>
      )}
    </div>
  )
}

function ProbCell({ label, pct, tone }) {
  const toneClass =
    tone === 'pos' ? 'text-green-400'
    : tone === 'neg' ? 'text-crimson'
    : tone === 'amber' ? 'text-amber-400'
    : 'text-fg'
  return (
    <div className="bg-bg-elev rounded-md p-2 text-center">
      <div className="text-[9px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`font-mono-tab text-sm font-semibold ${toneClass}`}>
        {(pct * 100).toFixed(0)}%
      </div>
    </div>
  )
}

// Net per-spread Greeks. Long-leg minus short-leg, since a debit
// spread is "long the closer leg, short the farther leg." Reads from
// the dxlink_quotes cache (front-2 expirations × ATM ± 25%); shows
// "—" for spreads outside that window. Dollar-denominated theta/vega
// surface "$ per day" / "$ per IV-point" at the position level
// (× 100 × contracts) since that's the only unit traders reason in.
function NetGreeksCard({ pos, legGreeks }) {
  const [showDetail, setShowDetail] = useState(false)
  const contracts = Math.max(1, Number(pos?.contracts) || 1)
  // Per-share Greeks straight from dxFeed; valid only when both legs
  // returned a row. One-sided fetches produce misleading nets.
  const long = legGreeks?.long
  const short = legGreeks?.short
  const available = legGreeks?.available
  const fmtSigned = (v, digits = 2) =>
    v == null || !Number.isFinite(v)
      ? '—'
      : `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`
  const fmtDollar = (v) =>
    v == null || !Number.isFinite(v)
      ? '—'
      : `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`

  // Net per share. Position-level theta/vega multiply by 100 ×
  // contracts to land in the dollar units traders track.
  const netDelta = available ? Number(long.delta) - Number(short.delta) : null
  const netGamma = available ? Number(long.gamma) - Number(short.gamma) : null
  const netTheta = available ? Number(long.theta) - Number(short.theta) : null
  const netVega = available ? Number(long.vega) - Number(short.vega) : null
  const positionTheta =
    netTheta != null && Number.isFinite(netTheta) ? netTheta * 100 * contracts : null
  const positionVega =
    netVega != null && Number.isFinite(netVega) ? netVega * 100 * contracts : null
  const stalest = (() => {
    const ts = [long?.updated_at, short?.updated_at].filter(Boolean)
    if (ts.length === 0) return null
    return ts.reduce((acc, t) => (acc && acc > t ? acc : t), null)
  })()

  return (
    <div className="bg-card border border-border rounded-xl p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-wider text-muted flex items-center gap-1.5">
          Net Greeks
          {available && (
            <InfoToggle open={showDetail} onToggle={() => setShowDetail((s) => !s)} label="Show net-Greek interpretation" />
          )}
        </div>
        {stalest && (
          <div className="text-[10px] text-muted">
            updated {agoString(stalest)}
          </div>
        )}
      </div>
      {!available ? (
        <p className="text-[11px] text-subtle leading-relaxed">
          {legGreeks == null
            ? 'Loading…'
            : 'No live Greeks for these strikes — the streaming worker only subscribes to the front 2 expirations within ATM ± 25%. Spread is outside that window or the data hasn\'t arrived yet.'}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <GreekCell
              label="Net delta"
              value={fmtSigned(netDelta, 2)}
              hint="per share, both legs combined"
            />
            <GreekCell
              label="Net gamma"
              value={fmtSigned(netGamma, 4)}
              hint="rate-of-change of delta"
            />
            <GreekCell
              label="Position theta"
              value={fmtDollar(positionTheta)}
              hint={`per day · ${contracts} contracts`}
              tone={positionTheta != null && positionTheta < 0 ? 'red' : 'green'}
            />
            <GreekCell
              label="Position vega"
              value={fmtDollar(positionVega)}
              hint={`per IV-point · ${contracts} contracts`}
              tone={positionVega != null && positionVega > 0 ? 'green' : 'red'}
            />
          </div>
          {showDetail && (
            <p className="text-[11px] text-subtle leading-relaxed pt-1">
              {netDelta != null && Math.abs(netDelta) < 0.1
                ? 'Near delta-neutral — the spread\'s P&L hinges on time decay and IV more than direction.'
                : netDelta != null && netDelta > 0
                  ? 'Positive net delta — the spread gains as the underlying rises.'
                  : 'Negative net delta — the spread gains as the underlying falls.'}
            </p>
          )}
        </>
      )}
    </div>
  )
}

// Live broker brackets — the working close orders Tastytrade has
// queued against the position. Powered by the get-working-orders
// edge function. Skipped entirely when the signal has no
// tastytrade_account_number (manual-only logs); otherwise renders
// "no working brackets" when the broker returns an empty list.
//
// Two surfaces per bracket: the limit-credit close (target) and the
// stop-loss close. We label them by intent inferred from order_type
// + price_effect; if the inference fails the card honestly says
// "unknown intent" rather than guessing wrong.
function BracketOrderStatusCard({ pos, workingOrders, loading, error, onRefresh, onEdit }) {
  if (!pos?.signal_id) return null

  return (
    <div className="bg-card border border-border rounded-xl p-3 space-y-2">
      <div className="flex items-baseline justify-between">
        <div className="text-[10px] uppercase tracking-wider text-muted">
          Live broker brackets
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="text-[10px] text-muted hover:text-fg flex items-center gap-1 disabled:opacity-40"
          aria-label="Refresh working orders"
        >
          <RefreshCw size={10} className={loading ? 'animate-spin' : ''} />
          {loading ? 'loading' : 'refresh'}
        </button>
      </div>
      {error && (
        <p className="text-[11px] text-crimson leading-relaxed">
          {error}
        </p>
      )}
      {!error && workingOrders == null && !loading && (
        <p className="text-[11px] text-subtle leading-relaxed">
          Tap refresh to pull working orders from Tastytrade.
        </p>
      )}
      {!error && Array.isArray(workingOrders) && workingOrders.length === 0 && (
        <p className="text-[11px] text-subtle leading-relaxed">
          No working brackets on this position. Place a stop / target via
          your broker — they'll appear here once submitted.
        </p>
      )}
      {!error && Array.isArray(workingOrders) && workingOrders.length > 0 && (
        <div className="space-y-2">
          {workingOrders.map((o) => (
            <BracketRow key={o.tastytrade_order_id} order={o} onEdit={onEdit} />
          ))}
        </div>
      )}
    </div>
  )
}

function BracketRow({ order, onEdit }) {
  const intentLabel =
    order.intent === 'target'
      ? 'Profit target'
      : order.intent === 'stop'
        ? 'Stop loss'
        : 'Working order'
  const tone =
    order.intent === 'target'
      ? 'text-green-400'
      : order.intent === 'stop'
        ? 'text-amber-400'
        : 'text-fg'
  const priceFmt =
    order.price != null && Number.isFinite(order.price)
      ? `$${order.price.toFixed(2)}`
      : '—'
  return (
    <div className="bg-bg/50 border border-border/50 rounded-lg p-2 space-y-1">
      <div className="flex items-baseline justify-between">
        <span className={`text-xs font-semibold ${tone}`}>{intentLabel}</span>
        <span className="text-xs font-mono-tab text-fg">
          {priceFmt}
          {order.price_effect && (
            <span className="text-muted ml-1 text-[10px]">
              {order.price_effect.toLowerCase()}
            </span>
          )}
        </span>
      </div>
      <div className="flex items-baseline justify-between text-[10px]">
        <span className="text-muted">
          {order.order_type ?? '—'} · {order.time_in_force ?? '—'}
        </span>
        <span className="text-muted uppercase tracking-wider">
          {order.status ?? '—'}
        </span>
      </div>
      <div className="flex items-baseline justify-between">
        <div className="text-[10px] text-muted font-mono">
          #{order.tastytrade_order_id}
          {order.complex_order_tag && (
            <span className="ml-1">· {order.complex_order_tag}</span>
          )}
        </div>
        {onEdit && (
          <button
            type="button"
            onClick={() => onEdit(order)}
            className="text-[10px] text-amber-400 hover:text-amber-300 font-semibold"
            aria-label={`Edit order ${order.tastytrade_order_id}`}
          >
            Edit
          </button>
        )}
      </div>
    </div>
  )
}

// Modal that lets the user nudge the limit price on a working bracket
// order. Two-step UX: enter new price → review → confirm. Keeps the
// edit flow honest (no fat-finger send) and gives the user a chance
// to bail if the API call would do something they didn't intend.
//
// The modify-order edge function does the broker write and logs to
// order_history. UI just collects + dispatches.
function BracketEditModal({ order, signalId, onClose, onSaved }) {
  const [newPrice, setNewPrice] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  // Reset form whenever a different order is opened. Avoids carrying
  // stale state between two consecutive Edit clicks on different rows.
  useEffect(() => {
    if (!order) return
    setNewPrice(order.price != null ? String(order.price) : '')
    setErr(null)
  }, [order?.tastytrade_order_id])

  if (!order) return null

  async function save() {
    const priceNum = Number(newPrice)
    if (!Number.isFinite(priceNum) || priceNum <= 0) {
      setErr('Price must be a positive number.')
      return
    }
    setBusy(true)
    setErr(null)
    // supabase.functions.invoke returns FunctionsHttpError when the
    // edge fn returns a non-2xx response. The error.message is the
    // status reason; the actual detail comes back in error.context
    // (a Response we have to await .json() on). We try to dig it out
    // so users see Tastytrade's actual rejection reason instead of a
    // generic "something went wrong".
    const { data, error: invokeErr } = await supabase.functions.invoke('modify-order', {
      body: {
        signal_id: signalId,
        order_id: order.tastytrade_order_id,
        new_price: priceNum,
      },
    })
    setBusy(false)
    if (invokeErr) {
      // Try to read the JSON body the edge fn returned on a non-2xx.
      let body = null
      try {
        body = await invokeErr.context?.json?.()
      } catch {
        /* not JSON, fall back to message */
      }
      const msg = body?.error ?? invokeErr.message ?? 'broker write failed'
      const detail = body?.detail ? ` — ${String(body.detail).slice(0, 280)}` : ''
      setErr(`${msg}${detail}`)
      return
    }
    if (!data?.success) {
      const detail = data?.detail ? ` — ${String(data.detail).slice(0, 280)}` : ''
      setErr(`${data?.error ?? 'broker write failed'}${detail}`)
      return
    }
    onSaved?.()
  }

  const intentLabel =
    order.intent === 'target'
      ? 'profit target'
      : order.intent === 'stop'
        ? 'stop loss'
        : 'working order'

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-end sm:items-center justify-center z-50 p-2"
      role="dialog"
      aria-modal="true"
      aria-label={`Edit ${intentLabel}`}
    >
      <div className="bg-card border border-amber-400/40 rounded-2xl p-4 w-full sm:max-w-sm space-y-3">
        <div className="flex items-baseline justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-amber-400 font-semibold">
              Edit {intentLabel}
            </p>
            <h3 className="text-sm font-semibold mt-0.5">
              Order #{order.tastytrade_order_id}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted hover:text-fg"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>
        <div className="text-[11px] text-subtle leading-relaxed">
          Current limit price:{' '}
          <span className="font-mono-tab text-fg">
            {order.price != null ? `$${Number(order.price).toFixed(2)}` : '—'}
          </span>
          {order.price_effect && (
            <span className="text-muted ml-1">{order.price_effect.toLowerCase()}</span>
          )}
          . The order legs and time-in-force are preserved — only the
          limit price changes.
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider text-muted block mb-1">
            New limit price ($)
          </label>
          <input
            type="number"
            min="0.01"
            step="0.01"
            inputMode="decimal"
            value={newPrice}
            onChange={(e) => setNewPrice(e.target.value)}
            disabled={busy}
            className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-sm font-mono-tab text-fg focus:outline-none focus:border-amber-400/40"
            autoFocus
          />
        </div>
        {err && (
          <div className="bg-red-950/30 border border-red-900/50 rounded-lg p-2">
            <p className="text-crimson text-[11px]" role="alert">
              {err}
            </p>
          </div>
        )}
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex-1 bg-card border border-border text-subtle font-semibold rounded-xl py-2.5 text-sm hover:text-fg disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy || !newPrice}
            className="flex-1 bg-amber-400 hover:bg-amber-300 text-bg font-semibold rounded-xl py-2.5 text-sm disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Submit modify'}
          </button>
        </div>
      </div>
    </div>
  )
}

// Entry-vs-now headline diff. Shows what dealer positioning looked
// like at signal lock vs what it looks like right now, so the user
// can decide whether the thesis still holds. Reads
// signal.entry_gex_snapshot (captured by LogSignal at submit) and
// the live wallInfo / moveInfo already loaded for the page.
//
// Hidden when no snapshot exists — every signal logged before
// 2026-05-09 has a null column. Don't fake an "unchanged" diff.
function EntrySnapshotDiffCard({ snapshot, moveInfo, wallInfo }) {
  if (!snapshot) return null
  const nowSpot = moveInfo?.spot
  const nowNetGex = wallInfo?.netGex
  const nowWallStrike = wallInfo?.wallStrike
  const nowWallExp = wallInfo?.wallExp
  const entrySpot = snapshot.spot
  const entryNetGex = snapshot.net_gex
  const entryWallStrike = snapshot.largest_wall?.strike ?? null
  const entryWallExp = snapshot.largest_wall?.expiration ?? null

  const spotDelta =
    Number.isFinite(nowSpot) && Number.isFinite(entrySpot)
      ? nowSpot - entrySpot
      : null
  const spotDeltaPct =
    spotDelta != null && entrySpot
      ? spotDelta / entrySpot
      : null
  const gexDelta =
    Number.isFinite(nowNetGex) && Number.isFinite(entryNetGex)
      ? nowNetGex - entryNetGex
      : null
  const wallStrikeChanged =
    nowWallStrike != null &&
    entryWallStrike != null &&
    Number(nowWallStrike) !== Number(entryWallStrike)
  const wallExpChanged =
    nowWallExp != null && entryWallExp != null && nowWallExp !== entryWallExp

  return (
    <div className="bg-card border border-border rounded-xl p-3 space-y-2">
      <div className="flex items-baseline justify-between">
        <div className="text-[10px] uppercase tracking-wider text-muted">
          Entry vs now
        </div>
        <div className="text-[10px] text-muted">
          captured {agoString(snapshot.captured_at)}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <DiffRow
          label="Spot"
          entry={entrySpot != null ? `$${Number(entrySpot).toFixed(2)}` : '—'}
          now={nowSpot != null ? `$${Number(nowSpot).toFixed(2)}` : '—'}
          delta={
            spotDelta != null
              ? `${spotDelta >= 0 ? '+' : ''}$${spotDelta.toFixed(2)}`
              : null
          }
          deltaPct={spotDeltaPct}
        />
        <DiffRow
          label="Net GEX"
          entry={entryNetGex != null ? fmtMillions(entryNetGex) : '—'}
          now={nowNetGex != null ? fmtMillions(nowNetGex) : '—'}
          delta={gexDelta != null ? fmtMillions(gexDelta) : null}
        />
        <DiffRow
          label="Call wall"
          entry={
            entryWallStrike != null
              ? `${formatStrike(entryWallStrike)} @ ${entryWallExp ?? '—'}`
              : '—'
          }
          now={
            nowWallStrike != null
              ? `${formatStrike(nowWallStrike)} @ ${nowWallExp ?? '—'}`
              : '—'
          }
          flag={wallStrikeChanged || wallExpChanged}
        />
        <DiffRow
          label="Source"
          entry={snapshot.source ?? '—'}
          now={moveInfo ? 'live' : '—'}
        />
      </div>
      {(wallStrikeChanged || wallExpChanged) && (
        <p className="text-[11px] text-amber-400 leading-relaxed pt-1">
          The dominant wall has shifted since you entered — the
          thesis is now anchored to a different magnetism point. Re-
          read the matrix before defending the trade.
        </p>
      )}
    </div>
  )
}

function DiffRow({ label, entry, now, delta, deltaPct, flag }) {
  return (
    <div className={`bg-bg/50 border rounded-lg p-2 ${flag ? 'border-amber-400/40' : 'border-border/50'}`}>
      <div className="text-[10px] uppercase tracking-wider text-muted">
        {label}
      </div>
      <div className="text-[11px] flex items-baseline justify-between mt-0.5">
        <span className="text-muted">entry</span>
        <span className="text-fg font-mono-tab">{entry}</span>
      </div>
      <div className="text-[11px] flex items-baseline justify-between">
        <span className="text-muted">now</span>
        <span className="text-fg font-mono-tab">{now}</span>
      </div>
      {delta && (
        <div className="text-[10px] text-subtle font-mono-tab mt-0.5 text-right">
          Δ {delta}
          {deltaPct != null && Number.isFinite(deltaPct) && (
            <span className="ml-1">
              ({deltaPct >= 0 ? '+' : ''}{(deltaPct * 100).toFixed(1)}%)
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function fmtMillions(v) {
  if (v == null || !Number.isFinite(v)) return '—'
  const sign = v >= 0 ? '+' : '−'
  return `${sign}$${(Math.abs(v) / 1e6).toFixed(1)}M`
}

function GreekCell({ label, value, hint, tone }) {
  const toneClass =
    tone === 'red' ? 'text-crimson' : tone === 'green' ? 'text-green-400' : 'text-fg'
  return (
    <div className="bg-bg/50 border border-border/50 rounded-lg p-2">
      <div className="text-[10px] uppercase tracking-wider text-muted">
        {label}
      </div>
      <div className={`text-sm font-mono-tab font-semibold ${toneClass} mt-0.5`}>
        {value}
      </div>
      {hint && <div className="text-[10px] text-muted mt-0.5">{hint}</div>}
    </div>
  )
}

// Standard normal CDF using Abramowitz & Stegun approximation.
// Sufficient precision for the rough probability display we want.
function normCdf(z) {
  const sign = z < 0 ? -1 : 1
  const x = Math.abs(z) / Math.sqrt(2)
  const t = 1 / (1 + 0.3275911 * x)
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-x * x)
  return 0.5 * (1 + sign * y)
}

// Improved data freshness row — surfaces source, age of last poll,
// and a switch-to-live hint when on Yahoo fallback.
function DataFreshnessRow({ pos }) {
  const source = pos.last_poll_source ?? 'pending'
  const isYahoo = source === 'yahoo'
  const isLive = source === 'dxlink'
  const ageStr = pos.last_polled_at ? agoString(pos.last_polled_at) : 'never'
  return (
    <div className="text-[10px] text-muted flex items-baseline justify-between gap-2 flex-wrap">
      <span>
        Source:{' '}
        <span className={isLive ? 'text-green-400' : isYahoo ? 'text-amber-400' : 'text-fg'}>
          {source}
        </span>
        {isYahoo && ' (15-min delayed)'}
        {isLive && ' (live stream)'}
      </span>
      <span>
        Last refresh: <span className="text-fg">{ageStr}</span>
      </span>
    </div>
  )
}

function Stat({ label, value, tone }) {
  const toneClass =
    tone === 'pos' ? 'text-green-400' : tone === 'neg' ? 'text-crimson' : 'text-fg'
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-[10px] uppercase tracking-wider text-muted">{label}</span>
      <span className={`font-mono-tab text-xs font-medium ${toneClass}`}>{value}</span>
    </div>
  )
}

const inputClass =
  'w-full bg-bg border border-border text-fg rounded-md py-1.5 px-2 text-sm focus:outline-none focus:border-amber-400/40'

function fmt(v) {
  if (v == null) return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return n.toFixed(2)
}

function formatStrike(v) {
  if (v == null) return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return n >= 1000 ? n.toFixed(0) : n.toFixed(1)
}

function daysUntil(date) {
  if (!date) return 0
  const d = new Date(date + 'T00:00:00Z').getTime()
  return Math.max(0, Math.ceil((d - Date.now()) / 86_400_000))
}

// Decide whether the trade is structurally a "pin / fade-the-wall"
// play (wall sits OUTSIDE the spread, condor centered near the wall)
// vs a "break-the-wall" play (wall sits BETWEEN the long and short
// legs of a debit spread). The interpretation differs:
//   - Pin trades benefit from a wall AT peak gamma during the hold.
//     A weak/leaky wall undermines the thesis.
//   - Break-the-wall trades benefit from a wall BELOW peak gamma
//     during the hold. A strong wall during the hold defeats the trade.
function pinOrBreakInterpretation(pos, wallStrike, wallAfter) {
  const lo = Math.min(pos.long_strike, pos.short_strike)
  const hi = Math.max(pos.long_strike, pos.short_strike)
  const wallInside = wallStrike > lo && wallStrike < hi
  if (wallInside && wallAfter) {
    return 'Wall sits between your strikes — a break-through-the-wall structure. Wall is at its weakest defense during your hold; if a known catalyst overlaps, this is favorable.'
  }
  if (!wallInside && wallAfter) {
    return 'Wall sits outside your strikes (pin / fade-the-wall structure). Magnetism during your hold is weaker than the headline GEX suggests because the wall hasn\'t hit peak gamma yet.'
  }
  return ''
}

function agoString(iso) {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.round(ms / 3600_000)}h ago`
  return `${Math.round(ms / 86_400_000)}d ago`
}

function niceTriggerLabel(type) {
  switch (type) {
    case 'position_stop_loss': return 'Stop loss (−50%)'
    case 'position_profit_50': return 'Profit +50%'
    case 'position_profit_100': return 'Profit +100%'
    case 'position_profit_200': return 'Profit +200%'
    // position_dte_21 retired 2026-05-09 — TimePressureCard covers
    // the actionable end-of-trade window. Returning null hides
    // legacy rows still sitting in open_positions.triggers_fired
    // without a backfill.
    case 'position_dte_21': return null
    case 'position_expiring_tomorrow': return 'Expiring tomorrow'
    default: return type
  }
}
