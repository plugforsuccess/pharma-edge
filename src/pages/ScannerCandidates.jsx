import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Check, X, ChevronDown, ChevronUp, Sparkles, Star } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { directionLabelLong } from '../lib/design'
import clsx from 'clsx'

export default function ScannerCandidates() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [candidates, setCandidates] = useState([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(null)
  const [working, setWorking] = useState(null)
  // Set of tickers the user already watches — drives the ⭐ toggle.
  // Hydrated on mount; mutated locally on toggle so UI updates without refetch.
  const [watchedTickers, setWatchedTickers] = useState(() => new Set())

  useEffect(() => {
    fetchCandidates()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!user) return
    let cancelled = false
    supabase
      .from('watchlist')
      .select('ticker')
      .eq('user_id', user.id)
      .then(({ data }) => {
        if (cancelled || !data) return
        setWatchedTickers(new Set(data.map((r) => (r.ticker || '').toUpperCase())))
      })
    return () => { cancelled = true }
  }, [user?.id])

  async function toggleWatchlist(candidate) {
    if (!user) return
    const ticker = (candidate.ticker || '').toUpperCase()
    if (!ticker) return
    const isWatched = watchedTickers.has(ticker)
    // Optimistic UI: flip the badge first; revert on error.
    setWatchedTickers((prev) => {
      const next = new Set(prev)
      isWatched ? next.delete(ticker) : next.add(ticker)
      return next
    })
    if (isWatched) {
      const { error } = await supabase
        .from('watchlist')
        .delete()
        .eq('user_id', user.id)
        .eq('ticker', ticker)
      if (error) {
        setWatchedTickers((prev) => new Set(prev).add(ticker))
      }
    } else {
      const { error } = await supabase.from('watchlist').insert({
        user_id: user.id,
        ticker,
        company_name: candidate.company_name || '',
        drug_name: candidate.raw_data?.drug_name || null,
        indication: candidate.raw_data?.indication || null,
        catalyst_type: candidate.catalyst_type || null,
        catalyst_date: candidate.catalyst_date || null,
      })
      if (error) {
        setWatchedTickers((prev) => {
          const next = new Set(prev)
          next.delete(ticker)
          return next
        })
      }
    }
  }

  async function fetchCandidates() {
    setLoading(true)
    // RLS already filters to candidates this user can see (broad +
    // own-watchlist). We sort watchlist hits to the top because they're
    // the more personally relevant ones.
    const { data } = await supabase
      .from('scanner_candidates')
      .select('*')
      .eq('reviewed', false)
      .eq('dismissed', false)
      .order('requested_by', { ascending: false, nullsFirst: false })
      .order('detected_at', { ascending: false })
      .limit(20)
    setCandidates(data ?? [])
    setLoading(false)
  }

  async function dismiss(candidate) {
    if (!user) return
    setWorking(candidate.id)
    const { error } = await supabase
      .from('scanner_candidates')
      .update({
        dismissed: true,
        reviewed: true,
        reviewed_by: user.id,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', candidate.id)
    setWorking(null)
    if (!error) {
      setCandidates((prev) => prev.filter((c) => c.id !== candidate.id))
    }
  }

  function promote(candidate) {
    if (!user) return
    // Don't pre-claim — LogSignal marks the candidate reviewed only
    // after a successful signal insert. Pre-claiming meant the candidate
    // silently disappeared from the queue if the user backed out.
    const analysis = candidate.claude_analysis ?? null
    const rd = candidate.raw_data || {}
    navigate('/log', {
      state: {
        prefill: {
          ticker: candidate.ticker || '',
          company_name: candidate.company_name || '',
          drug_name: rd.drug_name || '',
          indication: rd.indication || '',
          catalyst_type: candidate.catalyst_type || 'phase3_readout',
          catalyst_date: candidate.catalyst_date || '',
          catalyst_date_precision: rd.catalyst_date_precision || 'day',
          stock_price_at_signal:
            rd.stock_price != null ? String(rd.stock_price) : '',
          thesis: analysis?.preliminary_thesis || '',
          direction: analysis?.suggested_direction || 'long_put',
        },
        candidate_id: candidate.id,
      },
    })
  }

  return (
    <div className="px-4 pt-6 pb-8">
      <div className="flex items-center gap-3 mb-6">
        <button
          type="button"
          onClick={() => navigate(-1)}
          aria-label="Back"
          className="w-9 h-9 bg-card border border-border rounded-xl flex items-center justify-center text-zinc-400"
        >
          <ArrowLeft size={16} />
        </button>
        <div>
          <h1 className="text-white font-bold">Scanner Queue</h1>
          <p className="text-subtle text-xs">
            {loading ? '…' : `${candidates.length} candidates pending review`}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-1 text-muted text-xs">
          <Sparkles size={12} />
          <span>AI-detected</span>
        </div>
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array(3)
            .fill(0)
            .map((_, i) => (
              <div
                key={i}
                className="bg-card border border-border rounded-xl h-24 animate-pulse"
              />
            ))}
        </div>
      ) : candidates.length === 0 ? (
        <div className="bg-card border border-border rounded-xl p-8 text-center">
          <Sparkles size={24} className="text-muted mx-auto mb-3" />
          <p className="text-subtle text-sm">No candidates pending review</p>
          <p className="text-muted text-xs mt-1">Scanner runs daily at 7am ET</p>
        </div>
      ) : (
        <div className="space-y-3">
          {candidates.map((candidate) => (
            <CandidateCard
              key={candidate.id}
              candidate={candidate}
              expanded={expanded === candidate.id}
              busy={working === candidate.id}
              isWatched={watchedTickers.has(
                (candidate.ticker || '').toUpperCase(),
              )}
              onToggle={() =>
                setExpanded((cur) => (cur === candidate.id ? null : candidate.id))
              }
              onDismiss={() => dismiss(candidate)}
              onPromote={() => promote(candidate)}
              onWatchlistToggle={() => toggleWatchlist(candidate)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// Strategy is micro-cap biotech; anything above $10B is generally not
// actionable on a single Phase 2/3 readout because the catalyst isn't
// material to the parent's price.
const MEGA_CAP_THRESHOLD = 10_000_000_000

const CATALYST_LABEL = {
  pdufa: 'PDUFA Date',
  adcomm: 'Advisory Committee Meeting',
  phase2_readout: 'Phase 2 Readout',
  phase3_readout: 'Phase 3 Readout',
  enrollment_end: 'Enrollment Completion',
  patent_expiry: 'Patent Expiry',
  earnings: 'Earnings',
  other: 'Other Catalyst',
}

function prettyCatalyst(type) {
  if (!type) return 'Catalyst'
  return CATALYST_LABEL[type] || type.replace(/_/g, ' ')
}

function formatMarketCap(cap) {
  if (!cap) return null
  if (cap >= 1e12) return `$${(cap / 1e12).toFixed(1)}T`
  if (cap >= 1e9) return `$${(cap / 1e9).toFixed(1)}B`
  if (cap >= 1e6) return `$${(cap / 1e6).toFixed(0)}M`
  return `$${cap}`
}

// Render the catalyst date at its real precision so we don't show a
// fake-precise 'August 15, 2026' when CT.gov only confirmed 'August 2026'.
// Splits the YYYY-MM-DD string manually instead of constructing a Date so
// timezone offsets don't shift the day.
function formatCatalystDate(date, precision) {
  if (!date) return null
  const parts = String(date).split('-').map(Number)
  const [y, m, d] = parts
  if (!y) return null
  if (precision === 'year') return String(y)
  const monthName = new Date(Date.UTC(y, (m || 1) - 1, 1)).toLocaleDateString('en-US', {
    month: 'long',
    timeZone: 'UTC',
  })
  if (precision === 'month') return `${monthName} ${y}`
  return `${monthName} ${d}, ${y}`
}

function CandidateCard({
  candidate,
  expanded,
  busy,
  isWatched,
  onToggle,
  onDismiss,
  onPromote,
  onWatchlistToggle,
}) {
  const analysis = candidate.claude_analysis ?? null
  const score = candidate.score ?? 0
  const flags = Array.isArray(candidate.flags) ? candidate.flags : []
  const dataGaps = Array.isArray(analysis?.data_gaps) ? analysis.data_gaps : []
  const isWatchlist = candidate.requested_by != null
  const marketCap = candidate.market_cap ? Number(candidate.market_cap) : null
  const isMegaCap = marketCap != null && marketCap >= MEGA_CAP_THRESHOLD
  const marketCapLabel = formatMarketCap(marketCap)
  const scoreClass =
    score >= 8
      ? 'text-red-400 bg-red-950 border-red-800'
      : score >= 5
        ? 'text-yellow-400 bg-yellow-950 border-yellow-800'
        : 'text-zinc-400 bg-zinc-900 border-zinc-700'

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="relative">
        {candidate.ticker && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onWatchlistToggle?.()
            }}
            aria-label={isWatched ? 'Remove from watchlist' : 'Add to watchlist'}
            title={isWatched ? 'Watching — click to stop' : 'Add to watchlist (track future activity)'}
            className="absolute top-3 right-3 p-1.5 rounded-full hover:bg-bg z-10 transition-colors"
          >
            <Star
              size={16}
              className={clsx(
                'transition-colors',
                isWatched ? 'text-yellow-400 fill-yellow-400' : 'text-zinc-600',
              )}
            />
          </button>
        )}
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left p-4 pr-12"
        aria-expanded={expanded}
      >
        <div className="flex items-start justify-between mb-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-white font-bold text-sm">
              {candidate.ticker || candidate.company_name?.slice(0, 20) || 'Unknown'}
            </span>
            <span
              className={clsx(
                'text-[10px] font-bold px-2 py-0.5 rounded-full border',
                scoreClass,
              )}
              title="Catalyst Strength: how many setup signals this catalyst trips — phase (P3 +3, P2 +2), small enrollment +1, multiple endpoints +2, site terminations +3, trial halt +4, recent amendment +3, then market-cap weighted. NOT your conviction in a trade thesis (that's Confidence on LogSignal)."
            >
              Catalyst Strength: {score}/10
            </span>
            {isWatchlist && (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border border-yellow-700 bg-yellow-950 text-yellow-400">
                ⭐ Watchlist
              </span>
            )}
            {isMegaCap && (
              <span
                className="text-[10px] font-bold px-2 py-0.5 rounded-full border border-zinc-600 bg-zinc-900 text-zinc-300"
                title="Mega-cap — single Phase 2/3 readout rarely material to parent stock"
              >
                {marketCapLabel} · Mega-cap
              </span>
            )}
            {!isMegaCap && marketCapLabel && (
              <span className="text-[10px] font-medium px-2 py-0.5 rounded-full border border-border bg-bg text-subtle">
                {marketCapLabel}
              </span>
            )}
          </div>
          {expanded ? (
            <ChevronUp size={14} className="text-subtle" />
          ) : (
            <ChevronDown size={14} className="text-subtle" />
          )}
        </div>

        {/* Collapsed-only summary: when expanded, the full Catalyst +
            Detected Signals sections below already cover this, so
            hiding it here removes the duplicate. Company name stays
            visible in both states because it's the human label.
            Drug name + indication shown in collapsed view so the
            same sponsor's multiple trials are distinguishable
            (e.g. KPTI has 5+ ongoing programs — same ticker, different
            drugs/indications). */}
        <p className="text-subtle text-xs truncate">
          {candidate.company_name || candidate.ticker || 'Unknown'}
          {!expanded && candidate.raw_data?.drug_name
            ? ` · ${candidate.raw_data.drug_name}`
            : ''}
          {!expanded && candidate.raw_data?.indication
            ? ` · ${candidate.raw_data.indication}`
            : ''}
          {!expanded && candidate.catalyst_type
            ? ` · ${prettyCatalyst(candidate.catalyst_type)}`
            : ''}
        </p>

        {!expanded && flags[0] && (
          <p className="text-red-400 text-[10px] mt-1 truncate">⚠ {flags[0]}</p>
        )}
      </button>
      </div>

      {expanded && (
        <div className="px-4 pb-4 border-t border-border">
          <div className="mt-3 mb-3">
            <p className="text-muted text-[10px] uppercase tracking-wider">
              Catalyst
            </p>
            <p className="text-white text-sm font-medium">
              {prettyCatalyst(candidate.catalyst_type)}
            </p>
            {candidate.catalyst_date ? (
              <p className="text-subtle text-xs mt-0.5">
                {formatCatalystDate(
                  candidate.catalyst_date,
                  candidate.raw_data?.catalyst_date_precision,
                )}
                {candidate.raw_data?.catalyst_date_precision === 'month' && (
                  <span
                    className="ml-2 text-[10px] text-muted"
                    title="CT.gov reported only the month — exact day not yet disclosed. Verify with the company's press release before locking a signal."
                  >
                    · exact day TBD
                  </span>
                )}
                {candidate.raw_data?.catalyst_date_precision === 'year' && (
                  <span
                    className="ml-2 text-[10px] text-muted"
                    title="CT.gov reported only the year — exact month and day not yet disclosed."
                  >
                    · month/day TBD
                  </span>
                )}
              </p>
            ) : (
              <p className="text-muted text-xs mt-0.5 italic">
                Date not parsed — review filing
              </p>
            )}
          </div>

          {flags.length > 0 && (
            <div className="mb-3">
              <p className="text-muted text-[10px] uppercase tracking-wider mb-2">
                Detected Signals
              </p>
              <div className="space-y-1">
                {flags.map((flag, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span className="text-red-500 text-xs">⚠</span>
                    <p className="text-zinc-400 text-xs">{flag}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {analysis?.preliminary_thesis && (
            <div className="mb-3 bg-bg border border-border rounded-lg p-3">
              <p className="text-subtle text-[10px] uppercase tracking-wider mb-1">
                AI Preliminary Read
              </p>
              <p className="text-zinc-400 text-xs leading-relaxed">
                {analysis.preliminary_thesis}
              </p>
              {analysis.suggested_direction && (
                <p
                  className={clsx(
                    'text-xs font-semibold mt-2',
                    analysis.suggested_direction === 'long_put'
                      ? 'text-red-400'
                      : analysis.suggested_direction === 'long_call'
                        ? 'text-green-400'
                        : 'text-zinc-400',
                  )}
                >
                  Suggested: {directionLabelLong(analysis.suggested_direction)}
                </p>
              )}
            </div>
          )}

          {dataGaps.length > 0 && (
            <div className="mb-3">
              <p className="text-muted text-[10px] uppercase tracking-wider mb-1">
                Data Gaps
              </p>
              {dataGaps.map((gap, i) => (
                <p key={i} className="text-muted text-xs">
                  • {gap}
                </p>
              ))}
            </div>
          )}

          <div className="flex gap-2 mt-4">
            <button
              type="button"
              onClick={onDismiss}
              disabled={busy}
              className="flex-1 flex items-center justify-center gap-1 bg-bg border border-border text-subtle font-semibold rounded-xl py-2.5 text-xs hover:border-zinc-700 transition-colors disabled:opacity-50"
            >
              <X size={12} />
              Dismiss
            </button>
            <button
              type="button"
              onClick={onPromote}
              disabled={busy}
              className="flex-1 flex items-center justify-center gap-1 bg-red-600 hover:bg-red-500 disabled:bg-red-950 text-white font-semibold rounded-xl py-2.5 text-xs transition-colors"
            >
              <Check size={12} />
              {busy ? 'Working…' : 'Promote'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
