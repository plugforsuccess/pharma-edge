import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Share2, TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import Sparkline from '../components/Sparkline'
import clsx from 'clsx'

const SIGNAL_TYPES = [
  { key: 'enrollment_signal', label: 'Enrollment Signal' },
  { key: 'fda_precedent_signal', label: 'FDA Precedent' },
  { key: 'protocol_amendment_signal', label: 'Protocol Amendment' },
  { key: 'insider_selling_signal', label: 'Insider Selling' },
  { key: 'cash_runway_signal', label: 'Cash Runway' },
]

export default function TrackRecord() {
  const { user, profile } = useAuth()
  const navigate = useNavigate()
  const [outcomes, setOutcomes] = useState([])
  const [stats, setStats] = useState(null)
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
    const { data } = await supabase
      .from('outcomes')
      .select('*, signals(*)')
      .eq('user_id', user.id)
      .order('recorded_at', { ascending: false })

    const list = data ?? []
    setOutcomes(list)
    setStats(computeStats(list))
    setLoading(false)
  }

  async function shareRecord() {
    if (!profile?.public_slug) {
      setShareFlash('Set a public slug in Settings first.')
      setTimeout(() => setShareFlash(''), 2500)
      return
    }
    const url = `${window.location.origin}/r/${profile.public_slug}`
    const text =
      stats?.total > 0
        ? `My verified biotech signal track record — ${stats.winRate}% win rate on ${stats.resolved} resolved signals.`
        : 'My verified biotech signal track record.'

    if (navigator.share) {
      try {
        await navigator.share({ title: 'My Wiley Edge Signal Record', text, url })
        return
      } catch {
        // user cancelled or share failed; fall through to clipboard
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

  const filtered = outcomes.filter((o) => {
    if (filter === 'wins') return o.thesis_correct === true
    if (filter === 'losses') return o.thesis_correct === false
    if (filter === 'paper') return o.signals?.trade_type === 'paper'
    if (filter === 'real') return o.signals?.trade_type === 'real'
    return true
  })

  return (
    <div className="px-4 pt-6 pb-4">
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-white text-xl font-bold">Track Record</h1>
        {profile?.is_public && profile?.public_slug && (
          <button
            type="button"
            onClick={shareRecord}
            className="flex items-center gap-1 text-subtle text-xs hover:text-white transition-colors"
            title="Share your public track record"
          >
            <Share2 size={12} />
            Share Record
          </button>
        )}
      </div>
      {shareFlash && (
        <p className="text-green-400 text-xs mb-4" role="status">
          {shareFlash}
        </p>
      )}

      {loading ? (
        <LoadingSkeleton />
      ) : !stats || stats.total === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className="bg-card border border-border rounded-xl p-4 mb-4">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-muted text-xs uppercase tracking-wider">Overall Win Rate</p>
                <p
                  className={clsx('text-4xl font-bold mt-1', {
                    'text-green-400': stats.winRate >= 60,
                    'text-yellow-400': stats.winRate >= 50 && stats.winRate < 60,
                    'text-red-400': stats.winRate < 50,
                  })}
                >
                  {stats.winRate}%
                </p>
              </div>
              <div className="text-right">
                <p className="text-muted text-xs">Resolved Signals</p>
                <p className="text-white text-2xl font-bold mt-1">{stats.total}</p>
              </div>
            </div>

            <div className="h-2 bg-zinc-800 rounded-full overflow-hidden mb-4">
              <div
                className="h-full bg-gradient-to-r from-red-600 to-green-500 rounded-full transition-all"
                style={{ width: `${stats.winRate}%` }}
              />
            </div>

            <div className="grid grid-cols-4 gap-2 text-center">
              <StatBox label="Wins" value={stats.wins} color="text-green-400" />
              <StatBox label="Losses" value={stats.losses} color="text-red-400" />
              <StatBox label="Paper" value={stats.paper} color="text-zinc-400" />
              <StatBox label="Real" value={stats.real} color="text-white" />
            </div>

            {stats.equityCurve && stats.equityCurve.length >= 2 && (
              <div className="mt-4 pt-4 border-t border-border">
                <div className="flex items-baseline justify-between mb-2">
                  <p className="text-muted text-[10px] uppercase tracking-wider">
                    Cumulative %
                  </p>
                  <p
                    className={clsx(
                      'text-sm font-mono-tab font-semibold',
                      stats.cumPnlPct >= 0 ? 'text-green-400' : 'text-red-400',
                    )}
                  >
                    {stats.cumPnlPct >= 0 ? '+' : ''}
                    {stats.cumPnlPct.toFixed(0)}%
                  </p>
                </div>
                <Sparkline values={stats.equityCurve} width={320} height={56} />
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 mb-4">
            <div className="bg-green-950/20 border border-green-900/30 rounded-xl p-4">
              <p className="text-muted text-xs uppercase tracking-wider">Avg Win</p>
              <p className="text-green-400 text-2xl font-bold mt-1">
                {stats.avgPnlWins != null ? `+${stats.avgPnlWins}%` : '—'}
              </p>
            </div>
            <div className="bg-red-950/20 border border-red-900/30 rounded-xl p-4">
              <p className="text-muted text-xs uppercase tracking-wider">Avg Loss</p>
              <p className="text-red-400 text-2xl font-bold mt-1">
                {stats.avgPnlLosses != null ? `${stats.avgPnlLosses}%` : '—'}
              </p>
            </div>
          </div>

          <div className="bg-card border border-border rounded-xl p-4 mb-4">
            <h3 className="text-subtle text-xs font-semibold uppercase tracking-wider mb-3">
              Rules Discipline
            </h3>
            <div className="grid grid-cols-2 gap-3 text-center">
              <div>
                <p className="text-white font-bold text-xl">{stats.rulesFollowedRate}%</p>
                <p className="text-muted text-[10px]">Rules followed</p>
              </div>
              <div>
                <p
                  className={clsx(
                    'font-bold text-xl',
                    stats.winRateWhenRulesFollowed >= 60 ? 'text-green-400' : 'text-yellow-400',
                  )}
                >
                  {stats.winRateWhenRulesFollowed}%
                </p>
                <p className="text-muted text-[10px]">Win rate when disciplined</p>
              </div>
            </div>
          </div>

          {Object.keys(stats.bySignalType).length > 0 && (
            <div className="bg-card border border-border rounded-xl p-4 mb-4">
              <h3 className="text-subtle text-xs font-semibold uppercase tracking-wider mb-3">
                Signal Type Performance
              </h3>
              <div className="space-y-3">
                {Object.entries(stats.bySignalType)
                  .sort((a, b) => b[1].wins / b[1].total - a[1].wins / a[1].total)
                  .map(([type, data]) => {
                    const rate = Math.round((data.wins / data.total) * 100)
                    return (
                      <div key={type} className="flex items-center justify-between">
                        <p className="text-zinc-400 text-xs flex-1">{type}</p>
                        <div className="flex items-center gap-2">
                          <div className="w-20 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                            <div
                              className={clsx(
                                'h-full rounded-full',
                                rate >= 60 ? 'bg-green-500' : rate >= 50 ? 'bg-yellow-500' : 'bg-red-500',
                              )}
                              style={{ width: `${rate}%` }}
                            />
                          </div>
                          <p
                            className={clsx(
                              'text-xs font-semibold w-8 text-right',
                              rate >= 60 ? 'text-green-400' : rate >= 50 ? 'text-yellow-400' : 'text-red-400',
                            )}
                          >
                            {rate}%
                          </p>
                          <p className="text-muted text-[10px] w-12 text-right">
                            {data.wins}/{data.total}
                          </p>
                        </div>
                      </div>
                    )
                  })}
              </div>
            </div>
          )}

          <div className="flex gap-2 mb-3 overflow-x-auto">
            {['all', 'wins', 'losses', 'paper', 'real'].map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={clsx(
                  'px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors',
                  filter === f ? 'bg-red-600 text-white' : 'bg-card border border-border text-subtle',
                )}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>

          <div className="space-y-2">
            {filtered.map((outcome) => (
              <OutcomeRow
                key={outcome.id}
                outcome={outcome}
                onClick={() => navigate(`/signal/${outcome.signal_id}`)}
              />
            ))}
            {filtered.length === 0 && (
              <p className="text-subtle text-xs text-center py-6">
                No outcomes match this filter.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function computeStats(rows) {
  const resolved = rows.filter((o) => o.thesis_correct !== null && o.thesis_correct !== undefined)
  const wins = resolved.filter((o) => o.thesis_correct)
  const losses = resolved.filter((o) => !o.thesis_correct)
  const paper = resolved.filter((o) => o.signals?.trade_type === 'paper')
  const real = resolved.filter((o) => o.signals?.trade_type === 'real')
  const rulesFollowed = resolved.filter((o) => o.rules_followed)
  const winsOnRulesFollowed = rulesFollowed.filter((o) => o.thesis_correct)

  const bySignalType = {}
  for (const o of resolved) {
    const sig = o.signals
    if (!sig) continue
    for (const { key, label } of SIGNAL_TYPES) {
      if ((sig[key] ?? 0) > 5) {
        if (!bySignalType[label]) bySignalType[label] = { wins: 0, total: 0 }
        bySignalType[label].total++
        if (o.thesis_correct) bySignalType[label].wins++
      }
    }
  }

  const winsWithPnl = wins.filter((o) => o.pnl_percent != null)
  const lossesWithPnl = losses.filter((o) => o.pnl_percent != null)
  const avgPnlWins = winsWithPnl.length
    ? Math.round(winsWithPnl.reduce((s, o) => s + Number(o.pnl_percent), 0) / winsWithPnl.length)
    : null
  const avgPnlLosses = lossesWithPnl.length
    ? Math.round(lossesWithPnl.reduce((s, o) => s + Number(o.pnl_percent), 0) / lossesWithPnl.length)
    : null

  // Equity curve: cumulative running pnl_percent in chronological order.
  // Approximates portfolio % return assuming equal sizing — close enough
  // for the shareable shape, not a strict P&L attribution.
  const chronological = resolved
    .filter((o) => o.pnl_percent != null)
    .slice()
    .sort(
      (a, b) =>
        new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime(),
    )
  let cum = 0
  const equityCurve = chronological.map((o) => {
    cum += Number(o.pnl_percent)
    return cum
  })
  const cumPnlPct = equityCurve.length ? equityCurve[equityCurve.length - 1] : 0

  return {
    total: resolved.length,
    wins: wins.length,
    losses: losses.length,
    winRate: resolved.length ? Math.round((wins.length / resolved.length) * 100) : 0,
    paper: paper.length,
    real: real.length,
    rulesFollowedRate: resolved.length
      ? Math.round((rulesFollowed.length / resolved.length) * 100)
      : 0,
    winRateWhenRulesFollowed: rulesFollowed.length
      ? Math.round((winsOnRulesFollowed.length / rulesFollowed.length) * 100)
      : 0,
    avgPnlWins,
    avgPnlLosses,
    bySignalType,
    equityCurve,
    cumPnlPct,
  }
}

function OutcomeRow({ outcome, onClick }) {
  const sig = outcome.signals
  const isWin = outcome.thesis_correct === true
  const isLoss = outcome.thesis_correct === false

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left bg-card border border-border rounded-xl px-4 py-3 flex items-center gap-3 hover:border-zinc-700 transition-colors active:scale-[0.98]"
    >
      <div
        className={clsx(
          'w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0',
          {
            'bg-green-950 text-green-400': isWin,
            'bg-red-950 text-red-400': isLoss,
            'bg-zinc-900 text-zinc-400': !isWin && !isLoss,
          },
        )}
      >
        {isWin ? <TrendingUp size={14} /> : isLoss ? <TrendingDown size={14} /> : <Minus size={14} />}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-white font-bold text-sm">{sig?.ticker}</p>
          {sig?.trade_type && (
            <span className="text-[10px] text-muted border border-zinc-800 px-1.5 py-0.5 rounded-full uppercase">
              {sig.trade_type}
            </span>
          )}
          {!outcome.rules_followed && (
            <span className="text-[10px] text-yellow-500 border border-yellow-900 px-1.5 py-0.5 rounded-full">
              rule break
            </span>
          )}
        </div>
        <p className="text-muted text-[10px] truncate mt-0.5">
          {outcome.catalyst_result?.replace(/_/g, ' ')} ·{' '}
          {new Date(outcome.recorded_at).toLocaleDateString()}
        </p>
      </div>

      <div className="text-right flex-shrink-0">
        {outcome.pnl_percent != null && (
          <p
            className={clsx(
              'font-bold text-sm',
              Number(outcome.pnl_percent) >= 0 ? 'text-green-400' : 'text-red-400',
            )}
          >
            {Number(outcome.pnl_percent) >= 0 ? '+' : ''}
            {outcome.pnl_percent}%
          </p>
        )}
        <p
          className={clsx(
            'text-[10px] font-semibold',
            isWin ? 'text-green-400' : isLoss ? 'text-red-400' : 'text-subtle',
          )}
        >
          {isWin ? 'WIN' : isLoss ? 'LOSS' : 'N/A'}
        </p>
      </div>
    </button>
  )
}

function StatBox({ label, value, color }) {
  return (
    <div>
      <p className={clsx('font-bold text-lg', color)}>{value}</p>
      <p className="text-muted text-[10px]">{label}</p>
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4">
      {Array(4)
        .fill(0)
        .map((_, i) => (
          <div
            key={i}
            className="bg-card border border-border rounded-xl p-4 h-24 animate-pulse"
          />
        ))}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="bg-card border border-border rounded-xl p-8 text-center">
      <p className="text-subtle text-sm">No resolved signals yet</p>
      <p className="text-muted text-xs mt-1">
        Log signals and outcomes to build your track record
      </p>
    </div>
  )
}
