// Cash Moves — TrackRecord (private dashboard).
//
// Authenticated route. The user's reputation cockpit:
//   * Hero with display name + public slug + share button
//   * 4 stat blocks (Verified P&L, Biggest Win, Trades, Profile Views)
//   * P&L equity curve with 1D/1W/1M/3M/ALL period toggle
//   * Position table — Open Positions | Closed Positions tabs
//   * Activity feed (signals logged, positions opened/closed)
//   * Reputation panel — current leaderboard rank + climb CTA
//
// Reads:
//   * profiles (the user's own row)
//   * open_positions (active + closed, scoped by RLS to own user)
//   * signals (for the activity feed)
//   * leaderboard_snapshots (for the rank-fetch fallback)
//
// Per the leaderboard-spec rewrite (2026-05-12), biotech-era enums
// (enrollment_signal, fda_precedent_signal, etc.) and the
// bySignalType breakdown are GONE. The page is GEX/options-flow only
// from this version forward.

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowDown,
  ArrowUp,
  DollarSign,
  Eye,
  Hash,
  Layers,
  Share2,
  TrendingDown,
  TrendingUp,
  Trophy,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import EquityCurve from '../components/EquityCurve'
import clsx from 'clsx'

const STRATEGY_META = {
  BULL_CALL:        { label: 'Bull Call',        icon: TrendingUp,   tone: 'text-green-400' },
  BEAR_PUT:         { label: 'Bear Put',         icon: TrendingDown, tone: 'text-red-400' },
  BULL_PUT_CREDIT:  { label: 'Bull Put Credit',  icon: ArrowUp,      tone: 'text-emerald-400' },
  BEAR_CALL_CREDIT: { label: 'Bear Call Credit', icon: ArrowDown,    tone: 'text-rose-400' },
  IRON_CONDOR:      { label: 'Iron Condor',      icon: Layers,       tone: 'text-purple-400' },
}

const STRATEGY_FILTER_PILLS = [
  { key: 'all',         label: 'All' },
  { key: 'wins',        label: 'Wins' },
  { key: 'losses',      label: 'Losses' },
  { key: 'this_week',   label: 'This Week' },
  { key: 'this_month',  label: 'This Month' },
]

const POSITION_TABS = ['open', 'closed']
const TOP_TABS = ['positions', 'activity']

export default function TrackRecord() {
  const { user, profile } = useAuth()
  const navigate = useNavigate()
  const [positions, setPositions] = useState([])
  const [activity, setActivity] = useState([])
  const [leaderboardRank, setLeaderboardRank] = useState(null)
  const [topTab, setTopTab] = useState('positions')
  const [positionTab, setPositionTab] = useState('open')
  const [filter, setFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [shareFlash, setShareFlash] = useState('')

  useEffect(() => {
    if (!user) return
    fetchData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  async function fetchData() {
    setLoading(true)

    // Pull all positions (open + closed) for this user. RLS scopes to
    // own rows. We render Open in one tab, Closed in the other.
    const { data: positionsData } = await supabase
      .from('open_positions')
      .select(
        'id, signal_id, ticker, strategy_type, status, contracts, ' +
          'entry_debit_per_spread, exit_credit_per_spread, realized_pnl, ' +
          'last_mid_per_spread, last_pnl_pct, last_verdict, ' +
          'entry_at, closed_at, expiration, long_strike, short_strike',
      )
      .eq('user_id', user.id)
      .order('entry_at', { ascending: false })
    setPositions(positionsData ?? [])

    // Activity feed: signals logged + position opens/closes, merged.
    // The fancy verdict-transition events from `alerts` will come in a
    // follow-up; v1 sticks to lifecycle events for simplicity.
    const { data: signals } = await supabase
      .from('signals')
      .select('id, ticker, structure, logged_at, signal_hash, signal_source')
      .eq('user_id', user.id)
      .order('logged_at', { ascending: false })
      .limit(50)
    const activityRows = []
    for (const sig of signals ?? []) {
      activityRows.push({
        kind: 'signal_logged',
        at: sig.logged_at,
        signal_id: sig.id,
        ticker: sig.ticker,
        meta: sig.structure,
        hash_locked: !!sig.signal_hash,
      })
    }
    for (const pos of positionsData ?? []) {
      activityRows.push({
        kind: 'position_opened',
        at: pos.entry_at,
        position_id: pos.id,
        signal_id: pos.signal_id,
        ticker: pos.ticker,
        meta: pos.strategy_type,
      })
      if (pos.status === 'closed' && pos.closed_at) {
        activityRows.push({
          kind: 'position_closed',
          at: pos.closed_at,
          position_id: pos.id,
          signal_id: pos.signal_id,
          ticker: pos.ticker,
          meta: pos.strategy_type,
          realized_pnl: pos.realized_pnl,
        })
      }
    }
    activityRows.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    setActivity(activityRows.slice(0, 100))

    // Best-effort: pull the user's rank from the most recent
    // all_time / top_earners snapshot. Page renders fine without it.
    const { data: snapshot } = await supabase
      .from('leaderboard_snapshots')
      .select('rankings')
      .eq('time_window', 'all_time')
      .eq('rank_type', 'top_earners')
      .order('computed_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (snapshot?.rankings) {
      const row = (snapshot.rankings || []).find((r) => r.user_id === user.id)
      setLeaderboardRank(row?.rank ?? null)
    }

    setLoading(false)
  }

  const closedPositions = useMemo(
    () => positions.filter((p) => p.status === 'closed'),
    [positions],
  )
  const openPositions = useMemo(
    () => positions.filter((p) => p.status === 'open' || p.status === 'partial'),
    [positions],
  )

  // 4 stat blocks. Source of truth is the user's own closed positions
  // (RLS-scoped query above). Same recipe as the leaderboard's
  // top_earners ranking so the user's /record stats match what
  // /leaderboard shows.
  const stats = useMemo(() => {
    const closed = closedPositions
    const totalPnl = closed.reduce((s, p) => s + Number(p.realized_pnl || 0), 0)
    const biggestWin = closed.reduce(
      (max, p) => Math.max(max, Number(p.realized_pnl || 0)),
      0,
    )
    return {
      totalPnl,
      biggestWin,
      trades: closed.length,
      profileViews: Number(profile?.profile_view_count ?? 0),
    }
  }, [closedPositions, profile?.profile_view_count])

  // Filter applied to the Closed tab (Open tab ignores filter — the
  // filter pills only make sense for resolved trades).
  const filteredClosed = useMemo(() => {
    if (filter === 'all') return closedPositions
    if (filter === 'wins') return closedPositions.filter((p) => Number(p.realized_pnl || 0) > 0)
    if (filter === 'losses') return closedPositions.filter((p) => Number(p.realized_pnl || 0) <= 0)
    const now = Date.now()
    if (filter === 'this_week') {
      return closedPositions.filter(
        (p) => p.closed_at && now - new Date(p.closed_at).getTime() < 7 * 86_400_000,
      )
    }
    if (filter === 'this_month') {
      return closedPositions.filter(
        (p) => p.closed_at && now - new Date(p.closed_at).getTime() < 30 * 86_400_000,
      )
    }
    return closedPositions
  }, [closedPositions, filter])

  const equityPoints = useMemo(
    () =>
      closedPositions
        .filter((p) => p.closed_at && p.realized_pnl != null)
        .map((p) => ({ at: p.closed_at, realized_pnl: Number(p.realized_pnl) })),
    [closedPositions],
  )

  async function shareRecord() {
    if (!profile?.public_slug) {
      setShareFlash('Set a public slug in Settings first.')
      setTimeout(() => setShareFlash(''), 2500)
      return
    }
    if (!profile?.is_public) {
      setShareFlash('Your profile is private. Toggle public in Settings.')
      setTimeout(() => setShareFlash(''), 2500)
      return
    }
    // /u/:slug is the new Polymarket-style route. Until that page ships
    // in Week 3, fall back to /r/:slug which renders the legacy page.
    const url = `${window.location.origin}/u/${profile.public_slug}`
    const text = stats.trades > 0
      ? `My verified options track record: $${Math.round(stats.totalPnl).toLocaleString()} P&L · ${stats.trades} trades · hash-locked.`
      : 'My verified options track record.'

    if (navigator.share) {
      try {
        await navigator.share({ title: 'My Cash Moves record', text, url })
        return
      } catch {
        /* fall through */
      }
    }
    try {
      await navigator.clipboard.writeText(url)
      setShareFlash('Link copied')
    } catch {
      setShareFlash(url)
    }
    setTimeout(() => setShareFlash(''), 2500)
  }

  if (loading) {
    return (
      <div className="px-4 lg:px-6 pt-6 pb-4 mx-auto lg:max-w-4xl w-full">
        <LoadingSkeleton />
      </div>
    )
  }

  return (
    <div className="px-4 lg:px-6 pt-6 pb-4 mx-auto lg:max-w-4xl w-full">
      {/* ── Hero ────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between mb-4">
        <div>
          <h1 className="text-white text-xl lg:text-2xl font-bold">
            {profile?.display_name || 'Your Record'}
          </h1>
          {profile?.public_slug && (
            <p className="text-muted text-xs mt-1">
              {profile.is_public ? 'public · ' : 'private · '}
              cashmoves.io/u/{profile.public_slug}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={shareRecord}
          className="flex items-center gap-1 text-subtle text-xs hover:text-white transition-colors border border-border rounded-lg px-2.5 py-1.5"
          title="Share your public record"
        >
          <Share2 size={12} />
          Share
        </button>
      </div>
      {shareFlash && (
        <p className="text-green-400 text-xs mb-4" role="status">
          {shareFlash}
        </p>
      )}

      {stats.trades === 0 && openPositions.length === 0 ? (
        <EmptyState onLogClick={() => navigate('/log')} />
      ) : (
        <>
          {/* ── Stat blocks ──────────────────────────────────────── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
            <StatBlock
              icon={DollarSign}
              label="Verified P&L"
              value={`${stats.totalPnl >= 0 ? '+' : '−'}$${Math.abs(Math.round(stats.totalPnl)).toLocaleString()}`}
              tone={stats.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}
            />
            <StatBlock
              icon={TrendingUp}
              label="Biggest Win"
              value={`$${Math.round(stats.biggestWin).toLocaleString()}`}
              tone="text-green-400"
            />
            <StatBlock
              icon={Hash}
              label="Trades"
              value={String(stats.trades)}
              tone="text-white"
            />
            <StatBlock
              icon={Eye}
              label="Profile Views"
              value={stats.profileViews.toLocaleString()}
              tone="text-zinc-300"
            />
          </div>

          {/* ── Equity curve ────────────────────────────────────── */}
          <EquityCurve points={equityPoints} className="mb-4" />

          {/* ── Reputation panel ────────────────────────────────── */}
          <ReputationPanel
            rank={leaderboardRank}
            trades={stats.trades}
            onClimbClick={() => navigate('/leaderboard')}
          />

          {/* ── Top tabs: Positions | Activity ──────────────────── */}
          <div className="flex gap-1 mb-3 border-b border-border">
            {TOP_TABS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTopTab(t)}
                className={clsx(
                  'px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px',
                  topTab === t
                    ? 'text-white border-red-500'
                    : 'text-muted border-transparent hover:text-subtle',
                )}
              >
                {t === 'positions' ? 'Positions' : 'Activity'}
              </button>
            ))}
          </div>

          {topTab === 'positions' ? (
            <>
              {/* Open | Closed sub-tabs */}
              <div className="flex gap-2 mb-3">
                {POSITION_TABS.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setPositionTab(t)}
                    className={clsx(
                      'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
                      positionTab === t
                        ? 'bg-zinc-800 text-white'
                        : 'bg-card border border-border text-subtle',
                    )}
                  >
                    {t === 'open'
                      ? `Open (${openPositions.length})`
                      : `Closed (${closedPositions.length})`}
                  </button>
                ))}
              </div>

              {positionTab === 'closed' && (
                <div className="flex gap-2 mb-3 overflow-x-auto">
                  {STRATEGY_FILTER_PILLS.map((p) => (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => setFilter(p.key)}
                      className={clsx(
                        'px-2.5 py-1 rounded-md text-[11px] font-medium whitespace-nowrap transition-colors',
                        filter === p.key
                          ? 'bg-red-600 text-white'
                          : 'bg-card border border-border text-subtle',
                      )}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              )}

              <div className="space-y-2">
                {(positionTab === 'open' ? openPositions : filteredClosed).map((pos) => (
                  <PositionRow
                    key={pos.id}
                    pos={pos}
                    onClick={() =>
                      navigate(pos.status === 'closed' ? `/signal/${pos.signal_id}` : `/position/${pos.id}`)
                    }
                  />
                ))}
                {(positionTab === 'open' ? openPositions : filteredClosed).length === 0 && (
                  <div className="text-center py-10 px-4 space-y-2">
                    <p className="text-fg text-sm font-display">
                      {positionTab === 'open' ? 'No open positions' : 'Nothing matches this filter'}
                    </p>
                    <p className="text-subtle text-xs leading-relaxed max-w-xs mx-auto">
                      {positionTab === 'open'
                        ? 'Open a position from Suggested Plays or LogSignal.'
                        : 'Try a different filter, or log a new trade.'}
                    </p>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="space-y-2">
              {activity.map((row, i) => (
                <ActivityRow
                  key={`${row.kind}-${row.position_id ?? row.signal_id}-${i}`}
                  row={row}
                  onClick={() =>
                    row.position_id
                      ? navigate(`/position/${row.position_id}`)
                      : navigate(`/signal/${row.signal_id}`)
                  }
                />
              ))}
              {activity.length === 0 && (
                <p className="text-center text-muted text-xs py-10">No activity yet.</p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// Subcomponents
// ────────────────────────────────────────────────────────────────────

function StatBlock({ icon: Icon, label, value, tone }) {
  return (
    <div className="bg-card border border-border rounded-xl p-3">
      <div className="flex items-center gap-1.5 text-muted text-[10px] uppercase tracking-wider mb-1">
        <Icon size={11} />
        {label}
      </div>
      <p className={clsx('text-lg lg:text-xl font-bold font-mono-tab tabular-nums', tone)}>
        {value}
      </p>
    </div>
  )
}

function ReputationPanel({ rank, trades, onClimbClick }) {
  // Three states:
  //   * No rank (no snapshot yet OR not eligible): "Climb the leaderboard"
  //     CTA explaining the eligibility gates.
  //   * Ranked (snapshot exists, user in top 100): show rank + CTA to
  //     /leaderboard.
  const eligible = trades >= 10
  return (
    <div className="bg-card border border-border rounded-xl p-4 mb-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Trophy size={16} className="text-amber-400" />
          <div>
            <p className="text-muted text-[10px] uppercase tracking-wider">Leaderboard</p>
            <p className="text-white text-sm font-semibold">
              {rank
                ? `Ranked #${rank} all-time`
                : eligible
                  ? 'Unranked — next snapshot tomorrow'
                  : `${trades}/10 trades to qualify`}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClimbClick}
          className="text-xs text-red-400 hover:text-red-300 font-medium"
        >
          {rank ? 'View →' : 'Climb →'}
        </button>
      </div>
    </div>
  )
}

function PositionRow({ pos, onClick }) {
  const meta = STRATEGY_META[pos.strategy_type] ?? {
    label: pos.strategy_type, icon: Hash, tone: 'text-zinc-400',
  }
  const Icon = meta.icon
  const pnl = Number(pos.realized_pnl ?? pos.last_pnl_pct ?? 0)
  const isClosed = pos.status === 'closed'
  const pnlDollar = pos.status === 'closed' ? Number(pos.realized_pnl ?? 0) : null
  const positive = pnl >= 0

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left bg-card border border-border rounded-xl px-4 py-3 flex items-center gap-3 hover:border-zinc-700 transition-colors active:scale-[0.98]"
    >
      <div className={clsx('w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 bg-zinc-900', meta.tone)}>
        <Icon size={14} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-white font-bold text-sm">{pos.ticker}</p>
          <span className={clsx('text-[10px] font-medium', meta.tone)}>{meta.label}</span>
          {pos.long_strike != null && pos.short_strike != null && (
            <span className="text-[10px] text-muted font-mono-tab">
              {pos.long_strike}/{pos.short_strike}
            </span>
          )}
          {!isClosed && pos.last_verdict && pos.last_verdict !== 'intact' && (
            <span
              className={clsx(
                'text-[10px] px-1.5 py-0.5 rounded-full border',
                pos.last_verdict === 'invalidated'
                  ? 'border-red-900 text-red-400'
                  : 'border-yellow-900 text-yellow-400',
              )}
            >
              {pos.last_verdict}
            </span>
          )}
        </div>
        <p className="text-muted text-[10px] truncate mt-0.5">
          {isClosed
            ? `Closed ${new Date(pos.closed_at).toLocaleDateString()}`
            : `Opened ${new Date(pos.entry_at).toLocaleDateString()}${
                pos.expiration ? ` · exp ${pos.expiration}` : ''
              }`}
        </p>
      </div>

      <div className="text-right flex-shrink-0">
        {pnlDollar != null && (
          <p
            className={clsx(
              'font-bold text-sm font-mono-tab tabular-nums',
              positive ? 'text-green-400' : 'text-red-400',
            )}
          >
            {positive ? '+' : '−'}${Math.abs(Math.round(pnlDollar)).toLocaleString()}
          </p>
        )}
        {!isClosed && pos.last_pnl_pct != null && (
          <p
            className={clsx(
              'font-bold text-sm font-mono-tab tabular-nums',
              positive ? 'text-green-400' : 'text-red-400',
            )}
          >
            {positive ? '+' : ''}{Math.round(Number(pos.last_pnl_pct))}%
          </p>
        )}
        {pos.signal_id && (
          <p className="text-[10px] text-muted flex items-center gap-0.5 justify-end mt-0.5">
            <Hash size={9} />
            verified
          </p>
        )}
      </div>
    </button>
  )
}

function ActivityRow({ row, onClick }) {
  const meta = ACTIVITY_META[row.kind] ?? ACTIVITY_META.signal_logged
  const Icon = meta.icon
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left bg-card border border-border rounded-xl px-4 py-3 flex items-center gap-3 hover:border-zinc-700 transition-colors active:scale-[0.98]"
    >
      <div className={clsx('w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 bg-zinc-900', meta.tone)}>
        <Icon size={14} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-white text-sm font-medium">{meta.label}</p>
          <p className="text-zinc-400 text-xs">{row.ticker}</p>
          {row.hash_locked && (
            <span className="text-[10px] text-amber-400 flex items-center gap-0.5">
              <Hash size={9} />
            </span>
          )}
        </div>
        <p className="text-muted text-[10px] truncate mt-0.5">
          {new Date(row.at).toLocaleString()}
        </p>
      </div>
      {row.realized_pnl != null && (
        <p
          className={clsx(
            'text-right font-bold text-sm font-mono-tab tabular-nums flex-shrink-0',
            Number(row.realized_pnl) >= 0 ? 'text-green-400' : 'text-red-400',
          )}
        >
          {Number(row.realized_pnl) >= 0 ? '+' : '−'}$
          {Math.abs(Math.round(Number(row.realized_pnl))).toLocaleString()}
        </p>
      )}
    </button>
  )
}

const ACTIVITY_META = {
  signal_logged:     { label: 'Signal logged',    icon: Hash,        tone: 'text-amber-400' },
  position_opened:   { label: 'Position opened',  icon: TrendingUp,  tone: 'text-blue-400' },
  position_closed:   { label: 'Position closed',  icon: DollarSign,  tone: 'text-zinc-300' },
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      <div className="h-8 w-40 bg-card border border-border rounded animate-pulse" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {Array(4).fill(0).map((_, i) => (
          <div key={i} className="h-20 bg-card border border-border rounded-xl animate-pulse" />
        ))}
      </div>
      <div className="h-32 bg-card border border-border rounded-xl animate-pulse" />
      <div className="h-16 bg-card border border-border rounded-xl animate-pulse" />
    </div>
  )
}

function EmptyState({ onLogClick }) {
  return (
    <div className="bg-card border border-border rounded-xl p-10 text-center space-y-3">
      <div className="text-3xl">📓</div>
      <p className="text-fg text-base font-display">
        Log your first thesis to start your verified record
      </p>
      <p className="text-subtle text-xs leading-relaxed max-w-xs mx-auto">
        Every signal you lock is hash-anchored to a public GitHub commit.
        Your verified P&L, win rate, and trade count build the record
        that others can&nbsp;trust.
      </p>
      <button
        type="button"
        onClick={onLogClick}
        className="mt-2 inline-flex items-center gap-1 bg-red-600 hover:bg-red-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
      >
        Log a thesis
      </button>
    </div>
  )
}
