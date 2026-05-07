import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { ExternalLink, Shield } from 'lucide-react'
import { supabase } from '../lib/supabase'
import Sparkline from '../components/Sparkline'
import clsx from 'clsx'

const REPO = import.meta.env.VITE_PUBLIC_RECORD_REPO || ''

export default function PublicRecord() {
  const { slug } = useParams()
  const [profile, setProfile] = useState(null)
  const [signals, setSignals] = useState([])
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    if (!slug) {
      setNotFound(true)
      setLoading(false)
      return
    }
    fetchPublicRecord()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug])

  async function fetchPublicRecord() {
    setLoading(true)

    const { data: profileData } = await supabase
      .from('profiles')
      .select('id, display_name, public_slug, is_public')
      .eq('public_slug', slug)
      .eq('is_public', true)
      .maybeSingle()

    if (!profileData) {
      setNotFound(true)
      setLoading(false)
      return
    }
    setProfile(profileData)

    const { data: recordData } = await supabase
      .from('public_record')
      .select('*')
      .eq('public_slug', slug)
      .order('logged_at', { ascending: false })

    const list = recordData ?? []
    setSignals(list)
    setStats(computeStats(list))
    setLoading(false)
  }

  if (loading) return <LoadingPage />
  if (notFound) return <NotFoundPage />

  return (
    <div className="min-h-screen bg-bg px-4 lg:px-6 py-8 max-w-md lg:max-w-3xl mx-auto">
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 bg-red-600 rounded-xl flex items-center justify-center">
            <span className="text-white font-bold text-sm">CM</span>
          </div>
          <div>
            <h1 className="text-white font-bold text-lg">
              {profile?.display_name || 'Cash Moves Trader'}
            </h1>
            <p className="text-subtle text-xs">Public Signal Record</p>
          </div>
        </div>

        <div className="bg-green-950/20 border border-green-900/30 rounded-xl p-3 mt-4 flex items-start gap-2">
          <Shield size={14} className="text-green-400 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-green-400 text-xs font-semibold">Verified Immutable Record</p>
            <p className="text-subtle text-[10px] mt-0.5">
              All signals are timestamped at logging time. Thesis, direction, and catalyst date
              cannot be edited after logging. Each signal is SHA-256 hashed and anchored to a
              public GitHub commit.
            </p>
          </div>
        </div>
      </div>

      {stats && stats.equityCurve.length >= 2 && (
        <div className="bg-card border border-border rounded-xl p-4 mb-3">
          <div className="flex items-baseline justify-between mb-2">
            <p className="text-muted text-[10px] uppercase tracking-wider">
              Cumulative %
            </p>
            <p
              className={clsx(
                'text-base font-mono-tab font-semibold',
                stats.cumPnl >= 0 ? 'text-green-400' : 'text-red-400',
              )}
            >
              {stats.cumPnl >= 0 ? '+' : ''}
              {stats.cumPnl.toFixed(0)}%
            </p>
          </div>
          <Sparkline values={stats.equityCurve} width={400} height={70} />
        </div>
      )}

      {stats?.lastUpdated && (
        <p className="text-muted text-[10px] mb-3">
          Last updated{' '}
          {stats.lastUpdated.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          })}
        </p>
      )}

      {stats && (
        <div className="mb-6">
          <div className="grid grid-cols-2 gap-3 mb-3">
            <StatCard
              label="Win Rate"
              value={`${stats.winRate}%`}
              sub={`${stats.wins}W / ${stats.losses}L`}
              color={
                stats.winRate >= 60
                  ? 'text-green-400'
                  : stats.winRate >= 50
                    ? 'text-yellow-400'
                    : 'text-red-400'
              }
            />
            <StatCard
              label="Resolved Signals"
              value={stats.resolved}
              sub={`${stats.total} total logged`}
              color="text-white"
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <StatCard label="Paper" value={stats.paper} sub="trades" color="text-zinc-400" small />
            <StatCard label="Real" value={stats.real} sub="trades" color="text-white" small />
            {stats.avgPnl != null && (
              <StatCard
                label="Avg P&L"
                value={`${stats.avgPnl > 0 ? '+' : ''}${stats.avgPnl}%`}
                sub="resolved"
                color={stats.avgPnl > 0 ? 'text-green-400' : 'text-red-400'}
                small
              />
            )}
          </div>
        </div>
      )}

      <div className="bg-card border border-border rounded-xl p-3 mb-6">
        <p className="text-muted text-[10px] leading-relaxed">
          ⚠️ This record is for informational purposes only. Not financial advice. Past signal
          accuracy does not guarantee future results. All data sourced from public FDA,
          ClinicalTrials.gov, and SEC databases.
        </p>
      </div>

      <div>
        <h2 className="text-subtle text-xs font-semibold uppercase tracking-wider mb-3">
          Signal History ({signals.length})
        </h2>
        <div className="space-y-2">
          {signals.length === 0 ? (
            <p className="text-subtle text-xs text-center py-6">No public signals yet.</p>
          ) : (
            signals.map((signal) => <PublicSignalRow key={signal.id} signal={signal} />)
          )}
        </div>
      </div>

      <div className="mt-8 text-center">
        <p className="text-muted text-xs">Powered by</p>
        <a
          href="/"
          className="text-subtle text-sm font-bold hover:text-red-400 transition-colors"
        >
          CASH MOVES
        </a>
      </div>
    </div>
  )
}

function computeStats(rows) {
  if (!rows?.length) {
    return {
      total: 0,
      resolved: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      paper: 0,
      real: 0,
      avgPnl: null,
      equityCurve: [],
      cumPnl: 0,
      lastUpdated: null,
    }
  }
  const resolved = rows.filter((s) => s.thesis_correct !== null && s.thesis_correct !== undefined)
  const wins = resolved.filter((s) => s.thesis_correct).length
  const losses = resolved.length - wins
  const paper = rows.filter((s) => s.trade_type === 'paper').length
  const real = rows.filter((s) => s.trade_type === 'real').length
  const withPnl = resolved.filter((s) => s.pnl_percent != null)
  const avgPnl = withPnl.length
    ? Math.round(withPnl.reduce((sum, s) => sum + Number(s.pnl_percent), 0) / withPnl.length)
    : null

  // Cumulative running % of resolved P&L in chronological order. Same
  // approximation as TrackRecord — equal-sized signals — enough to read
  // the shape of the record at a glance.
  const chrono = withPnl.slice().sort((a, b) => {
    const ta = new Date(a.outcome_date || a.logged_at).getTime()
    const tb = new Date(b.outcome_date || b.logged_at).getTime()
    return ta - tb
  })
  let cum = 0
  const equityCurve = chrono.map((s) => {
    cum += Number(s.pnl_percent)
    return cum
  })
  const cumPnl = equityCurve.length ? equityCurve[equityCurve.length - 1] : 0

  // Most recent activity timestamp (logged_at OR outcome_date) for the
  // "Last updated" header.
  const allTimes = rows.flatMap((r) =>
    [r.logged_at, r.outcome_date].filter(Boolean).map((t) => new Date(t).getTime()),
  )
  const lastUpdated = allTimes.length ? new Date(Math.max(...allTimes)) : null

  return {
    total: rows.length,
    resolved: resolved.length,
    wins,
    losses,
    winRate: resolved.length ? Math.round((wins / resolved.length) * 100) : 0,
    paper,
    real,
    avgPnl,
    equityCurve,
    cumPnl,
    lastUpdated,
  }
}

function PublicSignalRow({ signal }) {
  const isResolved = signal.thesis_correct !== null && signal.thesis_correct !== undefined
  const isWin = signal.thesis_correct === true

  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="flex items-start justify-between mb-2 gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-white font-bold text-sm">{signal.ticker}</span>
          <span
            className={clsx(
              'text-[10px] font-bold px-2 py-0.5 rounded-full border',
              signal.direction === 'long_put'
                ? 'text-red-400 bg-red-950 border-red-800'
                : signal.direction === 'long_call'
                  ? 'text-green-400 bg-green-950 border-green-800'
                  : 'text-zinc-400 bg-zinc-900 border-zinc-700',
            )}
          >
            {signal.direction === 'long_put'
              ? 'PUT'
              : signal.direction === 'long_call'
                ? 'CALL'
                : 'WATCH'}
          </span>
          <span className="text-[10px] text-muted border border-zinc-800 px-1.5 py-0.5 rounded-full uppercase">
            {signal.trade_type}
          </span>
        </div>

        {isResolved ? (
          <span
            className={clsx(
              'text-[10px] font-bold px-2 py-1 rounded-lg whitespace-nowrap',
              isWin ? 'bg-green-950/50 text-green-400' : 'bg-red-950/50 text-red-400',
            )}
          >
            {isWin ? '✓ WIN' : '✗ LOSS'}
            {signal.pnl_percent != null && (
              <span className="ml-1">
                {Number(signal.pnl_percent) > 0 ? '+' : ''}
                {signal.pnl_percent}%
              </span>
            )}
          </span>
        ) : (
          <span className="text-[10px] text-muted bg-zinc-900 px-2 py-1 rounded-lg">OPEN</span>
        )}
      </div>

      <div className="grid grid-cols-4 gap-2 mb-3">
        <Detail
          label="Logged"
          value={new Date(signal.logged_at).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: '2-digit',
          })}
        />
        <Detail
          label="Catalyst"
          value={new Date(signal.catalyst_date).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: '2-digit',
          })}
        />
        <Detail
          label="Confidence"
          value={signal.confidence_score != null ? `${signal.confidence_score}/10` : '—'}
        />
        <Detail
          label="Entry POP"
          value={
            signal.entry_pop_bp != null
              ? `${Math.round(signal.entry_pop_bp / 100)}%`
              : '—'
          }
        />
      </div>

      {signal.catalyst_result && (
        <p className="text-muted text-[10px] mb-2">
          Result: {signal.catalyst_result.replace(/_/g, ' ')}
          {signal.outcome_date &&
            ` · ${new Date(signal.outcome_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`}
        </p>
      )}

      {signal.signal_hash && (
        <div className="flex items-center gap-2 pt-2 border-t border-zinc-900">
          <Shield size={10} className="text-green-600 flex-shrink-0" />
          <p className="text-muted text-[10px] font-mono truncate flex-1">
            {String(signal.signal_hash).slice(0, 16)}…
          </p>
          {signal.github_commit_sha && REPO && (
            <a
              href={`https://github.com/${REPO}/commit/${signal.github_commit_sha}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted hover:text-subtle transition-colors"
              aria-label="View GitHub commit anchor"
            >
              <ExternalLink size={10} />
            </a>
          )}
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value, sub, color, small }) {
  return (
    <div className="bg-card border border-border rounded-xl p-3 text-center">
      <p className={clsx('font-bold', small ? 'text-xl' : 'text-3xl', color)}>{value}</p>
      <p className="text-subtle text-[10px] uppercase tracking-wider mt-0.5">{label}</p>
      {sub && <p className="text-muted text-[10px] mt-0.5">{sub}</p>}
    </div>
  )
}

function Detail({ label, value }) {
  return (
    <div>
      <p className="text-muted text-[10px]">{label}</p>
      <p className="text-zinc-400 text-xs font-medium">{value}</p>
    </div>
  )
}

function LoadingPage() {
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-red-500 border-t-transparent rounded-full animate-spin" />
    </div>
  )
}

function NotFoundPage() {
  return (
    <div className="min-h-screen bg-bg flex flex-col items-center justify-center px-4 text-center">
      <div className="w-12 h-12 bg-red-950 rounded-xl flex items-center justify-center mx-auto mb-4">
        <span className="text-red-400 text-xl">?</span>
      </div>
      <h1 className="text-white font-bold text-xl mb-2">Record Not Found</h1>
      <p className="text-subtle text-sm mb-6">
        This public record doesn't exist or has been set to private.
      </p>
      <a href="/" className="text-red-400 text-sm hover:text-red-300">
        Back to Cash Moves →
      </a>
    </div>
  )
}
