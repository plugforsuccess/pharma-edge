// Cash Moves — public /leaderboard page.
//
// Anonymous-readable. The discovery surface for the viral loop — anyone
// can browse rankings of verified Cash Moves traders, and each row
// links to the trader's /u/:slug profile.
//
// Four rank-type tabs (Top Earners / Win Rate / Biggest Wins / Most
// Active) × four time windows (All-Time / YTD / 30d / 7d). All snapshots
// are pre-computed daily by leaderboard-snapshot and served via the
// leaderboard-public-feed edge function. No live re-ranking — just
// paginated reads from the cached payload.
//
// Empty state design matters here: pre-launch, the snapshot will
// either not exist OR be empty for most (window, rank_type) combos.
// We render a friendly "leaderboard fills as users log verified
// trades" message instead of a sad zero-rows table.

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Activity,
  DollarSign,
  Hash,
  Trophy,
  TrendingUp,
} from 'lucide-react'
import clsx from 'clsx'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

const RANK_TABS = [
  { key: 'top_earners',  label: 'Top Earners',  icon: DollarSign, statLabel: 'Verified P&L' },
  { key: 'win_rate',     label: 'Win Rate',     icon: TrendingUp, statLabel: 'Win Rate' },
  { key: 'biggest_win',  label: 'Biggest Wins', icon: Trophy,     statLabel: 'Best Trade' },
  { key: 'most_active',  label: 'Most Active',  icon: Activity,   statLabel: 'Trades' },
]

const TIME_WINDOWS = [
  { key: 'all_time', label: 'All-Time' },
  { key: 'ytd',      label: 'YTD' },
  { key: '30d',      label: '30 Days' },
  { key: '7d',       label: '7 Days' },
]

const MIN_TRADES_HINT = {
  top_earners: 10,
  win_rate: 20,
  biggest_win: 1,
  most_active: 1,
}

const PER_PAGE = 50

export default function Leaderboard() {
  const navigate = useNavigate()
  const [rankType, setRankType] = useState('top_earners')
  const [timeWindow, setTimeWindow] = useState('all_time')
  const [page, setPage] = useState(1)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')

    fetch(`${SUPABASE_URL}/functions/v1/leaderboard-public-feed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        time_window: timeWindow,
        rank_type: rankType,
        page,
        per_page: PER_PAGE,
      }),
    })
      .then((resp) => resp.json())
      .then((body) => {
        if (cancelled) return
        if (!body?.success) {
          setError(body?.error || 'failed to load')
          setData(null)
        } else {
          setData(body.data)
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'network error')
          setData(null)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [rankType, timeWindow, page])

  // Reset to page 1 when filters change.
  useEffect(() => {
    setPage(1)
  }, [rankType, timeWindow])

  const activeTab = useMemo(
    () => RANK_TABS.find((t) => t.key === rankType) ?? RANK_TABS[0],
    [rankType],
  )

  return (
    <div className="min-h-screen bg-bg">
      <div className="px-4 lg:px-6 pt-6 pb-12 mx-auto lg:max-w-5xl w-full">
        {/* ── Header ────────────────────────────────────────────── */}
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-1">
            <Trophy size={20} className="text-amber-400" />
            <h1 className="text-white text-xl lg:text-2xl font-bold">Leaderboard</h1>
          </div>
          <p className="text-muted text-xs lg:text-sm leading-relaxed max-w-2xl">
            Verified, hash-locked options trades — ranked by closed-trade P&amp;L,
            win rate, biggest single win, and total activity.{' '}
            <button
              type="button"
              onClick={() => navigate('/glossary')}
              className="text-zinc-300 hover:text-white underline-offset-2 hover:underline"
            >
              How verification works →
            </button>
          </p>
        </div>

        {/* ── Rank-type tabs ────────────────────────────────────── */}
        <div className="flex gap-1 mb-3 border-b border-border overflow-x-auto">
          {RANK_TABS.map((tab) => {
            const Icon = tab.icon
            const isActive = rankType === tab.key
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setRankType(tab.key)}
                className={clsx(
                  'flex items-center gap-1.5 px-3 lg:px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px whitespace-nowrap',
                  isActive
                    ? 'text-white border-red-500'
                    : 'text-muted border-transparent hover:text-subtle',
                )}
              >
                <Icon size={14} />
                {tab.label}
              </button>
            )
          })}
        </div>

        {/* ── Time-window filter ────────────────────────────────── */}
        <div className="flex gap-2 mb-4 overflow-x-auto">
          {TIME_WINDOWS.map((w) => (
            <button
              key={w.key}
              type="button"
              onClick={() => setTimeWindow(w.key)}
              className={clsx(
                'px-2.5 py-1 rounded-md text-[11px] font-medium whitespace-nowrap transition-colors',
                timeWindow === w.key
                  ? 'bg-zinc-800 text-white'
                  : 'bg-card border border-border text-subtle',
              )}
            >
              {w.label}
            </button>
          ))}
        </div>

        {/* ── Body ──────────────────────────────────────────────── */}
        {loading ? (
          <LoadingSkeleton />
        ) : error ? (
          <ErrorState message={error} />
        ) : !data || data.rankings.length === 0 ? (
          <EmptyState
            rankType={rankType}
            timeWindow={timeWindow}
            snapshotComputedAt={data?.snapshot_computed_at}
          />
        ) : (
          <>
            <RankingTable
              rankings={data.rankings}
              activeTab={activeTab}
              onRowClick={(slug) => navigate(`/u/${slug}`)}
              startRank={(page - 1) * PER_PAGE + 1}
            />
            <SnapshotFooter
              computedAt={data.snapshot_computed_at}
              total={data.total_eligible}
              page={page}
              totalPages={data.total_pages}
              onPage={setPage}
            />
          </>
        )}
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// Subcomponents
// ────────────────────────────────────────────────────────────────────

function RankingTable({ rankings, activeTab, onRowClick, startRank }) {
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="hidden lg:grid grid-cols-[60px_1fr_140px_80px_80px] gap-4 px-4 py-3 border-b border-border text-[10px] uppercase tracking-wider text-muted">
        <div>Rank</div>
        <div>Trader</div>
        <div className="text-right">{activeTab.statLabel}</div>
        <div className="text-right">Trades</div>
        <div className="text-right">Win %</div>
      </div>
      <div className="divide-y divide-border">
        {rankings.map((r) => (
          <RankingRow
            key={r.user_id}
            row={r}
            activeTab={activeTab}
            onClick={() => r.public_slug && onRowClick(r.public_slug)}
          />
        ))}
      </div>
    </div>
  )
}

function RankingRow({ row, activeTab, onClick }) {
  const clickable = !!row.public_slug
  const Tag = clickable ? 'button' : 'div'
  return (
    <Tag
      type={clickable ? 'button' : undefined}
      onClick={clickable ? onClick : undefined}
      disabled={!clickable}
      className={clsx(
        'w-full text-left grid grid-cols-[40px_1fr_auto] lg:grid-cols-[60px_1fr_140px_80px_80px] gap-3 lg:gap-4 px-4 py-3 transition-colors',
        clickable
          ? 'hover:bg-zinc-900/60 active:bg-zinc-900'
          : 'opacity-70 cursor-default',
      )}
    >
      <div className="flex items-center">
        <RankBadge rank={row.rank} />
      </div>
      <div className="min-w-0 flex items-center gap-2">
        <div className="w-8 h-8 rounded-full bg-zinc-800 border border-border flex items-center justify-center flex-shrink-0">
          <span className="text-white text-xs font-bold">
            {(row.display_name || row.public_slug || '?').slice(0, 1).toUpperCase()}
          </span>
        </div>
        <div className="min-w-0">
          <p className="text-white text-sm font-medium truncate">
            {row.display_name || `@${row.public_slug}`}
          </p>
          <p className="text-muted text-[10px] truncate">
            @{row.public_slug}
            {row.profile_view_count > 0 && (
              <> · {formatCount(row.profile_view_count)} views</>
            )}
          </p>
        </div>
      </div>
      <div className="text-right font-mono-tab tabular-nums font-bold text-sm lg:text-base">
        {formatStat(row, activeTab.key)}
      </div>
      <div className="hidden lg:block text-right text-zinc-300 text-sm font-mono-tab tabular-nums">
        {row.closed_trades}
      </div>
      <div className="hidden lg:block text-right text-zinc-300 text-sm font-mono-tab tabular-nums">
        {row.win_rate_pct != null ? `${Math.round(row.win_rate_pct)}%` : '—'}
      </div>
    </Tag>
  )
}

function RankBadge({ rank }) {
  // Top 3 get medal-style tints. The rest get a quiet zinc badge.
  if (rank === 1) {
    return (
      <span className="text-amber-400 font-bold text-sm lg:text-base font-mono-tab w-7 text-center">
        #1
      </span>
    )
  }
  if (rank === 2) {
    return (
      <span className="text-zinc-300 font-bold text-sm lg:text-base font-mono-tab w-7 text-center">
        #2
      </span>
    )
  }
  if (rank === 3) {
    return (
      <span className="text-orange-400 font-bold text-sm lg:text-base font-mono-tab w-7 text-center">
        #3
      </span>
    )
  }
  return (
    <span className="text-muted text-xs lg:text-sm font-mono-tab w-7 text-center">
      #{rank}
    </span>
  )
}

function formatStat(row, rankKey) {
  if (rankKey === 'top_earners') {
    const v = Number(row.total_pnl ?? row.stat_value ?? 0)
    return (
      <span className={v >= 0 ? 'text-green-400' : 'text-red-400'}>
        {v >= 0 ? '+' : '−'}${Math.abs(Math.round(v)).toLocaleString()}
      </span>
    )
  }
  if (rankKey === 'biggest_win') {
    const v = Number(row.biggest_win ?? row.stat_value ?? 0)
    return <span className="text-green-400">${Math.round(v).toLocaleString()}</span>
  }
  if (rankKey === 'win_rate') {
    const v = row.win_rate_pct
    return (
      <span className="text-white">
        {v != null ? `${Number(v).toFixed(1)}%` : '—'}
      </span>
    )
  }
  // most_active
  const v = Number(row.closed_trades ?? row.stat_value ?? 0)
  return <span className="text-white">{v.toLocaleString()}</span>
}

function SnapshotFooter({ computedAt, total, page, totalPages, onPage }) {
  return (
    <div className="mt-4 flex items-center justify-between flex-wrap gap-2">
      <p className="text-muted text-[11px]">
        Snapshot from {formatRelative(computedAt)} · {total.toLocaleString()} eligible
      </p>
      {totalPages > 1 && (
        <div className="flex gap-2 items-center">
          <button
            type="button"
            onClick={() => onPage(Math.max(1, page - 1))}
            disabled={page <= 1}
            className="px-2 py-1 rounded-md text-xs text-subtle border border-border disabled:opacity-30"
          >
            Prev
          </button>
          <span className="text-muted text-[11px]">
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            onClick={() => onPage(Math.min(totalPages, page + 1))}
            disabled={page >= totalPages}
            className="px-2 py-1 rounded-md text-xs text-subtle border border-border disabled:opacity-30"
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}

function EmptyState({ rankType, timeWindow, snapshotComputedAt }) {
  // Pre-launch state: snapshot exists but has zero eligible users
  // OR no snapshot has been computed yet.
  const minTrades = MIN_TRADES_HINT[rankType]
  const windowLabel = TIME_WINDOWS.find((w) => w.key === timeWindow)?.label
  const reason = snapshotComputedAt
    ? `No one has hit the minimum ${minTrades} verified ${minTrades === 1 ? 'trade' : 'trades'} in the ${windowLabel.toLowerCase()} window yet.`
    : 'First leaderboard snapshot computes overnight. Check back tomorrow morning.'

  return (
    <div className="bg-card border border-border rounded-xl p-10 text-center space-y-3">
      <div className="text-3xl">🏆</div>
      <p className="text-fg text-base font-display">
        Leaderboard fills as users log verified trades
      </p>
      <p className="text-subtle text-xs leading-relaxed max-w-md mx-auto">
        {reason}
      </p>
      <p className="text-muted text-[10px] leading-relaxed pt-2 border-t border-border max-w-md mx-auto">
        Every trade on Cash Moves is hash-locked at lock time and
        anchored to a public GitHub commit. Rankings can&apos;t be gamed.
      </p>
    </div>
  )
}

function ErrorState({ message }) {
  return (
    <div className="bg-card border border-border rounded-xl p-10 text-center">
      <p className="text-fg text-sm font-display mb-2">Couldn&apos;t load the leaderboard</p>
      <p className="text-muted text-xs">{message}</p>
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div className="bg-card border border-border rounded-xl divide-y divide-border">
      {Array(8).fill(0).map((_, i) => (
        <div key={i} className="h-14 animate-pulse" />
      ))}
    </div>
  )
}

function formatCount(n) {
  const v = Number(n) || 0
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`
  return String(v)
}

function formatRelative(iso) {
  if (!iso) return 'pre-launch'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`
  return `${Math.round(ms / 86_400_000)}d ago`
}
