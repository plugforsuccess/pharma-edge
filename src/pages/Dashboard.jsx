import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight, Cpu, Plus } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { daysUntil } from '../utils/dates'
import { signalColor, catalystLabel, directionLabel } from '../lib/design'
import NotificationCenter from '../components/NotificationCenter'
import PaperTradingStatus from '../components/PaperTradingStatus'
import clsx from 'clsx'

export default function Dashboard() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [signals, setSignals] = useState([])
  const [stats, setStats] = useState({ wins: 0, losses: 0, open: 0, winRate: 0, total: 0 })
  const [pendingCandidates, setPendingCandidates] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user) return
    fetchDashboardData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  async function fetchDashboardData() {
    setLoading(true)
    const [signalRes, openCountRes, outcomeRes, candidateCountRes] = await Promise.all([
      supabase
        .from('signals')
        .select('*, outcomes(*)')
        .eq('user_id', user.id)
        .eq('status', 'active')
        .order('logged_at', { ascending: false })
        .limit(10),
      supabase
        .from('signals')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('status', 'active'),
      supabase.from('outcomes').select('thesis_correct').eq('user_id', user.id),
      supabase
        .from('scanner_candidates')
        .select('id', { count: 'exact', head: true })
        .eq('reviewed', false)
        .eq('dismissed', false),
    ])

    setSignals(signalRes.data ?? [])

    const outcomes = outcomeRes.data ?? []
    const wins = outcomes.filter((o) => o.thesis_correct).length
    const losses = outcomes.filter((o) => !o.thesis_correct).length
    const total = wins + losses
    setStats({
      wins,
      losses,
      open: openCountRes.count ?? 0,
      winRate: total > 0 ? Math.round((wins / total) * 100) : 0,
      total,
    })
    setPendingCandidates(candidateCountRes.count ?? 0)

    setLoading(false)
  }

  return (
    <div className="px-4 pt-6 pb-4">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-white text-xl font-bold tracking-tight">Pharma Edge</h1>
          <p className="text-subtle text-xs mt-0.5">
            {new Date().toLocaleDateString('en-US', {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
            })}
          </p>
        </div>
        <NotificationCenter />
      </div>

      <div className="grid grid-cols-4 gap-2 mb-6">
        {[
          { label: 'Open', value: stats.open, color: 'text-white' },
          { label: 'Wins', value: stats.wins, color: 'text-green-400' },
          { label: 'Losses', value: stats.losses, color: 'text-red-400' },
          {
            label: 'Win %',
            value: `${stats.winRate}%`,
            color: stats.winRate >= 55 ? 'text-green-400' : 'text-yellow-400',
          },
        ].map(({ label, value, color }) => (
          <div
            key={label}
            className="bg-card border border-border rounded-xl p-3 text-center"
          >
            <p className={clsx('text-lg font-bold', color)}>{value}</p>
            <p className="text-muted text-[10px] mt-0.5">{label}</p>
          </div>
        ))}
      </div>

      <PaperTradingStatus stats={stats} />

      {pendingCandidates > 0 && (
        <button
          type="button"
          onClick={() => navigate('/scanner')}
          className="w-full flex items-center justify-between bg-card border border-red-900/30 rounded-xl px-4 py-3 mb-4 hover:border-red-500 transition-colors"
        >
          <div className="flex items-center gap-2">
            <Cpu size={14} className="text-red-400" />
            <p className="text-white text-sm font-medium">Scanner Candidates</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="bg-red-600 text-white text-xs font-bold px-2 py-0.5 rounded-full">
              {pendingCandidates}
            </span>
            <ChevronRight size={14} className="text-subtle" />
          </div>
        </button>
      )}

      <div className="flex items-center justify-between mb-3">
        <h2 className="text-white text-sm font-semibold">Active Signals</h2>
        <button
          onClick={() => navigate('/log')}
          className="flex items-center gap-1 bg-red-600 hover:bg-red-500
                     text-white text-xs font-medium px-3 py-1.5 rounded-lg
                     transition-colors"
        >
          <Plus size={12} />
          Log Signal
        </button>
      </div>

      <div className="space-y-3">
        {loading ? (
          Array(3)
            .fill(0)
            .map((_, i) => (
              <div
                key={i}
                className="bg-card border border-border rounded-xl p-4 animate-pulse"
              >
                <div className="h-4 bg-zinc-800 rounded w-1/3 mb-2" />
                <div className="h-3 bg-zinc-800 rounded w-2/3" />
              </div>
            ))
        ) : signals.length === 0 ? (
          <div className="bg-card border border-border rounded-xl p-8 text-center">
            <p className="text-subtle text-sm">No active signals</p>
            <p className="text-muted text-xs mt-1">Tap Log Signal to add your first</p>
          </div>
        ) : (
          signals.map((signal) => (
            <SignalCard
              key={signal.id}
              signal={signal}
              daysTo={daysUntil(signal.catalyst_date) ?? 0}
              onClick={() => navigate(`/signal/${signal.id}`)}
            />
          ))
        )}
      </div>
    </div>
  )
}

function SignalCard({ signal, daysTo, onClick }) {
  const urgency =
    daysTo <= 7
      ? 'border-red-900 bg-red-950/20'
      : daysTo <= 14
        ? 'border-yellow-900 bg-yellow-950/10'
        : 'border-border bg-card'

  const confidence = signal.confidence_score ?? 0

  return (
    <button
      onClick={onClick}
      className={clsx(
        'w-full text-left border rounded-xl p-4 transition-all active:scale-[0.98]',
        urgency
      )}
    >
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-white font-bold text-sm">{signal.ticker}</span>
          <span
            className={clsx(
              'text-[10px] font-semibold px-2 py-0.5 rounded-full border',
              signalColor(signal.direction)
            )}
          >
            {directionLabel(signal.direction)}
          </span>
          <span className="text-[10px] text-subtle border border-zinc-800 px-1.5 py-0.5 rounded-full">
            {signal.trade_type === 'paper' ? 'PAPER' : 'REAL'}
          </span>
        </div>
        <div className="text-right">
          <p
            className={clsx(
              'text-xs font-semibold',
              daysTo <= 7
                ? 'text-red-400'
                : daysTo <= 14
                  ? 'text-yellow-400'
                  : 'text-zinc-400'
            )}
          >
            {daysTo}d
          </p>
          <p className="text-[10px] text-muted">to catalyst</p>
        </div>
      </div>

      <p className="text-subtle text-xs mb-2 truncate">
        {signal.drug_name} — {signal.indication}
      </p>

      <div className="flex items-center justify-between">
        <p className="text-zinc-400 text-xs truncate flex-1 mr-4">
          {signal.thesis?.slice(0, 80)}…
        </p>
        <div className="flex gap-0.5">
          {Array(10)
            .fill(0)
            .map((_, i) => (
              <div
                key={i}
                className={clsx(
                  'w-1 h-3 rounded-sm',
                  i < confidence ? 'bg-red-500' : 'bg-zinc-800'
                )}
              />
            ))}
        </div>
      </div>

      <div className="mt-2 pt-2 border-t border-zinc-900 flex items-center justify-between">
        <span className="text-[10px] text-muted">{catalystLabel(signal.catalyst_type)}</span>
        <span className="text-[10px] text-muted">
          {new Date(signal.catalyst_date).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          })}
        </span>
      </div>
    </button>
  )
}
