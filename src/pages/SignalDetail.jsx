import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, ExternalLink, AlertTriangle } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { daysUntil } from '../utils/dates'
import {
  signalColor,
  catalystLabel,
  directionLabelLong,
  formatMarketCap,
} from '../lib/design'
import LogOutcomeModal from '../components/LogOutcomeModal'
import StopLossCheck from '../components/StopLossCheck'
import StrikePriceCalculator from '../components/StrikePriceCalculator'
import clsx from 'clsx'

const SIGNAL_TYPES = [
  { key: 'enrollment_signal', label: 'Enrollment Velocity Drop' },
  { key: 'fda_precedent_signal', label: 'FDA Precedent Mismatch' },
  { key: 'protocol_amendment_signal', label: 'Protocol Amendment' },
  { key: 'insider_selling_signal', label: 'Insider Selling' },
  { key: 'cash_runway_signal', label: 'Cash Runway Risk' },
]

export default function SignalDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user, profile } = useAuth()
  const [signal, setSignal] = useState(null)
  const [loading, setLoading] = useState(true)
  const [logOpen, setLogOpen] = useState(false)

  useEffect(() => {
    if (!user) return
    fetchSignal()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, user?.id])

  async function fetchSignal() {
    setLoading(true)
    const { data } = await supabase
      .from('signals')
      .select('*, outcomes(*)')
      .eq('id', id)
      .eq('user_id', user.id)
      .maybeSingle()
    setSignal(data ?? null)
    setLoading(false)
  }

  if (loading) return <LoadingState />
  if (!signal) return <NotFound onBack={() => navigate('/')} />

  const daysTo = daysUntil(signal.catalyst_date) ?? 0
  const outcome = signal.outcomes?.[0] ?? null

  return (
    <div className="px-4 pt-6 pb-8">
      <div className="flex items-center gap-3 mb-6">
        <button
          aria-label="Back"
          onClick={() => navigate(-1)}
          className="w-9 h-9 bg-card border border-border rounded-xl
                     flex items-center justify-center text-zinc-400 hover:text-white"
        >
          <ArrowLeft size={16} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-white font-bold text-lg">{signal.ticker}</h1>
            <span
              className={clsx(
                'text-[10px] font-bold px-2 py-0.5 rounded-full border',
                signalColor(signal.direction)
              )}
            >
              {directionLabelLong(signal.direction)}
            </span>
          </div>
          <p className="text-subtle text-xs truncate">{signal.company_name}</p>
        </div>
        <div className="text-right">
          <p
            className={clsx(
              'text-sm font-bold',
              daysTo <= 7
                ? 'text-red-400'
                : daysTo <= 14
                  ? 'text-yellow-400'
                  : 'text-zinc-400'
            )}
          >
            {daysTo}d
          </p>
          <p className="text-[10px] text-muted">remaining</p>
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl p-4 mb-4">
        <div className="grid grid-cols-2 gap-3">
          <InfoItem label="Drug" value={signal.drug_name || '—'} />
          <InfoItem label="Indication" value={signal.indication || '—'} />
          <InfoItem label="Catalyst" value={catalystLabel(signal.catalyst_type)} />
          <InfoItem
            label="Date"
            value={new Date(signal.catalyst_date).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })}
          />
          <InfoItem label="Market Cap" value={formatMarketCap(signal.market_cap)} />
          <InfoItem
            label="Price at Signal"
            value={signal.stock_price_at_signal != null ? `$${signal.stock_price_at_signal}` : '—'}
          />
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl p-4 mb-4">
        <h3 className="text-subtle text-xs font-semibold uppercase tracking-wider mb-3">
          Thesis
        </h3>
        <p className="text-zinc-300 text-sm leading-relaxed whitespace-pre-wrap">
          {signal.thesis}
        </p>

        {signal.claude_analysis && (
          <>
            <div className="border-t border-border my-3" />
            <p className="text-subtle text-xs font-semibold uppercase tracking-wider mb-2">
              Claude Analysis
            </p>
            <p className="text-zinc-400 text-sm leading-relaxed whitespace-pre-wrap">
              {signal.claude_analysis}
            </p>
          </>
        )}
      </div>

      <div className="bg-card border border-border rounded-xl p-4 mb-4">
        <h3 className="text-subtle text-xs font-semibold uppercase tracking-wider mb-3">
          Signal Strength
        </h3>
        <div className="space-y-3">
          {SIGNAL_TYPES.map(({ key, label }) =>
            signal[key] > 0 ? <SignalBar key={key} label={label} score={signal[key]} /> : null
          )}
          {signal.confidence_score != null && (
            <div className="border-t border-border pt-3">
              <SignalBar
                label="Overall Confidence"
                score={signal.confidence_score}
                highlight
              />
            </div>
          )}
        </div>
      </div>

      {signal.market_implied_probability != null && signal.your_probability != null && (
        <div className="bg-card border border-border rounded-xl p-4 mb-4">
          <h3 className="text-subtle text-xs font-semibold uppercase tracking-wider mb-3">
            Edge Analysis
          </h3>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <p className="text-white font-bold text-lg">{signal.market_implied_probability}%</p>
              <p className="text-muted text-[10px]">Market Implied</p>
            </div>
            <div>
              <p className="text-red-400 font-bold text-lg">{signal.edge_score}pt</p>
              <p className="text-muted text-[10px]">Your Edge</p>
            </div>
            <div>
              <p className="text-white font-bold text-lg">{signal.your_probability}%</p>
              <p className="text-muted text-[10px]">Your Read</p>
            </div>
          </div>
        </div>
      )}

      <div className="bg-card border border-border rounded-xl p-4 mb-4">
        <h3 className="text-subtle text-xs font-semibold uppercase tracking-wider mb-3">
          Trade Details
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <InfoItem
            label="Structure"
            value={signal.structure?.replace(/_/g, ' ').toUpperCase() || '—'}
          />
          <InfoItem label="Type" value={signal.trade_type?.toUpperCase() || '—'} />
          <InfoItem
            label="Entry Price"
            value={signal.entry_price != null ? `$${signal.entry_price}` : '—'}
          />
          <InfoItem
            label="Expiry"
            value={signal.expiry_date ? new Date(signal.expiry_date).toLocaleDateString() : '—'}
          />
        </div>
      </div>

      {signal.status === 'active' && signal.direction !== 'watch' && (
        <StrikePriceCalculator
          direction={signal.direction}
          accountSize={profile?.account_size}
          initialStockPrice={signal.stock_price_at_signal}
          catalystDate={signal.catalyst_date}
        />
      )}

      {signal.source_urls?.length > 0 && (
        <div className="bg-card border border-border rounded-xl p-4 mb-4">
          <h3 className="text-subtle text-xs font-semibold uppercase tracking-wider mb-3">
            Source Documents
          </h3>
          <div className="space-y-2">
            {signal.source_urls.map((url, i) => (
              <a
                key={i}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-red-400 text-sm hover:text-red-300"
              >
                <ExternalLink size={12} />
                <span className="truncate">{url}</span>
              </a>
            ))}
          </div>
        </div>
      )}

      <div className="bg-red-950/20 border border-red-900/40 rounded-xl p-4 mb-4">
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle size={14} className="text-red-400" />
          <h3 className="text-red-400 text-xs font-semibold uppercase tracking-wider">
            Risk Rules — This Trade
          </h3>
        </div>
        <div className="space-y-2 text-xs text-zinc-400">
          <p>
            • Stop loss at <span className="text-white">-50%</span> option value
          </p>
          <p>• Exit if thesis invalidated by new data</p>
          <p>
            • Take 50% off at <span className="text-white">+100%</span>
          </p>
          <p>
            • Take 75% off at <span className="text-white">+200%</span>
          </p>
          <p>• Consider exit day before catalyst</p>
        </div>
      </div>

      {signal.signal_hash && (
        <div className="bg-card border border-border rounded-xl p-3 mb-4 space-y-1">
          <p className="text-muted text-[10px] font-mono break-all">
            ✓ Hash: {signal.signal_hash}
          </p>
          {signal.github_commit_sha && (
            <p className="text-muted text-[10px] font-mono break-all">
              ⚓ Anchored: {signal.github_commit_sha}
            </p>
          )}
        </div>
      )}

      {signal.status === 'active' && signal.direction !== 'watch' && (
        <StopLossCheck signal={signal} />
      )}

      {!outcome && signal.status === 'active' && (
        <button
          type="button"
          onClick={() => setLogOpen(true)}
          className="w-full bg-red-600 hover:bg-red-500 text-white
                     font-semibold rounded-xl py-3 text-sm transition-colors"
        >
          Log Outcome
        </button>
      )}

      {outcome && <OutcomeResult outcome={outcome} />}

      {logOpen && (
        <LogOutcomeModal
          signal={signal}
          onClose={() => setLogOpen(false)}
          onComplete={() => {
            setLogOpen(false)
            fetchSignal()
          }}
        />
      )}
    </div>
  )
}

function SignalBar({ label, score, highlight }) {
  return (
    <div className="flex items-center gap-3">
      <p
        className={clsx(
          'text-xs flex-1',
          highlight ? 'text-white font-semibold' : 'text-zinc-400'
        )}
      >
        {label}
      </p>
      <div className="flex gap-0.5">
        {Array(10)
          .fill(0)
          .map((_, i) => (
            <div
              key={i}
              className={clsx(
                'rounded-sm',
                highlight ? 'w-2 h-4' : 'w-1.5 h-3',
                i < score ? (highlight ? 'bg-red-500' : 'bg-red-700') : 'bg-zinc-800'
              )}
            />
          ))}
      </div>
      <p
        className={clsx(
          'text-xs w-6 text-right',
          highlight ? 'text-white font-bold' : 'text-zinc-500'
        )}
      >
        {score}
      </p>
    </div>
  )
}

function InfoItem({ label, value }) {
  return (
    <div>
      <p className="text-muted text-[10px] uppercase tracking-wider">{label}</p>
      <p className="text-white text-xs font-medium mt-0.5">{value}</p>
    </div>
  )
}

function OutcomeResult({ outcome }) {
  return (
    <div
      className={clsx(
        'rounded-xl p-4 border',
        outcome.thesis_correct
          ? 'bg-green-950/20 border-green-900/40'
          : 'bg-red-950/20 border-red-900/40'
      )}
    >
      <p
        className={clsx(
          'font-bold text-sm mb-1',
          outcome.thesis_correct ? 'text-green-400' : 'text-red-400'
        )}
      >
        {outcome.thesis_correct ? '✓ Thesis Correct' : '✗ Thesis Wrong'}
      </p>
      <p className="text-zinc-400 text-xs">
        {outcome.catalyst_result?.replace(/_/g, ' ')}
      </p>
      {outcome.pnl_percent != null && (
        <p
          className={clsx(
            'text-sm font-bold mt-2',
            outcome.pnl_percent > 0 ? 'text-green-400' : 'text-red-400'
          )}
        >
          {outcome.pnl_percent > 0 ? '+' : ''}
          {outcome.pnl_percent}%
        </p>
      )}
    </div>
  )
}

function LoadingState() {
  return (
    <div className="px-4 pt-6 space-y-4">
      {Array(4)
        .fill(0)
        .map((_, i) => (
          <div
            key={i}
            className="bg-card border border-border rounded-xl p-4 animate-pulse h-24"
          />
        ))}
    </div>
  )
}

function NotFound({ onBack }) {
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center">
      <div className="text-center">
        <p className="text-zinc-400">Signal not found</p>
        <button onClick={onBack} className="text-red-400 text-sm mt-2">
          Back to dashboard
        </button>
      </div>
    </div>
  )
}
