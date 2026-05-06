import { useState } from 'react'
import { Sparkles, ExternalLink, FileText, AlertCircle, Lock } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

// Ask Claude for 0-3 spread trade ideas based on the live GEX matrix
// for the current ticker. Renders each as a card with strikes, expiry,
// sizing, rationale, and two deep-link buttons:
//   - "Open in Calculator" → /calculator?... prefilled
//   - "Log as Signal" → /log with prefill (gets immutable hash)
//
// Pro-only by design — eats Claude API tokens. Free users see a teaser.

export default function SuggestedPlays({ ticker, isPro }) {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  async function fetchPlays() {
    setLoading(true)
    setError(null)
    try {
      const accountSize = Number(profile?.account_size) || 10000
      const { data: result, error: invokeErr } = await supabase.functions.invoke(
        'suggest-plays',
        { body: { ticker, account_size: accountSize } },
      )
      if (invokeErr) {
        const ctx = invokeErr.context
        let msg = invokeErr.message || 'request failed'
        try {
          const body = await ctx?.json?.()
          if (body?.error) msg = body.error
        } catch { /* */ }
        throw new Error(msg)
      }
      if (!result?.success) throw new Error(result?.error || 'no plays returned')
      setData(result.data)
    } catch (err) {
      setError(err.message || String(err))
    } finally {
      setLoading(false)
    }
  }

  if (!isPro) {
    return (
      <div className="bg-card border border-amber-400/20 rounded-xl p-4 space-y-2">
        <div className="flex items-center gap-2">
          <Lock size={14} className="text-amber-400" />
          <h2 className="text-sm font-semibold">Suggested Plays</h2>
        </div>
        <p className="text-xs text-subtle leading-relaxed">
          Claude reads the live GEX matrix and proposes 0–3 spread trade
          setups that fit your Wiley Edge rules — strikes, expiration,
          contract count, R/R, and the rationale citing specific GEX
          numbers. Pro feature.
        </p>
      </div>
    )
  }

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 flex items-center justify-between border-b border-border">
        <div className="flex items-center gap-2">
          <Sparkles size={14} className="text-amber-400" />
          <h2 className="text-sm font-semibold">Suggested Plays</h2>
          {data?.from_cache && (
            <span className="text-[9px] uppercase tracking-wider text-muted">
              cached
            </span>
          )}
        </div>
        <button
          onClick={fetchPlays}
          disabled={loading}
          className="text-xs text-amber-400 hover:text-amber-300 disabled:opacity-50 transition"
        >
          {loading ? 'Thinking…' : data ? 'Re-analyze' : 'Generate'}
        </button>
      </div>

      <div className="p-4 space-y-3">
        {!data && !loading && !error && (
          <p className="text-xs text-subtle leading-relaxed">
            Tap <strong className="text-amber-400">Generate</strong> to ask
            Claude for spread setups based on{' '}
            <strong className="text-fg">{ticker}</strong>'s live GEX matrix
            and your account size. ~$0.04 in API tokens per call (counts
            against your 30/hour Claude quota).
          </p>
        )}

        {loading && (
          <p className="text-xs text-subtle py-4">
            Claude is reading the matrix…
          </p>
        )}

        {error && (
          <div className="flex items-start gap-2 text-xs text-crimson">
            <AlertCircle size={14} className="shrink-0 mt-0.5" />
            <div>
              <div className="font-medium">Couldn't generate plays.</div>
              <div className="text-subtle mt-1">{error}</div>
            </div>
          </div>
        )}

        {data && data.regime && (
          <div className="bg-bg-elev border border-border rounded-lg px-3 py-2">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] uppercase tracking-wider text-muted">
                Regime
              </span>
              <span
                className={
                  'text-[10px] font-bold px-1.5 py-0.5 rounded ' +
                  (data.regime === 'A'
                    ? 'bg-green-950 text-green-400 border border-green-800'
                    : data.regime === 'B'
                      ? 'bg-red-950 text-red-400 border border-red-800'
                      : 'bg-zinc-900 text-zinc-400 border border-zinc-700')
                }
              >
                {data.regime}
              </span>
            </div>
            <p className="text-xs text-subtle leading-relaxed">
              {data.regime_explanation}
            </p>
          </div>
        )}

        {data && Array.isArray(data.plays) && data.plays.length === 0 && (
          <p className="text-xs text-subtle leading-relaxed py-2">
            <strong className="text-fg">No high-conviction setups</strong>{' '}
            in the current matrix. Claude declined to invent one to pad
            the response. Check back when the chain has firmed up
            (typically late-morning + post-1pm ET).
          </p>
        )}

        {data &&
          Array.isArray(data.plays) &&
          data.plays.map((play, i) => (
            <PlayCard
              key={i}
              play={play}
              ticker={ticker}
              onOpenCalculator={() => openInCalculator(navigate, play, ticker, data.spot)}
              onLogSignal={() => logAsSignal(navigate, play, ticker, data.spot)}
            />
          ))}

        {data && (
          <p className="text-[10px] text-muted leading-relaxed pt-2 border-t border-border">
            Suggestions, not advice. Verify pricing in the Calculator
            before placing. GEX informs probability, not certainty —
            walls fail and regimes flip intraday.
          </p>
        )}
      </div>
    </div>
  )
}

function PlayCard({ play, onOpenCalculator, onLogSignal }) {
  const isCallSpread = play.type === 'BULL_CALL' || play.type === 'BEAR_CALL_CREDIT'
  const isBullish = play.type === 'BULL_CALL' || play.type === 'BULL_PUT_CREDIT'
  const accentClass = isBullish
    ? 'border-green-800 bg-green-950/20'
    : 'border-red-800 bg-red-950/20'

  return (
    <div className={`border rounded-lg p-3 space-y-2 ${accentClass}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold text-fg">{play.strategy}</span>
        <span className="text-[9px] uppercase tracking-wider text-muted shrink-0">
          {play.dte}d · {play.expiration}
        </span>
      </div>

      <div className="font-mono-tab tabular-nums text-sm text-fg">
        Long ${play.long_strike} {isCallSpread ? 'C' : 'P'}
        <span className="text-muted mx-2">/</span>
        Short ${play.short_strike} {isCallSpread ? 'C' : 'P'}
      </div>

      <div className="grid grid-cols-3 gap-2 text-[11px]">
        <Stat label="Risk/spread" value={`$${formatNum(play.max_loss_per_spread)}`} />
        <Stat label="R/R" value={`1:${(play.risk_reward || 0).toFixed(1)}`} />
        <Stat label="Size" value={`${play.contracts}c`} />
      </div>

      <p className="text-[11px] text-subtle leading-relaxed">
        {play.rationale}
      </p>

      {play.what_invalidates && (
        <p className="text-[10px] text-muted leading-relaxed border-l-2 border-amber-400/40 pl-2">
          <strong className="text-amber-400">Invalidates:</strong>{' '}
          {play.what_invalidates}
        </p>
      )}

      <div className="flex gap-2 pt-1">
        <button
          onClick={onOpenCalculator}
          className="flex-1 inline-flex items-center justify-center gap-1.5 bg-bg-elev hover:bg-card border border-border text-fg text-xs font-medium rounded-md py-1.5 transition"
        >
          <ExternalLink size={11} />
          Calculator
        </button>
        <button
          onClick={onLogSignal}
          className="flex-1 inline-flex items-center justify-center gap-1.5 bg-amber-400 hover:bg-amber-300 text-bg text-xs font-semibold rounded-md py-1.5 transition"
        >
          <FileText size={11} />
          Log Signal
        </button>
      </div>
    </div>
  )
}

function Stat({ label, value }) {
  return (
    <div className="bg-bg-elev/60 border border-border rounded px-2 py-1">
      <div className="text-[9px] uppercase tracking-wider text-muted">
        {label}
      </div>
      <div className="font-mono-tab tabular-nums text-fg font-medium">
        {value}
      </div>
    </div>
  )
}

function formatNum(v) {
  if (v == null) return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return n.toFixed(0)
}

// Deep-link helpers — both pages already accept route state for
// prefilling form fields.
function openInCalculator(navigate, play, ticker, spot) {
  navigate('/calculator', {
    state: {
      prefill: {
        ticker,
        stock_price: spot,
        long_strike: play.long_strike,
        short_strike: play.short_strike,
        expiration_date: play.expiration,
        direction: play.type === 'BULL_CALL' ? 'long_call' : 'long_put',
      },
    },
  })
}

function logAsSignal(navigate, play, ticker, spot) {
  navigate('/log', {
    state: {
      prefill: {
        ticker,
        stock_price_at_signal: String(spot),
        catalyst_type: 'other',
        direction: play.type === 'BULL_CALL' ? 'long_call' : 'long_put',
        thesis: `GEX-driven setup: ${play.rationale}`,
        long_strike: play.long_strike,
        short_strike: play.short_strike,
        expiry_date: play.expiration,
      },
    },
  })
}
