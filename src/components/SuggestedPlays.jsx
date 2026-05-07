import { useEffect, useState } from 'react'
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
//
// Cards are persisted to localStorage keyed by ticker so navigating
// to /calculator or /log and back doesn't blank the panel. TTL mirrors
// the server-side play_suggestions cache (5 min).

const PLAYS_CACHE_TTL_MS = 5 * 60 * 1000

function playsCacheKey(ticker) {
  return ticker ? `pe_plays_${ticker.toUpperCase()}` : null
}

function loadCachedPlays(ticker) {
  const key = playsCacheKey(ticker)
  if (!key || typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed?.savedAt || Date.now() - parsed.savedAt > PLAYS_CACHE_TTL_MS) {
      window.localStorage.removeItem(key)
      return null
    }
    return parsed.data ?? null
  } catch {
    return null
  }
}

function saveCachedPlays(ticker, data) {
  const key = playsCacheKey(ticker)
  if (!key || typeof window === 'undefined' || !data) return
  try {
    window.localStorage.setItem(
      key,
      JSON.stringify({ savedAt: Date.now(), data }),
    )
  } catch {
    /* quota / private mode — silent */
  }
}

export default function SuggestedPlays({ ticker, isPro }) {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [data, setData] = useState(() => loadCachedPlays(ticker))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // Re-hydrate on ticker change — Markets reuses this component when
  // the user picks a different symbol.
  useEffect(() => {
    setData(loadCachedPlays(ticker))
    setError(null)
  }, [ticker])

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
      // Anchor the freshness clock to when the server says it was
      // computed, not when we received the response — so a cached hit
      // shows the right "expires in" countdown.
      const serverAgeMs = Number(result.data?.cache_age_ms) || 0
      const dataWithStamp = {
        ...result.data,
        _computed_at: Date.now() - serverAgeMs,
      }
      setData(dataWithStamp)
      saveCachedPlays(ticker, dataWithStamp)
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
          Cash Moves reads the live GEX matrix and proposes spread trade
          setups that fit your rules — strikes, expiration, contract
          count, R/R, and the rationale citing specific GEX numbers.
          Pro feature.
        </p>
      </div>
    )
  }

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 flex items-center justify-between border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles size={14} className="text-amber-400 shrink-0" />
          <h2 className="text-sm font-semibold shrink-0">Suggested Plays</h2>
          {data?._computed_at && (
            <CacheTimer computedAt={data._computed_at} />
          )}
        </div>
        <button
          onClick={fetchPlays}
          disabled={loading}
          className="text-xs text-amber-400 hover:text-amber-300 disabled:opacity-50 transition shrink-0"
        >
          {loading ? 'Thinking…' : data ? 'Re-analyze' : 'Generate'}
        </button>
      </div>

      <div className="p-4 space-y-3">
        {!data && !loading && !error && (
          <p className="text-xs text-subtle leading-relaxed">
            Tap <strong className="text-amber-400">Generate</strong> for
            spread setups based on{' '}
            <strong className="text-fg">{ticker}</strong>'s live GEX matrix
            and your account size. Refreshes once per 5 min cache window;
            limited to 30 generations per hour per account.
          </p>
        )}

        {loading && <ThinkingState />}

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

        {/* Matrix freshness row — lets the user tell whether re-analyze
            drift came from a data change (matrix moved) or model
            variance. computed_at = when the server built this payload;
            source = dxlink (live) vs yahoo (15-min delayed). */}
        {data && data._computed_at && (
          <MatrixFreshness
            computedAt={data._computed_at}
            source={data.source}
            spot={data.spot}
            dominantExp={data.dominant_gex_expiration}
          />
        )}

        {data && Array.isArray(data.plays) && data.plays.length === 0 && (
          <p className="text-xs text-subtle leading-relaxed py-2">
            <strong className="text-fg">No high-conviction setups</strong>{' '}
            in the current matrix. Cash Moves only surfaces plays that
            clear the rules — no padding. Check back when the chain has
            firmed up (typically late-morning + post-1pm ET).
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

// Animated "Claude is thinking" state — cycles through stage labels
// that mirror what the suggest-plays prompt actually does, plus two
// shimmer placeholder cards in the shape of real PlayCards. Each
// stage holds for ~1.8s; full cycle is ~14s which lines up with a
// typical Claude Sonnet response on this prompt. If the call takes
// longer the messages just loop, which is fine — the perception is
// still "the system is working," not "the system has hung."
const THINKING_STAGES = [
  'Reading the GEX matrix…',
  'Locating call & put walls…',
  'Checking today\'s flow against the walls…',
  'Identifying regime (A or B)…',
  'Drafting spread setups…',
  'Sizing positions to the 2% rule…',
  'Verifying R/R caps & DTE rules…',
  'Locking strikes to your matrix…',
]

function ThinkingState() {
  const [stage, setStage] = useState(0)
  useEffect(() => {
    const id = setInterval(() => {
      setStage((s) => (s + 1) % THINKING_STAGES.length)
    }, 1800)
    return () => clearInterval(id)
  }, [])
  return (
    <div className="space-y-3 py-1">
      <div className="flex items-center gap-2 text-xs">
        <Sparkles
          size={14}
          className="text-amber-400 shrink-0 animate-pulse"
          style={{ animationDuration: '1.4s' }}
        />
        <span
          key={stage}
          className="text-subtle animate-[fadeIn_0.4s_ease-out]"
          style={{ animation: 'fadeIn 0.4s ease-out' }}
        >
          {THINKING_STAGES[stage]}
        </span>
      </div>
      <SkeletonPlayCard accent="border-red-800/40 bg-red-950/10" />
      <SkeletonPlayCard accent="border-green-800/40 bg-green-950/10" />
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(2px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}

function SkeletonPlayCard({ accent }) {
  return (
    <div className={`border rounded-lg p-3 space-y-2 animate-pulse ${accent}`}>
      <div className="flex items-baseline justify-between gap-2">
        <div className="h-3 w-24 bg-bg-elev rounded" />
        <div className="h-2.5 w-16 bg-bg-elev rounded" />
      </div>
      <div className="h-4 w-44 bg-bg-elev rounded" />
      <div className="h-3 w-32 bg-bg-elev rounded" />
      <div className="grid grid-cols-3 gap-2">
        <div className="h-7 bg-bg-elev rounded" />
        <div className="h-7 bg-bg-elev rounded" />
        <div className="h-7 bg-bg-elev rounded" />
      </div>
      <div className="h-2.5 w-full bg-bg-elev rounded" />
      <div className="h-2.5 w-3/4 bg-bg-elev rounded" />
    </div>
  )
}

// Renders the input-side context the suggestions were built from:
// when the matrix was read, what feed it came from, the spot price
// it saw, and which expiration was anchoring the regime. Lets the
// user tell at a glance whether two different re-analyses saw the
// same world or not — i.e. is the new answer because the matrix
// moved, or because the model drifted? Re-renders every 30s so the
// "as of" text stays honest.
function MatrixFreshness({ computedAt, source, spot, dominantExp }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])
  const ageMs = Math.max(0, now - computedAt)
  const ageLabel = formatMs(ageMs)
  const time = new Date(computedAt).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })
  const sourceLabel =
    source === 'dxlink' ? { text: 'LIVE', tone: 'text-green-400' }
    : source === 'yahoo' ? { text: '15M DELAYED', tone: 'text-amber-400' }
    : source === 'eod' ? { text: 'EOD CLOSE', tone: 'text-yellow-400' }
    : { text: source, tone: 'text-amber-400' }
  return (
    <div className="bg-bg-elev/50 border border-border/60 rounded-lg px-3 py-2 text-[10px] text-subtle leading-relaxed">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-muted">Matrix as of</span>
        <span className="font-mono-tab tabular-nums text-fg">{time}</span>
        <span className="text-muted">·</span>
        <span className={sourceLabel.tone}>{sourceLabel.text}</span>
        <span className="text-muted">({source})</span>
        <span className="text-muted">· {ageLabel} ago</span>
      </div>
      <div className="text-muted mt-0.5">
        Spot ${spot != null ? Number(spot).toFixed(2) : '—'}
        {dominantExp && (
          <>
            <span className="mx-1.5">·</span>
            Dominant gamma at{' '}
            <span className="text-fg font-mono-tab tabular-nums">{dominantExp}</span>
          </>
        )}
      </div>
    </div>
  )
}

// Live "cached Xm ago · expires in Ym" pill. Re-renders every 30s
// so the user can tell at a glance whether re-analyzing is worthwhile.
function CacheTimer({ computedAt }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])
  const ageMs = Math.max(0, now - computedAt)
  const remainingMs = PLAYS_CACHE_TTL_MS - ageMs
  const expired = remainingMs <= 0
  return (
    <span
      className={
        'text-[9px] uppercase tracking-wider truncate ' +
        (expired ? 'text-amber-400' : 'text-muted')
      }
    >
      {expired
        ? 'stale — re-analyze'
        : `cached ${formatMs(ageMs)} · expires in ${formatMs(remainingMs)}`}
    </span>
  )
}

function formatMs(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  return `${Math.round(s / 60)}m`
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

      {play.market_view && (
        <p className="text-[11px] text-fg/85 leading-snug">
          <span className="eyebrow text-[9px] text-muted mr-1.5">View</span>
          {play.market_view}
        </p>
      )}

      <div className="grid grid-cols-4 gap-2 text-[11px]">
        <Stat label="Risk/spread" value={`$${formatNum(play.max_loss_per_spread)}`} />
        <Stat label="R/R" value={`1:${(play.risk_reward || 0).toFixed(1)}`} />
        <Stat label="Size" value={`${play.contracts}c`} />
        <Stat label="POP" value={formatPopFromBp(play.entry_pop_bp)} />
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

      {play.gamma_rolloff_risk && play.rolloff_note && (
        <p className="text-[10px] text-muted leading-relaxed border-l-2 border-orange-500/50 pl-2">
          <strong className="text-orange-400">Roll-off risk:</strong>{' '}
          {play.rolloff_note}
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

// POP comes back as integer basis points (0–10000). Render as a
// 2-digit percent — "70%" reads cleaner than "70.35%" on a card
// where the user is scanning, not making fine-grained comparisons.
function formatPopFromBp(bp) {
  if (bp == null || !Number.isFinite(Number(bp))) return '—'
  return `${Math.round(Number(bp) / 100)}%`
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

// All 5 spread structures the user can be deep-linked into. Direction
// here is the THESIS direction (a Bear Call Credit is bearish even
// though it's built from calls). LogSignal owns the structure→direction
// mapping internally too; passing both here just removes a hop.
const PLAY_TYPE_TO_PREFILL = {
  BULL_CALL:        { direction: 'long_call', structure: 'bull_call_spread' },
  BEAR_PUT:         { direction: 'long_put',  structure: 'bear_put_spread' },
  IRON_CONDOR:      { direction: 'watch',     structure: 'iron_condor' },
  BULL_PUT_CREDIT:  { direction: 'long_call', structure: 'bull_put_credit' },
  BEAR_CALL_CREDIT: { direction: 'long_put',  structure: 'bear_call_credit' },
}

function logAsSignal(navigate, play, ticker, spot) {
  const mapped = PLAY_TYPE_TO_PREFILL[play.type] || PLAY_TYPE_TO_PREFILL.BEAR_PUT
  // Derive a per-share premium from suggest-plays' dollar-denominated
  // max-loss / max-profit fields so the calculator opens with EVERY
  // field already populated — no re-typing. Convention:
  //   * debit  → premium = max_loss_per_spread / 100  (cost per share)
  //   * credit → premium = max_profit_per_spread / 100 (credit per share)
  //   * condor → same as credit (premium collected = max profit)
  const isDebit = play.type === 'BULL_CALL' || play.type === 'BEAR_PUT'
  const dollarBasis = isDebit
    ? Number(play.max_loss_per_spread)
    : Number(play.max_profit_per_spread)
  const premiumPerShare =
    Number.isFinite(dollarBasis) && dollarBasis > 0
      ? (dollarBasis / 100).toFixed(2)
      : null
  navigate('/log', {
    state: {
      prefill: {
        signal_source: 'gex_flow',
        ticker,
        stock_price_at_signal: String(spot),
        catalyst_type: 'other',
        direction: mapped.direction,
        structure: mapped.structure,
        // suggested_play_type lets LogSignal render the Suggested /
        // Modified-from-suggestion badge on the strategy picker.
        suggested_play_type: play.type,
        // POP from suggest-plays. Locks into the v2 signal_hash at
        // insert time so the prediction becomes part of the immutable
        // public record. Null is OK — DB column is nullable.
        entry_pop_bp: play.entry_pop_bp ?? null,
        thesis: `GEX-driven setup: ${play.rationale}`,
        long_strike: play.long_strike,
        short_strike: play.short_strike,
        expiry_date: play.expiration,
        // Premium per share — feeds the calculator's premium input so
        // the user lands on a fully-populated form, not one with three
        // fields still blank.
        premium: premiumPerShare,
      },
    },
  })
}
