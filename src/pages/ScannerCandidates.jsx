import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Check, X, ChevronDown, ChevronUp, Sparkles } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import clsx from 'clsx'

export default function ScannerCandidates() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [candidates, setCandidates] = useState([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(null)
  const [working, setWorking] = useState(null)

  useEffect(() => {
    fetchCandidates()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  async function promote(candidate) {
    if (!user) return
    setWorking(candidate.id)
    // Claim the candidate first; LogSignal will write back promoted_to_signal
    // after the new signal is inserted.
    const { error } = await supabase
      .from('scanner_candidates')
      .update({
        reviewed: true,
        reviewed_by: user.id,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', candidate.id)
    setWorking(null)
    if (error) return

    const analysis = candidate.claude_analysis ?? null
    navigate('/log', {
      state: {
        prefill: {
          ticker: candidate.ticker || '',
          company_name: candidate.company_name || '',
          catalyst_type: candidate.catalyst_type || 'phase3_readout',
          catalyst_date: candidate.catalyst_date || '',
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
              onToggle={() =>
                setExpanded((cur) => (cur === candidate.id ? null : candidate.id))
              }
              onDismiss={() => dismiss(candidate)}
              onPromote={() => promote(candidate)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function CandidateCard({ candidate, expanded, busy, onToggle, onDismiss, onPromote }) {
  const analysis = candidate.claude_analysis ?? null
  const score = candidate.score ?? 0
  const flags = Array.isArray(candidate.flags) ? candidate.flags : []
  const dataGaps = Array.isArray(analysis?.data_gaps) ? analysis.data_gaps : []
  const isWatchlist = candidate.requested_by != null
  const scoreClass =
    score >= 8
      ? 'text-red-400 bg-red-950 border-red-800'
      : score >= 5
        ? 'text-yellow-400 bg-yellow-950 border-yellow-800'
        : 'text-zinc-400 bg-zinc-900 border-zinc-700'

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left p-4"
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
            >
              Score: {score}/10
            </span>
            {isWatchlist && (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border border-yellow-700 bg-yellow-950 text-yellow-400">
                ⭐ Watchlist
              </span>
            )}
          </div>
          {expanded ? (
            <ChevronUp size={14} className="text-subtle" />
          ) : (
            <ChevronDown size={14} className="text-subtle" />
          )}
        </div>

        <p className="text-subtle text-xs truncate">
          {candidate.company_name} · {candidate.catalyst_type?.replace(/_/g, ' ')}
        </p>

        {flags[0] && (
          <p className="text-red-400 text-[10px] mt-1 truncate">⚠ {flags[0]}</p>
        )}
      </button>

      {expanded && (
        <div className="px-4 pb-4 border-t border-border">
          {candidate.catalyst_date && (
            <div className="mt-3 mb-3">
              <p className="text-muted text-[10px] uppercase tracking-wider">
                Catalyst Date
              </p>
              <p className="text-white text-sm font-medium">
                {new Date(candidate.catalyst_date).toLocaleDateString('en-US', {
                  month: 'long',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </p>
            </div>
          )}

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
                  Suggested:{' '}
                  {String(analysis.suggested_direction).replace('_', ' ').toUpperCase()}
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
