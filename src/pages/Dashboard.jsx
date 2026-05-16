import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Activity, ChevronRight, Plus, Settings as SettingsIcon, Sparkles, TrendingUp } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { daysUntil } from '../utils/dates'
import { catalystLabel, directionLabel } from '../lib/design'
import NotificationCenter from '../components/NotificationCenter'
import OpenPositions from '../components/OpenPositions'
import OutcomeInbox from '../components/OutcomeInbox'
import TodaysPlaysFeed from '../components/TodaysPlaysFeed'
import TapeDigest from '../components/TapeDigest'
import OnboardingModal, { shouldShowOnboarding } from '../components/OnboardingModal'
import PullToRefreshIndicator from '../components/PullToRefreshIndicator'
import usePullToRefresh from '../hooks/usePullToRefresh'
import clsx from 'clsx'

export default function Dashboard() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [signals, setSignals] = useState([])
  const [stats, setStats] = useState({ wins: 0, losses: 0, open: 0, winRate: 0, total: 0, realizedPnl: 0 })
  const [loading, setLoading] = useState(true)
  const [showOnboarding, setShowOnboarding] = useState(false)

  // First-time-user walkthrough — fires once per user per browser.
  // Defer the check to the next tick after auth resolves so we don't
  // flash the modal during route transitions.
  useEffect(() => {
    if (!user?.id) return
    const id = setTimeout(() => {
      if (shouldShowOnboarding(user.id)) setShowOnboarding(true)
    }, 250)
    return () => clearTimeout(id)
  }, [user?.id])

  useEffect(() => {
    if (!user) return
    fetchDashboardData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  async function fetchDashboardData() {
    setLoading(true)
    const [signalRes, openCountRes, outcomeRes] = await Promise.all([
      // Watch-only signals — the user logged a thesis but didn't enter a trade.
      // Active spread trades are handled by <OpenPositions/> directly; the
      // previous "Live Moves" feed showed both, which read as redundant.
      supabase
        .from('signals')
        .select('*, outcomes(*)')
        .eq('user_id', user.id)
        .eq('status', 'active')
        .eq('direction', 'watch')
        .order('logged_at', { ascending: false })
        .limit(10),
      // Open count for the stats strip. Counts CURRENTLY OPEN POSITIONS,
      // not active signals — those drift apart after a position closes
      // (close-order flips open_positions.status='closed' via the DB
      // trigger, but signals.status stays 'active' until the user logs
      // an outcome). Reading from open_positions matches the source of
      // truth the <OpenPositions/> card directly above the strip uses,
      // so the two surfaces never disagree.
      supabase
        .from('open_positions')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('status', 'open'),
      supabase.from('outcomes').select('thesis_correct, pnl_dollars').eq('user_id', user.id),
    ])

    setSignals(signalRes.data ?? [])

    const outcomes = outcomeRes.data ?? []
    const wins = outcomes.filter((o) => o.thesis_correct).length
    const losses = outcomes.filter((o) => !o.thesis_correct).length
    const total = wins + losses
    // Realized P&L only — summed from logged outcomes. We deliberately
    // do NOT add open/unrealized here: we don't have a reliable live
    // mark for every open position, and a fabricated unrealized number
    // on the headline is exactly the kind of false precision this
    // codebase avoids. Honest = closed trades, what actually settled.
    const realizedPnl = outcomes.reduce(
      (sum, o) => sum + (Number.isFinite(Number(o.pnl_dollars)) ? Number(o.pnl_dollars) : 0),
      0,
    )
    setStats({
      wins,
      losses,
      open: openCountRes.count ?? 0,
      winRate: total > 0 ? Math.round((wins / total) * 100) : 0,
      total,
      realizedPnl,
    })
    setLoading(false)
  }

  const today = new Date()
  const dateStr = today.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })

  const isFirstRun = !loading && stats.total === 0 && stats.open === 0

  // Pull-to-refresh re-runs the same fetch as initial load, so the
  // user can drag-down to pick up a freshly-promoted candidate or a
  // new outcome logged from another tab.
  const { pullDistance, refreshing, threshold } = usePullToRefresh(
    () => user && fetchDashboardData(),
    { disabled: !user },
  )

  // The Tape uses a two-column layout on desktop: dealer-positioning
  // surfaces (LiveGexStrip, SuggestedPlays, Live Moves feed) on the left
  // where the eye lands, and personal-state surfaces (OpenPositions,
  // PaperTradingStatus) on the right rail. Mobile collapses to a single
  // column ordered for trader-priority: GEX → Positions → Plays → Moves.
  return (
    <div className="px-5 lg:px-8 pt-7 pb-6 mx-auto lg:max-w-7xl w-full">
      <PullToRefreshIndicator
        pullDistance={pullDistance}
        refreshing={refreshing}
        threshold={threshold}
      />
      {showOnboarding && (
        <OnboardingModal
          userId={user?.id}
          onClose={() => setShowOnboarding(false)}
        />
      )}
      {/* Compact header — date eyebrow + bell + settings. The big
          "Cash Moves" wordmark was eating prime above-the-fold real
          estate; the brand identity is already established in the
          nav, so the Tape can spend that space on actual market
          information. */}
      <header className="flex items-center justify-between mb-4">
        <p className="eyebrow">{dateStr} · The Tape</p>
        <div className="flex items-center gap-2">
          <NotificationCenter />
          <button
            type="button"
            onClick={() => navigate('/settings')}
            aria-label="Settings"
            className="lg:hidden tap-spring relative w-9 h-9 bg-card border border-border rounded-xl flex items-center justify-center text-muted hover:text-fg transition-colors"
          >
            <SettingsIcon size={16} />
          </button>
        </div>
      </header>

      {/* "Since you were away" delta digest. Renders nothing on a
          first visit or when there are no deltas, so it never adds
          clutter — only appears when there's something that changed
          while the user was gone. */}
      <TapeDigest />

      {/* Today's Plays is the primary hero of the Tape now. The
          per-ticker Suggested Plays card moved to /markets (Pulse)
          where users go specifically to explore one ticker — splitting
          the two surfaces here was dividing attention. The cross-
          ticker feed is the daily habit hook. */}
      <section className="mb-5">
        <TodaysPlaysFeed />
      </section>

      {/* Two-column layout for personal state + Live Moves below the
          shared market hero. Open Positions on the right rail desktop,
          stacked below Plays on mobile. */}
      <div className="flex flex-col lg:grid lg:grid-cols-[2fr_1fr] lg:gap-x-6 lg:gap-y-5">
        <div className="order-2 lg:col-start-2 lg:row-start-1 mb-5 lg:mb-0">
          <OutcomeInbox />
          <OpenPositions />
        </div>

        <div className="order-1 lg:col-start-1 lg:row-start-1 min-w-0">
          {isFirstRun && <OnboardingCard navigate={navigate} />}

          <button
            onClick={() => navigate('/log')}
            className="btn-primary w-full inline-flex items-center justify-center gap-2 text-sm font-semibold px-4 py-3 rounded-xl mb-4"
          >
            <Plus size={15} strokeWidth={2.5} />
            Log a Move
          </button>

          {/* Watching — only signals where direction='watch' (logged a
              thesis but didn't enter a trade). Active spread trades
              live in <OpenPositions/> on the right rail; merging the
              two surfaces eliminated the prior redundancy where
              every active trade appeared in both sections.
              Renders nothing when empty so the section doesn't
              clutter the Tape for users who only trade. */}
          {!loading && signals.length > 0 && (
            <>
              <div className="flex items-end justify-between mb-3">
                <div>
                  <p className="eyebrow">Theses without trades</p>
                  <h2 className="font-display text-xl text-fg mt-0.5">Watching</h2>
                </div>
              </div>
              <div className="space-y-2.5">
                {signals.map((signal) => (
                  <SignalCard
                    key={signal.id}
                    signal={signal}
                    onClick={() => navigate(`/signal/${signal.id}`)}
                  />
                ))}
              </div>
            </>
          )}
        </div>

      </div>

      {/* Record summary moved to the bottom — your trading record over
          time is interesting context, but it's not what drives a
          decision the moment you open the app. Keeping it visible
          but de-emphasized below the action surfaces. */}
      <section className="surface rounded-xl px-2 py-2 mt-6">
        {/* Realized P&L headline — the single most decision-relevant
            number, given a 1.5-R/R system where win rate alone is
            misleading. Realized only (see fetch comment); shown when
            there's at least one closed trade, otherwise the strip
            stays as-is so a new account isn't headlined by "$0". */}
        {stats.total > 0 && (
          <div className="flex items-baseline justify-between px-3 pt-1.5 pb-2 mb-1 border-b border-border/70">
            <span className="eyebrow text-[10px]">Realized P&amp;L · {stats.total} closed</span>
            <span
              className={clsx(
                'font-display text-xl leading-none num-tab',
                stats.realizedPnl > 0
                  ? 'text-green-400'
                  : stats.realizedPnl < 0
                    ? 'text-[#f25068]'
                    : 'text-fg',
              )}
            >
              {stats.realizedPnl >= 0 ? '+' : '−'}$
              {Math.abs(Math.round(stats.realizedPnl)).toLocaleString()}
            </span>
          </div>
        )}
        <div className="grid grid-cols-4">
          <Stat label="Open" value={stats.open} />
          <Stat label="Wins" value={stats.wins} tone="green" divider />
          <Stat label="Losses" value={stats.losses} tone="red" divider />
          <Stat
            label="Win Rate"
            value={`${stats.winRate}%`}
            // Breakeven for the system's R/R ≥ 1.5 discipline is
            // ~40% (1 / (1 + 1.5)). A 48% win rate is *profitable*,
            // so the old ≥55 green / else amber thresholds mislabeled
            // winning records as warnings. Color off the real
            // breakeven: comfortably profitable ≥ 45, around
            // breakeven 38–45, losing < 38, no data 0.
            tone={
              stats.total === 0
                ? 'neutral'
                : stats.winRate >= 45
                  ? 'green'
                  : stats.winRate >= 38
                    ? 'amber'
                    : 'red'
            }
            divider
          />
        </div>
      </section>
    </div>
  )
}

function OnboardingCard({ navigate }) {
  const steps = [
    {
      icon: Activity,
      title: 'Read the tape',
      sub: 'Spot, Flip, and Wall for SPY/QQQ/NVDA and the rest of the watched universe — live during RTH.',
      cta: 'Markets',
      onClick: () => navigate('/markets'),
    },
    {
      icon: Sparkles,
      title: 'Get a suggested play',
      sub: 'Cash Moves reads dealer positioning and proposes spread setups that fit your account-size rules.',
      cta: 'Generate',
      onClick: () => navigate('/markets'),
    },
    {
      icon: Plus,
      title: 'Log a Move',
      sub: 'Lock the thesis with an immutable SHA-256 hash so it counts toward your public record.',
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
                <span className="text-fg text-sm font-semibold">
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
      <span className="eyebrow mt-1.5 text-[10px]">{label}</span>
    </div>
  )
}

function SignalCard({ signal, onClick }) {
  // Single unified card for every Move regardless of signal_source. The
  // urgency clock falls back through the dates that might be set:
  // expiry_date wins because it's the trade's actual deadline; catalyst_date
  // is the backup for biotech rows that pre-date the GEX pivot. Source
  // label and source-specific fields (drug/indication, catalyst type) are
  // shown on the detail page, not here — keeps the card scan-readable.
  const clockDate = signal.expiry_date || signal.catalyst_date
  const clockLabel = signal.expiry_date ? 'to expiry' : 'to catalyst'
  const daysTo = daysUntil(clockDate) ?? 0
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

  const sourceLabel =
    signal.signal_source === 'gex_flow'
      ? 'GEX Flow'
      : catalystLabel(signal.catalyst_type) || 'Catalyst'
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

      <div className="flex items-start justify-between mb-2.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono-tab text-fg font-semibold text-sm tracking-tight">
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
          <span className="text-[10px] tracking-[0.16em] text-muted border border-border/70 px-1.5 py-0.5 rounded-md uppercase">
            {signal.trade_type === 'paper' ? 'Paper' : 'Real'}
          </span>
        </div>
        {clockDate && (
          <div className="text-right shrink-0 ml-2">
            <p
              className="font-display num-tab text-lg leading-none"
              style={{ color: accent.color }}
            >
              {daysTo}
              <span className="text-[10px] font-sans ml-0.5 opacity-70">d</span>
            </p>
            <p className="eyebrow text-[10px] mt-1">{clockLabel}</p>
          </div>
        )}
      </div>

      {/* Thesis is the only body text — same for every Move type. */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-subtle text-xs line-clamp-1 flex-1 italic font-display">
          {signal.thesis?.slice(0, 90)}{signal.thesis?.length > 90 ? '…' : ''}
        </p>
        <ConfidenceMeter level={confidence} />
      </div>

      <div className="hairline mt-3 mb-2.5 opacity-60" />
      <div className="flex items-center justify-between">
        <span className="eyebrow text-[10px]">{sourceLabel}</span>
        {clockDate && (
          <span className="font-mono-tab text-[10px] text-muted">
            {new Date(clockDate).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })}
          </span>
        )}
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
