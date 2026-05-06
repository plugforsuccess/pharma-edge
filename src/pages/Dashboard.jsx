import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Activity, ChevronRight, Cpu, Eye, Plus, Sparkles, TrendingUp } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { daysUntil } from '../utils/dates'
import { catalystLabel, directionLabel } from '../lib/design'
import NotificationCenter from '../components/NotificationCenter'
import OpenPositions from '../components/OpenPositions'
import PaperTradingStatus from '../components/PaperTradingStatus'
import clsx from 'clsx'

export default function Dashboard() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [signals, setSignals] = useState([])
  const [stats, setStats] = useState({ wins: 0, losses: 0, open: 0, winRate: 0, total: 0 })
  const [pendingCandidates, setPendingCandidates] = useState(0)
  const [watchlistCandidates, setWatchlistCandidates] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user) return
    fetchDashboardData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  async function fetchDashboardData() {
    setLoading(true)
    const [signalRes, openCountRes, outcomeRes, candidateCountRes, watchlistCountRes] =
      await Promise.all([
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
          .is('requested_by', null)
          .eq('reviewed', false)
          .eq('dismissed', false),
        supabase
          .from('scanner_candidates')
          .select('id', { count: 'exact', head: true })
          .eq('requested_by', user.id)
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
    setWatchlistCandidates(watchlistCountRes.count ?? 0)

    setLoading(false)
  }

  const today = new Date()
  const dateStr = today.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })

  return (
    <div className="px-5 lg:px-6 pt-7 pb-6 mx-auto lg:max-w-6xl w-full">
      {/* Wordmark — gold "Cash" + white "Moves". Italic dropped with
          the Space Grotesk swap (it has no true italic; browser-
          synthesized obliques on a wordmark read as "almost" instead
          of intentional). Weight contrast carries the rhythm. */}
      <header className="flex items-start justify-between mb-7">
        <div>
          <p className="eyebrow">{dateStr} · The Tape</p>
          <h1 className="font-display text-[2rem] leading-[1.05] mt-1.5 tracking-tight">
            <span className="brand-text font-bold">Cash</span>{' '}
            <span className="text-fg font-light">Moves</span>
          </h1>
        </div>
        <NotificationCenter />
      </header>

      {/* Stat strip — editorial, no boxes */}
      <section className="surface rounded-2xl px-2 py-3 mb-5">
        <div className="grid grid-cols-4">
          <Stat label="Open" value={stats.open} />
          <Stat label="Wins" value={stats.wins} tone="green" divider />
          <Stat label="Losses" value={stats.losses} tone="red" divider />
          <Stat
            label="Win Rate"
            value={`${stats.winRate}%`}
            tone={stats.winRate >= 55 ? 'green' : stats.winRate > 0 ? 'amber' : 'neutral'}
            divider
          />
        </div>
      </section>

      <PaperTradingStatus stats={stats} />

      {/* First-run guidance — fades out the moment the user has any
          surface they could be working from (signal, scanner pick, or
          a watchlist hit). Avoids the "what do I do next" beat that
          a new login otherwise lands on. */}
      {!loading &&
        stats.total === 0 &&
        stats.open === 0 &&
        pendingCandidates === 0 &&
        watchlistCandidates === 0 && <OnboardingCard navigate={navigate} />}

      <OpenPositions />

      {/* Queue cards */}
      <div className="space-y-2 mb-5">
        {watchlistCandidates > 0 && (
          <QueueCard
            icon={Eye}
            tone="amber"
            title="Watchlist Activity"
            sub="New filings on your tracked tickers"
            count={watchlistCandidates}
            onClick={() => navigate('/scanner')}
          />
        )}
        {pendingCandidates > 0 && (
          <QueueCard
            icon={Cpu}
            tone="crimson"
            title="Scanner Candidates"
            sub="Top broad-scan picks from this morning"
            count={pendingCandidates}
            onClick={() => navigate('/scanner')}
          />
        )}
      </div>

      {/* Moves header — naming convention: a "move" is one signal /
          alert; plural "Moves" becomes the cross-page noun. */}
      <div className="flex items-end justify-between mb-3">
        <div>
          <p className="eyebrow">Live Theses</p>
          <h2 className="font-display text-xl text-fg mt-0.5">Live Moves</h2>
        </div>
        <button
          onClick={() => navigate('/log')}
          className="btn-primary inline-flex items-center gap-1.5 text-xs font-semibold px-3.5 py-2 rounded-lg"
        >
          <Plus size={13} strokeWidth={2.5} />
          Log Move
        </button>
      </div>

      <div className="space-y-2.5">
        {loading ? (
          Array(3)
            .fill(0)
            .map((_, i) => (
              <div
                key={i}
                className="surface rounded-2xl p-4 animate-pulse"
              >
                <div className="h-4 bg-white/5 rounded w-1/3 mb-2" />
                <div className="h-3 bg-white/5 rounded w-2/3" />
              </div>
            ))
        ) : signals.length === 0 ? (
          <div className="surface rounded-2xl p-10 text-center">
            <TrendingUp
              size={28}
              strokeWidth={1.5}
              className="mx-auto mb-3 text-muted"
            />
            <p className="font-display text-lg text-fg">No moves on the tape</p>
            <p className="text-subtle text-xs mt-1">
              Log your first thesis to start the public record.
            </p>
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

function OnboardingCard({ navigate }) {
  const steps = [
    {
      icon: Activity,
      title: 'Open the Markets tab',
      sub: 'See the live GEX matrix for SPY, QQQ, AAPL, and ~50 other names.',
      cta: 'Markets',
      onClick: () => navigate('/markets'),
    },
    {
      icon: Sparkles,
      title: 'Generate Suggested Plays',
      sub: 'Claude reads the matrix and proposes 0–3 spread setups that fit your account.',
      cta: 'Generate',
      onClick: () => navigate('/markets'),
    },
    {
      icon: Plus,
      title: 'Log a signal',
      sub: 'Lock the thesis with an immutable SHA-256 hash so it counts toward your record.',
      cta: 'Log',
      onClick: () => navigate('/log'),
    },
  ]
  return (
    <div className="surface rounded-2xl p-4 mb-5 space-y-3 border border-amber-400/20">
      <div className="flex items-center gap-2">
        <span className="eyebrow text-[#f4cf8e]">Start Here</span>
      </div>
      <p className="text-fg text-sm font-display">
        Welcome. Here's the loop.
      </p>
      <div className="space-y-2">
        {steps.map((step, i) => (
          <button
            key={i}
            onClick={step.onClick}
            className="w-full flex items-start gap-3 text-left bg-bg-elev/40 hover:bg-bg-elev rounded-xl p-3 transition"
          >
            <div className="w-7 h-7 shrink-0 rounded-lg bg-amber-400/10 flex items-center justify-center text-amber-400">
              <step.icon size={14} strokeWidth={2} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="text-fg text-[13px] font-semibold">
                  {i + 1}. {step.title}
                </span>
              </div>
              <p className="text-subtle text-[11px] leading-relaxed mt-0.5">
                {step.sub}
              </p>
            </div>
            <ChevronRight size={14} className="text-muted shrink-0 mt-1.5" />
          </button>
        ))}
      </div>
    </div>
  )
}

function Stat({ label, value, tone = 'neutral', divider }) {
  const toneClass = {
    neutral: 'text-fg',
    green: 'text-green-400',
    red: 'text-[#f25068]',
    amber: 'text-[#f4cf8e]',
  }[tone]

  return (
    <div
      className={clsx(
        'flex flex-col items-center justify-center py-1.5',
        divider && 'border-l border-border/70',
      )}
    >
      <span className={clsx('font-display text-2xl leading-none num-tab', toneClass)}>
        {value}
      </span>
      <span className="eyebrow mt-1.5 text-[9px]">{label}</span>
    </div>
  )
}

function QueueCard({ icon: Icon, tone, title, sub, count, onClick }) {
  const palette =
    tone === 'amber'
      ? {
          icon: '#f4cf8e',
          ring: 'rgba(232,181,88,0.25)',
          badge:
            'bg-[#e8b558] text-[#1a1208] shadow-[0_0_18px_-4px_rgba(232,181,88,0.6)]',
        }
      : {
          icon: '#f25068',
          ring: 'rgba(224,52,76,0.25)',
          badge:
            'bg-[#e0344c] text-white shadow-[0_0_18px_-4px_rgba(224,52,76,0.55)]',
        }

  return (
    <button
      type="button"
      onClick={onClick}
      className="group surface surface-hover w-full flex items-center justify-between rounded-2xl px-4 py-3.5 text-left"
      style={{ borderColor: palette.ring }}
    >
      <div className="flex items-center gap-3">
        <div
          className="w-9 h-9 rounded-xl flex items-center justify-center"
          style={{ background: 'rgba(255,255,255,0.03)' }}
        >
          <Icon size={16} style={{ color: palette.icon }} strokeWidth={2} />
        </div>
        <div>
          <p className="text-fg text-sm font-semibold tracking-tight">{title}</p>
          <p className="text-muted text-[11px] mt-0.5">{sub}</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span
          className={clsx(
            'text-[11px] font-bold px-2 py-0.5 rounded-full num-tab',
            palette.badge,
          )}
        >
          {count}
        </span>
        <ChevronRight
          size={15}
          className="text-muted group-hover:text-subtle transition-colors"
        />
      </div>
    </button>
  )
}

function SignalCard({ signal, daysTo, onClick }) {
  const isUrgent = daysTo <= 7
  const isSoon = daysTo > 7 && daysTo <= 14

  const accent = isUrgent
    ? { color: '#f25068', glow: 'rgba(224,52,76,0.18)' }
    : isSoon
      ? { color: '#f4cf8e', glow: 'rgba(232,181,88,0.14)' }
      : { color: '#8b8ba6', glow: 'transparent' }

  const isPut = signal.direction === 'long_put'
  const dirPill = isPut
    ? 'text-[#f25068] bg-[#e0344c]/10 border-[#e0344c]/35'
    : signal.direction === 'long_call'
      ? 'text-green-400 bg-green-500/10 border-green-500/35'
      : 'text-subtle bg-white/[0.03] border-border'

  const confidence = signal.confidence_score ?? 0

  return (
    <button
      onClick={onClick}
      className="group relative surface surface-hover w-full text-left rounded-2xl p-4 active:scale-[0.99] transition-transform overflow-hidden"
      style={{
        boxShadow: `inset 0 1px 0 rgba(255,255,255,0.03), 0 0 0 1px transparent, 0 8px 30px -16px ${accent.glow}`,
      }}
    >
      {/* Left accent rail */}
      <span
        aria-hidden
        className="absolute left-0 top-3 bottom-3 w-[2px] rounded-r-full"
        style={{
          background: `linear-gradient(180deg, transparent, ${accent.color}, transparent)`,
          opacity: 0.7,
        }}
      />

      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono-tab text-fg font-semibold text-[15px] tracking-tight">
            {signal.ticker}
          </span>
          <span
            className={clsx(
              'text-[10px] font-bold tracking-wider px-1.5 py-0.5 rounded-md border',
              dirPill,
            )}
          >
            {directionLabel(signal.direction)}
          </span>
          <span className="text-[9px] tracking-[0.16em] text-muted border border-border/70 px-1.5 py-0.5 rounded-md uppercase">
            {signal.trade_type === 'paper' ? 'Paper' : 'Real'}
          </span>
        </div>
        <div className="text-right shrink-0 ml-2">
          <p
            className="font-display num-tab text-lg leading-none"
            style={{ color: accent.color }}
          >
            {daysTo}
            <span className="text-[10px] font-sans ml-0.5 opacity-70">d</span>
          </p>
          <p className="eyebrow text-[8px] mt-1">to catalyst</p>
        </div>
      </div>

      <p className="text-subtle text-[12px] mb-2.5 truncate">
        <span className="text-fg/90 font-medium">{signal.drug_name}</span>
        <span className="text-muted"> · </span>
        {signal.indication}
      </p>

      <div className="flex items-center justify-between gap-3">
        <p className="text-subtle text-[12px] line-clamp-1 flex-1 italic font-display">
          {signal.thesis?.slice(0, 90)}…
        </p>
        <ConfidenceMeter level={confidence} />
      </div>

      <div className="hairline mt-3 mb-2.5 opacity-60" />
      <div className="flex items-center justify-between">
        <span className="eyebrow text-[9px]">{catalystLabel(signal.catalyst_type)}</span>
        <span className="font-mono-tab text-[10px] text-muted">
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

function ConfidenceMeter({ level }) {
  return (
    <div className="flex gap-[2px] items-end shrink-0" aria-label={`Confidence ${level}/10`}>
      {Array.from({ length: 10 }).map((_, i) => {
        const filled = i < level
        const heightClass = i < 3 ? 'h-2' : i < 6 ? 'h-2.5' : i < 8 ? 'h-3' : 'h-3.5'
        return (
          <div
            key={i}
            className={clsx('w-[3px] rounded-sm transition-colors', heightClass)}
            style={{
              background: filled
                ? i < 4
                  ? '#b88830'
                  : i < 7
                    ? '#e8b558'
                    : '#f4cf8e'
                : 'rgba(255,255,255,0.06)',
            }}
          />
        )
      })}
    </div>
  )
}
