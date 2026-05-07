import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Check, ExternalLink, Share2, Shield } from 'lucide-react'
import { supabase } from '../lib/supabase'
import Sparkline from '../components/Sparkline'
import Spinner from '../components/Spinner'
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

      {stats && stats.resolved > 0 && (
        <HeroStatsCard stats={stats} profile={profile} />
      )}

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
      avgPredictedPop: null,
      popN: 0,
      calibrationDelta: null,
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

  // Average predicted POP across resolved signals where the user
  // hash-locked an entry_pop_bp at signal creation. v1 (legacy)
  // signals have null and are excluded — we don't fabricate a
  // probability for unsigned predictions. The calibrationDelta
  // pairs predicted with actual so viewers see whether the trader
  // is well-calibrated, over-confident, or under-confident.
  const withPop = resolved.filter((s) => s.entry_pop_bp != null)
  const avgPredictedPopBp = withPop.length
    ? withPop.reduce((sum, s) => sum + Number(s.entry_pop_bp), 0) / withPop.length
    : null
  const avgPredictedPop = avgPredictedPopBp != null
    ? Math.round(avgPredictedPopBp / 100)
    : null
  const actualHitRateOnPop = withPop.length
    ? Math.round((withPop.filter((s) => s.thesis_correct).length / withPop.length) * 100)
    : null
  const calibrationDelta =
    avgPredictedPop != null && actualHitRateOnPop != null
      ? actualHitRateOnPop - avgPredictedPop
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
    avgPredictedPop,
    popN: withPop.length,
    calibrationDelta,
  }
}

// Hero stats panel for the public profile. Headline metric is the
// calibration line: "Predicted X% / Actual Y% (n=Z)" — that's the
// number nobody else in the category can show because nobody else
// hash-locks the prediction at entry. Everything else (win rate,
// cumulative %) is supporting context.
function HeroStatsCard({ stats, profile }) {
  const [shareState, setShareState] = useState('idle') // idle | copied | error

  async function handleShare() {
    const url = typeof window !== 'undefined' ? window.location.href : ''
    const title = profile?.display_name
      ? `${profile.display_name} — Cash Moves track record`
      : 'Cash Moves track record'
    const text =
      stats.calibrationDelta != null
        ? `Predicted ${stats.avgPredictedPop}% / Actual ${stats.avgPredictedPop + stats.calibrationDelta}% over ${stats.popN} hash-anchored trades. Verifiable on Cash Moves.`
        : `${stats.winRate}% hit rate over ${stats.resolved} hash-anchored trades. Verifiable on Cash Moves.`

    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share({ title, text, url })
        return
      } catch (e) {
        if (e?.name === 'AbortError') return
      }
    }
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url)
        setShareState('copied')
        setTimeout(() => setShareState('idle'), 2000)
      } else {
        setShareState('error')
        setTimeout(() => setShareState('idle'), 2500)
      }
    } catch {
      setShareState('error')
      setTimeout(() => setShareState('idle'), 2500)
    }
  }

  const winRateTone =
    stats.winRate >= 60 ? 'text-green-400' : stats.winRate >= 50 ? 'text-yellow-400' : 'text-red-400'
  const calibrationTone =
    stats.calibrationDelta == null
      ? 'text-muted'
      : Math.abs(stats.calibrationDelta) <= 5
        ? 'text-green-400'
        : Math.abs(stats.calibrationDelta) <= 15
          ? 'text-yellow-400'
          : 'text-red-400'
  const cumTone = stats.cumPnl >= 0 ? 'text-green-400' : 'text-red-400'
  const realMixLabel =
    stats.real > 0 && stats.paper > 0
      ? `${stats.real} real · ${stats.paper} paper`
      : stats.real > 0
        ? `${stats.real} real`
        : stats.paper > 0
          ? `${stats.paper} paper`
          : ''
  return (
    <div className="bg-card border border-border rounded-xl p-4 mb-3 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-muted text-[10px] uppercase tracking-wider">
          Track record
        </p>
        <button
          type="button"
          onClick={handleShare}
          className={clsx(
            'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold transition',
            shareState === 'copied'
              ? 'border-green-700 bg-green-950/40 text-green-400'
              : shareState === 'error'
                ? 'border-red-700 bg-red-950/40 text-red-400'
                : 'border-amber-400/40 bg-amber-400/10 text-amber-400 hover:bg-amber-400/20',
          )}
          aria-label="Share this trader's track record"
        >
          {shareState === 'copied' ? (
            <>
              <Check size={12} />
              Copied
            </>
          ) : shareState === 'error' ? (
            <>Copy failed</>
          ) : (
            <>
              <Share2 size={12} />
              Share
            </>
          )}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Stat
          label="Hit rate"
          value={`${stats.winRate}%`}
          sub={`${stats.resolved} resolved`}
          tone={winRateTone}
        />
        <Stat
          label="Cumulative"
          value={`${stats.cumPnl >= 0 ? '+' : ''}${stats.cumPnl.toFixed(0)}%`}
          sub={stats.avgPnl != null ? `avg ${stats.avgPnl >= 0 ? '+' : ''}${stats.avgPnl}%/trade` : '—'}
          tone={cumTone}
        />
      </div>

      {/* Calibration: the line that's unique to Cash Moves' record.
          Predicted POP came from the user at hash time; actual hit
          rate comes from the same set of resolved signals. Δ tells
          viewers whether the trader is well-calibrated, over-
          confident (positive avg POP, lower actual hit rate), or
          under-confident (lower avg POP, higher actual hit rate). */}
      {stats.popN > 0 ? (
        <div className="bg-bg-elev/40 border border-border rounded-lg p-3">
          <div className="flex items-baseline justify-between mb-1">
            <p className="text-[10px] uppercase tracking-wider text-amber-400 font-semibold">
              Calibration · n={stats.popN}
            </p>
            {stats.calibrationDelta != null && (
              <p className={clsx('text-xs font-mono-tab font-semibold', calibrationTone)}>
                Δ {stats.calibrationDelta >= 0 ? '+' : ''}
                {stats.calibrationDelta} pts
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3 text-center">
            <div>
              <p className="text-white font-bold text-lg font-mono-tab">
                {stats.avgPredictedPop}%
              </p>
              <p className="text-muted text-[10px]">Avg predicted</p>
            </div>
            <div>
              <p className="text-white font-bold text-lg font-mono-tab">
                {stats.calibrationDelta != null
                  ? stats.avgPredictedPop + stats.calibrationDelta
                  : '—'}
                %
              </p>
              <p className="text-muted text-[10px]">Actual hit rate</p>
            </div>
          </div>
          {stats.popN < 30 && (
            <p className="text-[10px] text-muted mt-2 leading-relaxed">
              Δ stabilises around n=30. Below that the actual rate has
              too much sample noise to read as a calibration signal.
            </p>
          )}
        </div>
      ) : (
        <p className="text-[10px] text-muted leading-relaxed">
          Calibration tracking requires hash-locked entry POP on resolved
          signals. Older v1 signals are excluded — calibration becomes
          visible as new signals resolve.
        </p>
      )}

      {realMixLabel && (
        <p className="text-[10px] text-muted text-center">
          {realMixLabel}
        </p>
      )}
    </div>
  )
}

function Stat({ label, value, sub, tone }) {
  return (
    <div className="bg-bg-elev/40 border border-border rounded-lg p-3">
      <p className="text-muted text-[10px] uppercase tracking-wider">{label}</p>
      <p className={clsx('text-2xl font-bold font-mono-tab mt-0.5', tone || 'text-white')}>
        {value}
      </p>
      {sub && <p className="text-muted text-[10px] mt-0.5">{sub}</p>}
    </div>
  )
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
          <Shield size={10} className="text-green-400 flex-shrink-0" />
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
      <Spinner size="lg" tone="amber" label="Loading public record" />
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
