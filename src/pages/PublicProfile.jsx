// Cash Moves — Polymarket-style public profile.
//
// Route: /u/:slug — anonymous-readable. Replaces the legacy /r/:slug
// route (which now redirects here). Per the leaderboard focus-audit
// spec this is the page that powers the viral loop: every share-out
// renders the user's hash-verified stats as an OG preview.
//
// SSR meta tags are injected upstream by middleware.js — see that
// file for the title / og:* template. This component renders the
// actual page body. View counter fires on mount via the
// profile-view-track edge function.
//
// Data: single round-trip to the profile-public-data edge function
// returns profile + stats + recent positions. No supabase-js client
// needed for the public read.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ArrowDown,
  ArrowUp,
  DollarSign,
  Eye,
  Hash,
  Layers,
  Lock,
  Share2,
  Trophy,
  TrendingDown,
  TrendingUp,
} from 'lucide-react'
import EquityCurve from '../components/EquityCurve'
import clsx from 'clsx'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

const STRATEGY_META = {
  BULL_CALL:        { label: 'Bull Call',        icon: TrendingUp,   tone: 'text-green-400' },
  BEAR_PUT:         { label: 'Bear Put',         icon: TrendingDown, tone: 'text-red-400' },
  BULL_PUT_CREDIT:  { label: 'Bull Put Credit',  icon: ArrowUp,      tone: 'text-emerald-400' },
  BEAR_CALL_CREDIT: { label: 'Bear Call Credit', icon: ArrowDown,    tone: 'text-rose-400' },
  IRON_CONDOR:      { label: 'Iron Condor',      icon: Layers,       tone: 'text-purple-400' },
}

export default function PublicProfile() {
  const { slug } = useParams()
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [tab, setTab] = useState('closed')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [shareFlash, setShareFlash] = useState('')
  const viewTrackedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError('')
      try {
        const resp = await fetch(`${SUPABASE_URL}/functions/v1/profile-public-data`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({ slug }),
        })
        const body = await resp.json()
        if (cancelled) return
        if (!resp.ok || !body?.success) {
          setError(body?.error || 'Profile not found')
          setData(null)
        } else {
          setData(body.data)
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'network error')
          setData(null)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [slug])

  // Fire-and-forget view tracking. Guarded by viewTrackedRef so React
  // strict-mode double-mounts don't double-count.
  useEffect(() => {
    if (!data || viewTrackedRef.current) return
    viewTrackedRef.current = true
    let viewerSessionId = null
    try {
      // Stable per-browser id for anonymous dedup. Persisted in
      // localStorage; rotated only when the user clears storage.
      const KEY = 'cm_viewer_session'
      viewerSessionId = window.localStorage.getItem(KEY)
      if (!viewerSessionId) {
        viewerSessionId = crypto.randomUUID()
        window.localStorage.setItem(KEY, viewerSessionId)
      }
    } catch {
      // Private mode / storage blocked — fall back to a per-tab id
      viewerSessionId = `tab-${Math.random().toString(36).slice(2)}`
    }
    fetch(`${SUPABASE_URL}/functions/v1/profile-view-track`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ slug, viewer_session_id: viewerSessionId }),
      keepalive: true,
    }).catch(() => {
      // View tracking is non-essential — silently swallow failures.
    })
  }, [data, slug])

  const stats = data?.stats
  const profile = data?.profile
  const positions = data?.positions

  const equityPoints = useMemo(
    () =>
      (positions?.closed ?? [])
        .filter((p) => p.closed_at && p.realized_pnl != null)
        .map((p) => ({ at: p.closed_at, realized_pnl: Number(p.realized_pnl) })),
    [positions?.closed],
  )

  async function shareProfile() {
    const url = `${window.location.origin}/u/${slug}`
    const text = stats?.trades
      ? `${profile?.display_name || slug}'s verified options record on Cash Moves — $${Math.round(stats.total_pnl).toLocaleString()} P&L · ${stats.trades} trades · hash-verified.`
      : `${profile?.display_name || slug} on Cash Moves`
    if (navigator.share) {
      try {
        await navigator.share({ title: profile?.display_name || slug, text, url })
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
      <div className="min-h-screen bg-bg flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-red-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center px-4">
        <div className="bg-card border border-border rounded-xl p-8 text-center max-w-md">
          <Lock size={32} className="mx-auto text-muted mb-3" />
          <p className="text-fg text-base font-display mb-2">Profile not found</p>
          <p className="text-subtle text-xs mb-4 leading-relaxed">
            {error || 'This user doesn\'t exist, or has set their profile to private.'}
          </p>
          <button
            type="button"
            onClick={() => navigate('/login')}
            className="text-red-400 text-sm hover:text-red-300 font-medium"
          >
            Sign in to Cash Moves →
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-bg">
      <div className="px-4 lg:px-6 pt-6 pb-12 mx-auto lg:max-w-4xl w-full">
        {/* ── Profile header ───────────────────────────────────── */}
        <div className="flex items-start gap-4 mb-6">
          <div className="w-14 h-14 lg:w-16 lg:h-16 rounded-full bg-zinc-800 border border-border flex items-center justify-center flex-shrink-0">
            <span className="text-white text-xl font-bold">
              {(profile.display_name || slug).slice(0, 1).toUpperCase()}
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-white text-xl lg:text-2xl font-bold truncate">
              {profile.display_name || `@${slug}`}
            </h1>
            <p className="text-muted text-xs mt-1 flex items-center gap-2 flex-wrap">
              <span>@{slug}</span>
              <span>·</span>
              <span>Joined {formatJoinDate(profile.joined_at)}</span>
              <span>·</span>
              <span className="flex items-center gap-1">
                <Eye size={11} />
                {formatCount(profile.view_count)} views
              </span>
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={shareProfile}
                className="flex items-center gap-1 text-xs bg-zinc-800 hover:bg-zinc-700 text-white px-3 py-1.5 rounded-lg transition-colors"
              >
                <Share2 size={12} />
                Share Profile
              </button>
              {stats.leaderboard_rank && (
                <div className="flex items-center gap-1 text-xs border border-amber-900 bg-amber-950/30 text-amber-400 px-3 py-1.5 rounded-lg">
                  <Trophy size={12} />
                  Ranked #{stats.leaderboard_rank}
                </div>
              )}
            </div>
            {shareFlash && (
              <p className="text-green-400 text-xs mt-2" role="status">
                {shareFlash}
              </p>
            )}
          </div>
        </div>

        {/* ── 4 stat blocks ────────────────────────────────────── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
          <StatBlock
            icon={DollarSign}
            label="Verified P&L"
            value={fmtDollarSigned(stats.total_pnl)}
            tone={stats.total_pnl >= 0 ? 'text-green-400' : 'text-red-400'}
          />
          <StatBlock
            icon={TrendingUp}
            label="Win Rate"
            value={stats.win_rate_pct != null && stats.trades >= 10
              ? `${stats.win_rate_pct.toFixed(1)}%`
              : '—'}
            tone="text-white"
          />
          <StatBlock
            icon={TrendingUp}
            label="Biggest Win"
            value={`$${Math.round(stats.biggest_win).toLocaleString()}`}
            tone="text-green-400"
          />
          <StatBlock
            icon={Hash}
            label="Trades"
            value={String(stats.trades)}
            tone="text-white"
          />
        </div>

        {/* ── Equity curve hero ────────────────────────────────── */}
        <EquityCurve points={equityPoints} className="mb-4" />

        {/* ── Positions tabs ───────────────────────────────────── */}
        <div className="flex gap-2 mb-3">
          {['active', 'closed'].map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={clsx(
                'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
                tab === t
                  ? 'bg-zinc-800 text-white'
                  : 'bg-card border border-border text-subtle',
              )}
            >
              {t === 'active'
                ? `Active (${positions.open.length})`
                : `Closed (${positions.closed.length})`}
            </button>
          ))}
        </div>

        <div className="space-y-2">
          {(tab === 'active' ? positions.open : positions.closed).map((p) => (
            <PublicPositionRow key={p.id} pos={p} isClosed={tab === 'closed'} />
          ))}
          {(tab === 'active' ? positions.open : positions.closed).length === 0 && (
            <p className="text-center text-muted text-xs py-10">
              {tab === 'active' ? 'No open positions.' : 'No closed trades yet.'}
            </p>
          )}
        </div>

        {/* ── Hash verification footer ─────────────────────────── */}
        <div className="mt-8 pt-4 border-t border-border text-center">
          <p className="text-muted text-[11px] flex items-center justify-center gap-1.5">
            <Hash size={11} className="text-amber-400" />
            All trades cryptographically hash-locked at lock time
          </p>
          <button
            type="button"
            onClick={() => navigate('/learn/glossary')}
            className="text-zinc-500 text-[10px] hover:text-zinc-300 mt-1"
          >
            How verification works →
          </button>
        </div>

        {/* ── Footer CTA ───────────────────────────────────────── */}
        <div className="mt-8 bg-card border border-border rounded-xl p-6 text-center">
          <p className="text-white text-sm font-display mb-2">
            Want a verified record like {profile.display_name || `@${slug}`}?
          </p>
          <p className="text-subtle text-xs mb-4 leading-relaxed max-w-sm mx-auto">
            Cash Moves logs every options thesis to a public, hash-verified
            chain. Your record builds itself trade by trade.
          </p>
          <button
            type="button"
            onClick={() => navigate('/login')}
            className="bg-red-600 hover:bg-red-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            Sign up for Cash Moves
          </button>
        </div>
      </div>
    </div>
  )
}

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

function PublicPositionRow({ pos, isClosed }) {
  const meta = STRATEGY_META[pos.strategy_type] ?? {
    label: pos.strategy_type, icon: Hash, tone: 'text-zinc-400',
  }
  const Icon = meta.icon
  const pnlDollar = isClosed ? Number(pos.realized_pnl ?? 0) : null
  const pnlPct = !isClosed && pos.last_pnl_pct != null ? Number(pos.last_pnl_pct) : null
  const positive = (pnlDollar ?? pnlPct ?? 0) >= 0
  return (
    <div className="bg-card border border-border rounded-xl px-4 py-3 flex items-center gap-3">
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
        </div>
        <p className="text-muted text-[10px] truncate mt-0.5">
          {isClosed
            ? `Closed ${formatDate(pos.closed_at)}`
            : `Opened ${formatDate(pos.entry_at)}${pos.expiration ? ` · exp ${pos.expiration}` : ''}`}
        </p>
      </div>
      <div className="text-right flex-shrink-0">
        {pnlDollar != null && (
          <p className={clsx('font-bold text-sm font-mono-tab tabular-nums', positive ? 'text-green-400' : 'text-red-400')}>
            {positive ? '+' : '−'}${Math.abs(Math.round(pnlDollar)).toLocaleString()}
          </p>
        )}
        {pnlPct != null && (
          <p className={clsx('font-bold text-sm font-mono-tab tabular-nums', positive ? 'text-green-400' : 'text-red-400')}>
            {positive ? '+' : ''}{Math.round(pnlPct)}%
          </p>
        )}
      </div>
    </div>
  )
}

function fmtDollarSigned(n) {
  const abs = Math.abs(Math.round(Number(n) || 0))
  return `${Number(n) >= 0 ? '+' : '−'}$${abs.toLocaleString()}`
}

function formatJoinDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
}

function formatDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString()
}

function formatCount(n) {
  const v = Number(n) || 0
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`
  return String(v)
}
