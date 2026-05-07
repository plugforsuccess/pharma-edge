import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft, Check, ChevronDown } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import AnalyzeFilingPanel from '../components/AnalyzeFilingPanel'
import StrikePriceCalculator from '../components/StrikePriceCalculator'
import TickerDrawer from '../components/TickerDrawer'
import Modal from '../components/Modal'
import { TICKER_UNIVERSE } from '../lib/tickerUniverse'
import { directionLabelLong } from '../lib/design'
import clsx from 'clsx'

const CHECKLIST_ITEMS = [
  { key: 'checklist_read_sources', label: 'I have read the source documents' },
  { key: 'checklist_thesis_defined', label: 'My thesis is clearly defined' },
  { key: 'checklist_invalidation_known', label: 'I know what would invalidate my thesis' },
  { key: 'checklist_position_sized', label: 'Position size is under 2% of account' },
  { key: 'checklist_spread_used', label: 'I am using a spread, not a naked option' },
  { key: 'checklist_dte_checked', label: 'DTE is 30–45+ days past the catalyst' },
  { key: 'checklist_two_signals', label: 'At least 2 signals confirmed' },
  { key: 'checklist_not_at_highs', label: 'Stock is NOT at all-time highs' },
  { key: 'checklist_exit_planned', label: 'I have a pre-planned exit date' },
  { key: 'checklist_loss_accepted', label: 'I can afford to lose this entire trade' },
]

const DEFAULT_STRUCTURE = {
  long_put: 'bear_put_spread',
  long_call: 'bull_call_spread',
  watch: 'watch',
}

// All Cash Moves spread structures the user can log. Each entry
// captures BOTH the structure value (DB-side enum) AND the directional
// bias the signal carries — credit spreads are built from puts/calls
// but the underlying thesis is still long_call (bullish) or long_put
// (bearish). Iron condors are neutral, encoded as 'watch' on the
// direction column to avoid extending the direction enum.
//
// Order matches the suggest-plays prompt's strategy list so that when
// a user clicks Log Signal on a suggested play, the prefilled choice
// lands in a predictable spot in the picker.
const STRATEGY_OPTIONS = [
  { structure: 'bull_call_spread',  direction: 'long_call', label: 'Bull Call',     color: 'border-green-500 bg-green-950/30 text-green-400' },
  { structure: 'bear_put_spread',   direction: 'long_put',  label: 'Bear Put',      color: 'border-red-500 bg-red-950/30 text-red-400' },
  { structure: 'iron_condor',       direction: 'watch',     label: 'Iron Condor',   color: 'border-purple-500 bg-purple-950/30 text-purple-400' },
  { structure: 'bull_put_credit',   direction: 'long_call', label: 'Bull Put Credit', color: 'border-emerald-500 bg-emerald-950/30 text-emerald-400' },
  { structure: 'bear_call_credit',  direction: 'long_put',  label: 'Bear Call Credit',color: 'border-rose-500 bg-rose-950/30 text-rose-400' },
  { structure: 'watch',             direction: 'watch',     label: 'Watch only',    color: 'border-zinc-500 bg-zinc-900 text-zinc-400' },
]

// Map from suggest-plays' play.type to the matching STRATEGY_OPTIONS row.
const SUGGESTED_TYPE_TO_STRUCTURE = {
  BULL_CALL: 'bull_call_spread',
  BEAR_PUT: 'bear_put_spread',
  IRON_CONDOR: 'iron_condor',
  BULL_PUT_CREDIT: 'bull_put_credit',
  BEAR_CALL_CREDIT: 'bear_call_credit',
}

const today = () => new Date().toISOString().slice(0, 10)

// localStorage-backed draft persistence keyed by candidate_id, so leaving
// LogSignal and re-promoting the same candidate restores the rich
// AnalyzeFilingPanel result instead of the user having to re-run Claude.
// 7-day TTL prunes stale drafts. Solo-user / per-device by design.
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000

function draftKey(candidateId) {
  return candidateId ? `pe_draft_analysis_${candidateId}` : null
}

function loadDraftAnalysis(candidateId) {
  const key = draftKey(candidateId)
  if (!key || typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed?.savedAt || Date.now() - parsed.savedAt > DRAFT_TTL_MS) {
      window.localStorage.removeItem(key)
      return null
    }
    return parsed.analysis ?? null
  } catch {
    return null
  }
}

function saveDraftAnalysis(candidateId, analysis) {
  const key = draftKey(candidateId)
  if (!key || typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      key,
      JSON.stringify({ savedAt: Date.now(), analysis }),
    )
  } catch {
    /* quota / private mode — silent */
  }
}

function clearDraftAnalysis(candidateId) {
  const key = draftKey(candidateId)
  if (!key || typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

// ─── DB-backed cross-device draft persistence ────────────────────
// localStorage above is the fast cache (synchronous on mount). The
// candidate_drafts table is the canonical store so a draft started
// on phone shows up on desktop. RLS scopes to own rows.

async function fetchRemoteDraft(supabaseClient, candidateId) {
  if (!candidateId) return null
  const { data } = await supabaseClient
    .from('candidate_drafts')
    .select('analysis')
    .eq('candidate_id', candidateId)
    .maybeSingle()
  return data?.analysis ?? null
}

async function upsertRemoteDraft(supabaseClient, userId, candidateId, analysis) {
  if (!candidateId || !userId) return
  await supabaseClient
    .from('candidate_drafts')
    .upsert(
      {
        user_id: userId,
        candidate_id: candidateId,
        analysis,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,candidate_id' },
    )
}

async function deleteRemoteDraft(supabaseClient, candidateId) {
  if (!candidateId) return
  await supabaseClient.from('candidate_drafts').delete().eq('candidate_id', candidateId)
}

export default function LogSignal() {
  const { user, profile } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const prefill = location.state?.prefill || {}
  const candidateId = location.state?.candidate_id || null

  const [step, setStep] = useState(1)
  const [loading, setLoading] = useState(false)
  const [submitError, setSubmitError] = useState('')
  // Ticker picker drawer — same component the Markets page uses, with
  // allowCustom=true so users can commit a symbol that isn't in the
  // curated universe (newly-IPO'd, OTC, etc.).
  const [tickerDrawerOpen, setTickerDrawerOpen] = useState(false)
  // Verification modal for the entry POP. Fires before submit when the
  // user manually entered or modified a POP value — the calibration
  // chain is only credible if the user explicitly confirms the number
  // they're locking into the public hash.
  const [popVerifyOpen, setPopVerifyOpen] = useState(false)
  // The POP value that came in from prefill (suggested-play handoff or
  // calculator output). We capture it once at mount so we can detect
  // whether the user has typed a different value at submit time. Auto-
  // computed POPs that the user left alone don't need a verification
  // modal — the lognormal Black-Scholes math is mechanical, not a
  // judgement call.
  const prefilledPopBp =
    prefill.entry_pop_bp != null && Number.isFinite(Number(prefill.entry_pop_bp))
      ? Math.round(Number(prefill.entry_pop_bp))
      : null
  // The structure Claude originally suggested for this signal, if the
  // user arrived here via Suggested Plays. Used to render a "Suggested"
  // badge while the prefilled choice is selected, and a "Modified from
  // suggestion" hint if they pick something else. Stays in component
  // state — doesn't write to the DB; the audit trail lives in the
  // signal's thesis text and the linked candidate row.
  const suggestedStructure =
    prefill.structure ||
    SUGGESTED_TYPE_TO_STRUCTURE[prefill.suggested_play_type] ||
    null
  // Synchronous hydrate from localStorage so first paint is instant.
  // The DB fetch below overrides if a newer cross-device draft exists.
  const [analysis, setAnalysis] = useState(() => loadDraftAnalysis(candidateId))

  useEffect(() => {
    if (!candidateId) return
    let cancelled = false
    fetchRemoteDraft(supabase, candidateId).then((remote) => {
      if (cancelled || !remote) return
      // Override local cache when DB has a draft (DB is canonical).
      // If localStorage already had this analysis, no visible change.
      setAnalysis(remote)
      saveDraftAnalysis(candidateId, remote)
    })
    return () => {
      cancelled = true
    }
  }, [candidateId])

  const [form, setForm] = useState(() => ({
    // signal_source: always 'gex_flow' in the GEX-first product. The
    // biotech_catalyst path remains in the DB schema and on existing
    // historical signals, but the LogSignal UI no longer surfaces a
    // toggle — every newly-logged trade is a GEX-driven structure.
    // Suggested Plays continues to pass 'gex_flow' explicitly; we keep
    // honoring an explicit prefill so legacy deep links don't break.
    signal_source: prefill.signal_source || 'gex_flow',
    ticker: (prefill.ticker || '').toUpperCase(),
    company_name: prefill.company_name || '',
    drug_name: prefill.drug_name || '',
    indication: prefill.indication || '',
    catalyst_type:
      prefill.catalyst_type ||
      (prefill.signal_source === 'gex_flow' ? 'other' : 'pdufa'),
    catalyst_date: prefill.catalyst_date || '',
    catalyst_date_precision: prefill.catalyst_date_precision || 'day',
    // Resolve direction + structure together. When the prefill came
    // from a Suggested Play we get a play.type string ("BEAR_CALL_CREDIT"
    // etc.) which uniquely determines both. Otherwise fall back to the
    // legacy debit-spread default.
    direction:
      prefill.direction ||
      STRATEGY_OPTIONS.find((o) => o.structure === SUGGESTED_TYPE_TO_STRUCTURE[prefill.suggested_play_type])?.direction ||
      'long_put',
    trade_type: 'paper',
    structure:
      prefill.structure ||
      SUGGESTED_TYPE_TO_STRUCTURE[prefill.suggested_play_type] ||
      DEFAULT_STRUCTURE[prefill.direction] ||
      DEFAULT_STRUCTURE.long_put,
    entry_price: '',
    // Prefer an explicit prefill.expiry_date (Suggested Plays sends one),
    // otherwise default expiry to catalyst_date + 35 days (mid of 30–45
    // window per the strategy rule). If neither is set we leave blank.
    expiry_date:
      prefill.expiry_date ||
      (prefill.catalyst_date
        ? new Date(new Date(prefill.catalyst_date).getTime() + 35 * 86400_000)
            .toISOString()
            .slice(0, 10)
        : ''),
    long_strike: prefill.long_strike != null ? String(prefill.long_strike) : '',
    short_strike:
      prefill.short_strike != null ? String(prefill.short_strike) : '',
    // Per-share premium from a Suggested Play prefill — surfaced to the
    // calculator below as initialPremium so the form lands on a fully-
    // populated state and auto-runs calculate(). Stored on the form so
    // it survives step navigation.
    prefill_premium:
      prefill.premium != null ? String(prefill.premium) : '',
    // Filled by StrikePriceCalculator's onCalculationComplete callback so
    // we can auto-create the open_positions row after the signal locks.
    contracts: '1',
    market_cap: '',
    stock_price_at_signal: prefill.stock_price_at_signal || '',
    your_probability: '',
    market_implied_probability: '',
    thesis: prefill.thesis || '',
    source_urls: '',
    confidence_score: 7,
    // entry_pop_bp: integer 0-10000, nullable. Locked into the v2
    // signal_hash at insert time. We DO NOT expose this as a typeable
    // field — it's populated from the suggested-play prefill or
    // computed inline by StrikePriceCalculator from live IV. Letting
    // users edit it would defeat the calibration-tracking purpose.
    entry_pop_bp:
      prefill.entry_pop_bp != null && Number.isFinite(Number(prefill.entry_pop_bp))
        ? Math.round(Number(prefill.entry_pop_bp))
        : null,
    ...Object.fromEntries(CHECKLIST_ITEMS.map((i) => [i.key, false])),
  }))

  const isGexFlow = form.signal_source === 'gex_flow'

  function update(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function updateDirection(newDirection) {
    setForm((prev) => ({
      ...prev,
      direction: newDirection,
      // Auto-pick the matching structure if user hasn't customised it.
      structure:
        prev.structure === DEFAULT_STRUCTURE[prev.direction]
          ? DEFAULT_STRUCTURE[newDirection]
          : prev.structure,
    }))
  }

  function handleAnalysisComplete(result) {
    // localStorage write is synchronous (fast cache); the DB upsert is
    // fire-and-forget so the UI doesn't wait. Both happen so a draft
    // started on phone shows up on desktop and vice versa.
    setAnalysis(result)
    saveDraftAnalysis(candidateId, result)
    if (user?.id) {
      upsertRemoteDraft(supabase, user.id, candidateId, result).catch(() => {})
    }
    setForm((prev) => ({
      ...prev,
      // Only fill thesis if the user hasn't typed their own.
      thesis: prev.thesis.trim() ? prev.thesis : result.thesis ?? prev.thesis,
      confidence_score: result.confidence_score ?? prev.confidence_score,
      direction: result.direction_recommendation ?? prev.direction,
      structure:
        prev.structure === DEFAULT_STRUCTURE[prev.direction]
          ? result.suggested_structure ?? DEFAULT_STRUCTURE[result.direction_recommendation || prev.direction]
          : prev.structure,
      your_probability:
        result.your_probability != null ? String(result.your_probability) : prev.your_probability,
      market_implied_probability:
        result.market_implied_probability != null
          ? String(result.market_implied_probability)
          : prev.market_implied_probability,
    }))
  }

  const checklistComplete = useMemo(
    () => CHECKLIST_ITEMS.every((i) => form[i.key]),
    [form],
  )

  // For biotech catalysts we require company + a real future catalyst date.
  // For GEX flow trades there's no biotech catalyst — the spread expiry is
  // the de-facto deadline, and company_name is auto-derived from the ticker
  // on submit, so the only step-1 requirements are ticker + expiry.
  const step1Valid = isGexFlow
    ? Boolean(form.ticker.trim() && form.expiry_date && form.expiry_date >= today())
    : Boolean(
        form.ticker.trim() &&
          form.company_name.trim() &&
          form.catalyst_date &&
          form.catalyst_date >= today(),
      )

  async function submitSignal() {
    setSubmitError('')
    setLoading(true)

    const num = (v) => (v === '' || v == null ? null : Number(v))
    // For GEX-flow signals the spread expiry IS the resolution date —
    // we mirror it into catalyst_date so the (still NOT NULL) DB column
    // is honest about when the thesis must play out, and drug/indication
    // are explicitly nulled since they don't exist for index trades.
    const ticker = form.ticker.toUpperCase().trim()
    const effectiveCatalystDate = isGexFlow
      ? form.expiry_date
      : form.catalyst_date
    const effectiveCompanyName = isGexFlow
      ? form.company_name.trim() || ticker
      : form.company_name.trim()
    const signalData = {
      user_id: user.id,
      signal_source: form.signal_source,
      ticker,
      company_name: effectiveCompanyName,
      drug_name: isGexFlow ? null : form.drug_name.trim() || null,
      indication: isGexFlow ? null : form.indication.trim() || null,
      catalyst_type: isGexFlow ? 'other' : form.catalyst_type,
      catalyst_date: effectiveCatalystDate,
      direction: form.direction,
      trade_type: form.trade_type,
      structure: form.structure,
      entry_price: num(form.entry_price),
      expiry_date: form.expiry_date || null,
      market_cap: num(form.market_cap),
      stock_price_at_signal: num(form.stock_price_at_signal),
      your_probability: num(form.your_probability),
      market_implied_probability: num(form.market_implied_probability),
      // The thesis textarea was removed from step 2 — Suggested Plays
      // prefills a rationale-derived thesis, and manual logs without a
      // typed thesis fall back to a structure-derived auto-thesis so
      // the NOT NULL DB constraint is honored without forcing the user
      // to write copy that adds no signal.
      thesis: form.thesis.trim() || autoThesis(form, ticker),
      claude_analysis: analysis?.claude_analysis ?? null,
      claude_analysis_full: analysis ?? null,
      confidence_score: form.confidence_score,
      // entry_pop_bp + hash_version: the DB column default for hash_version
      // is 2 (set in migration 20260507000002), so omitting it here would
      // also work — but explicit > implicit when the column is in the
      // signal_hash payload. New signals inserted from the app are ALWAYS
      // v2; hash_version=1 is a backfill marker for pre-2026-05-07 rows.
      entry_pop_bp: form.entry_pop_bp,
      hash_version: 2,
      enrollment_signal: analysis?.signal_scores?.enrollment_signal ?? 0,
      fda_precedent_signal: analysis?.signal_scores?.fda_precedent_signal ?? 0,
      protocol_amendment_signal: analysis?.signal_scores?.protocol_amendment_signal ?? 0,
      insider_selling_signal: analysis?.signal_scores?.insider_selling_signal ?? 0,
      cash_runway_signal: analysis?.signal_scores?.cash_runway_signal ?? 0,
      source_urls: form.source_urls
        ? form.source_urls.split('\n').map((s) => s.trim()).filter(Boolean)
        : [],
      ...Object.fromEntries(CHECKLIST_ITEMS.map((i) => [i.key, form[i.key]])),
      // signal_hash + logged_at intentionally omitted: the DB trigger
      // computes the canonical hash on INSERT and logged_at defaults to NOW().
    }

    const { data, error } = await supabase
      .from('signals')
      .insert(signalData)
      .select()
      .single()

    if (error) {
      setLoading(false)
      setSubmitError(error.message)
      return
    }

    // Signal locked successfully — clear local + remote draft so a
    // future promote of the same candidate (rare) doesn't restore stale.
    clearDraftAnalysis(candidateId)
    if (candidateId) {
      deleteRemoteDraft(supabase, candidateId).catch(() => {})
    }

    // If this signal was promoted from a scanner candidate, link + claim
    // it now (only after the signal actually inserted — pre-claiming on
    // navigate meant a back-out silently lost the candidate from the queue).
    if (candidateId) {
      await supabase
        .from('scanner_candidates')
        .update({
          promoted_to_signal: data.id,
          reviewed: true,
          reviewed_by: user.id,
          reviewed_at: new Date().toISOString(),
        })
        .eq('id', candidateId)
    }

    // Auto-create the open_positions row so monitor-positions starts
    // tracking P&L immediately. We only create when the user has the
    // calculator-derived strikes + entry — otherwise we'd be guessing.
    // Failure here is non-fatal: the user can still tap "+ Add" on the
    // Open Positions widget to enter manually.
    const longStrikeNum = num(form.long_strike)
    const shortStrikeNum = num(form.short_strike)
    const entryPriceNum = num(form.entry_price)
    const contractsNum = Math.max(1, parseInt(form.contracts, 10) || 1)
    if (
      form.direction !== 'watch' &&
      form.expiry_date &&
      longStrikeNum != null &&
      shortStrikeNum != null &&
      entryPriceNum != null &&
      entryPriceNum > 0
    ) {
      const strategyType =
        form.structure === 'bull_call_spread'
          ? 'BULL_CALL'
          : form.structure === 'bear_put_spread'
            ? 'BEAR_PUT'
            : null
      if (strategyType) {
        await supabase.from('open_positions').insert({
          user_id: user.id,
          signal_id: data.id,
          ticker,
          strategy_type: strategyType,
          long_strike: longStrikeNum,
          short_strike: shortStrikeNum,
          expiration: form.expiry_date,
          contracts: contractsNum,
          entry_debit_per_spread: entryPriceNum,
          thesis: form.thesis.trim() || null,
          source: isGexFlow ? 'gex_play' : 'catalyst',
        })
        // Insert is fire-and-forget on failure (non-fatal) — RLS
        // violations or a dup row shouldn't block the signal flow.
      }
    }

    setLoading(false)
    navigate(`/signal/${data.id}`)
  }

  return (
    <div className="px-4 lg:px-6 pt-6 pb-8 mx-auto lg:max-w-3xl w-full">
      <div className="flex items-center gap-3 mb-6">
        <button
          type="button"
          aria-label="Back"
          onClick={() => navigate(-1)}
          className="w-9 h-9 bg-card border border-border rounded-xl flex items-center justify-center text-zinc-400"
        >
          <ArrowLeft size={16} />
        </button>
        <div>
          <h1 className="text-white font-bold">Log Signal</h1>
          <p className="text-subtle text-xs">Step {step} of 4</p>
        </div>
      </div>

      <div className="flex gap-1 mb-6" aria-hidden="true">
        {[1, 2, 3, 4].map((s) => (
          <div
            key={s}
            className={clsx(
              'h-1 flex-1 rounded-full transition-colors',
              s <= step ? 'bg-red-500' : 'bg-zinc-800',
            )}
          />
        ))}
      </div>

      <div className={clsx('space-y-4', step !== 1 && 'hidden')}>
        <h2 className="text-white font-semibold">
          {isGexFlow ? 'Trade Setup' : 'Company & Catalyst'}
        </h2>

          {/* Ticker picker — opens TickerDrawer for typeahead over
              the curated universe (HOT + S&P 500). Free-text fallback
              via the drawer's "Use {QUERY}" button when the symbol
              isn't in the list (newly-IPO'd, OTC, etc.). */}
          <div>
            <label className="text-muted text-xs uppercase tracking-wider block mb-1">
              Ticker <span className="text-red-400">*</span>
            </label>
            <button
              type="button"
              onClick={() => setTickerDrawerOpen(true)}
              className="w-full bg-card border border-border rounded-lg px-3 py-2.5 text-left flex items-center justify-between hover:border-amber-400/40 transition-colors"
            >
              <span className={form.ticker ? 'text-fg font-mono-tab text-sm' : 'text-muted text-sm'}>
                {form.ticker || 'Tap to pick a ticker'}
              </span>
              <ChevronDown size={14} className="text-subtle shrink-0" />
            </button>
          </div>

          {!isGexFlow && (
            <>
              <Input
                label="Company Name"
                value={form.company_name}
                onChange={(v) => update('company_name', v)}
                placeholder="Acme Therapeutics"
                required
              />
              <Input
                label="Drug Name"
                value={form.drug_name}
                onChange={(v) => update('drug_name', v)}
                placeholder="ACM-101"
              />
              <Input
                label="Indication"
                value={form.indication}
                onChange={(v) => update('indication', v)}
                placeholder="Pancreatic Cancer"
              />

              <div>
                <label className="text-muted text-xs uppercase tracking-wider block mb-1">
                  Catalyst Type
                </label>
                <select
                  value={form.catalyst_type}
                  onChange={(e) => update('catalyst_type', e.target.value)}
                  className="w-full bg-card border border-border text-white rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-red-500"
                >
                  <option value="pdufa">PDUFA Date</option>
                  <option value="adcomm">AdComm Meeting</option>
                  <option value="phase2_readout">Phase 2 Readout</option>
                  <option value="phase3_readout">Phase 3 Readout</option>
                  <option value="enrollment_end">Enrollment End</option>
                  <option value="patent_expiry">Patent Expiry</option>
                  <option value="earnings">Earnings</option>
                  <option value="other">Other</option>
                </select>
              </div>

              <Input
                label="Catalyst Date"
                value={form.catalyst_date}
                onChange={(v) => {
                  // Manual edit overrides any prefilled precision —
                  // a date the user typed is a real day-precision date.
                  update('catalyst_date', v)
                  if (form.catalyst_date_precision !== 'day') {
                    update('catalyst_date_precision', 'day')
                  }
                }}
                type="date"
                min={today()}
                required
              />
            </>
          )}

          {isGexFlow && (
            <>
              <Input
                label="Spread Expiration"
                value={form.expiry_date}
                onChange={(v) => update('expiry_date', v)}
                type="date"
                min={today()}
                required
              />
              <p className="text-[11px] text-muted leading-relaxed -mt-2">
                For GEX-flow trades the spread expiry is the resolution date —
                no biotech catalyst is being timed. The expiry is mirrored to
                <span className="font-mono-tab"> catalyst_date </span>
                on the underlying record so calendar &amp; alerts still work.
              </p>
            </>
          )}

          {!isGexFlow && form.catalyst_date && form.catalyst_date < today() && (
            <p className="text-red-400 text-xs">Catalyst date must be today or later.</p>
          )}
          {!isGexFlow && form.catalyst_date_precision === 'month' && (
            <p className="text-yellow-400 text-xs leading-relaxed">
              ⚠ CT.gov has only confirmed the <span className="font-semibold">month</span> for this catalyst.
              The day above defaults to the 1st as a conservative earliest-possible placeholder.
              Verify the exact date with the company's press release or 8-K before locking —
              the signal hash will preserve whatever you set.
            </p>
          )}
          {!isGexFlow && form.catalyst_date_precision === 'year' && (
            <p className="text-yellow-400 text-xs leading-relaxed">
              ⚠ CT.gov has only confirmed the <span className="font-semibold">year</span> for this catalyst.
              The month and day above default to January 1st (earliest possible). Verify the exact
              date with the company before locking.
            </p>
          )}

          <div>
            <div className="flex items-baseline justify-between mb-1">
              <label className="text-muted text-xs uppercase tracking-wider">
                Strategy
              </label>
              {suggestedStructure && form.structure === suggestedStructure && (
                <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-400/15 text-amber-400 border border-amber-400/40">
                  Suggested
                </span>
              )}
              {suggestedStructure && form.structure !== suggestedStructure && (
                <span className="text-[10px] uppercase tracking-wider text-muted">
                  Modified from suggestion
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {STRATEGY_OPTIONS.map((opt) => {
                const active = form.structure === opt.structure
                const wasSuggested = suggestedStructure === opt.structure
                return (
                  <button
                    key={opt.structure}
                    type="button"
                    onClick={() => {
                      setForm((prev) => ({
                        ...prev,
                        direction: opt.direction,
                        structure: opt.structure,
                      }))
                    }}
                    className={clsx(
                      'relative py-2 rounded-xl border text-xs font-semibold transition-colors',
                      active ? opt.color : 'border-border text-subtle',
                    )}
                  >
                    {opt.label}
                    {wasSuggested && !active && (
                      <span
                        aria-hidden
                        className="absolute top-0.5 right-1 text-[10px] text-amber-400/70"
                      >
                        ★
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          <div>
            <label className="text-muted text-xs uppercase tracking-wider block mb-1">
              Trade Type
            </label>
            <div className="grid grid-cols-2 gap-2">
              {['paper', 'real'].map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => update('trade_type', t)}
                  className={clsx(
                    'py-2 rounded-xl border text-xs font-semibold transition-colors',
                    form.trade_type === t
                      ? 'border-red-500 bg-red-950/30 text-red-400'
                      : 'border-border text-subtle',
                  )}
                >
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            onClick={() => setStep(2)}
            disabled={!step1Valid}
            className="w-full bg-red-600 hover:bg-red-500 disabled:bg-red-950 disabled:text-red-900 text-white font-semibold rounded-xl py-3 text-sm transition-colors"
          >
            {isGexFlow ? 'Next: Strike & Thesis' : 'Next: Analyze Filing'}
          </button>
      </div>

      <div className={clsx('space-y-4', step !== 2 && 'hidden')}>
        <h2 className="text-white font-semibold">
          {isGexFlow ? 'Strike & Thesis' : 'Filing Analysis'}
        </h2>
          {!isGexFlow && (
            <p className="text-subtle text-xs">
              Paste public filing text for the AI analyst to score, or write your thesis manually.
              Analysis results will fill in your thesis only if it's empty.
            </p>
          )}
          {isGexFlow && (
            <p className="text-subtle text-xs">
              Verify the spread pricing in the calculator below, then confirm
              the GEX rationale that came in from the matrix. No filing
              analysis runs for index / ETF flow trades.
            </p>
          )}

          {!isGexFlow && (
            <AnalyzeFilingPanel
              ticker={form.ticker}
              companyName={form.company_name}
              drugName={form.drug_name}
              indication={form.indication}
              catalystType={form.catalyst_type}
              catalystDate={form.catalyst_date}
              catalystDatePrecision={form.catalyst_date_precision}
              analysis={analysis}
              onAnalysisComplete={handleAnalysisComplete}
              onAnalysisReset={() => {
                setAnalysis(null)
                clearDraftAnalysis(candidateId)
                deleteRemoteDraft(supabase, candidateId).catch(() => {})
              }}
            />
          )}

          {(isGexFlow ? form.expiry_date : form.catalyst_date) &&
            form.direction !== 'watch' && (
            <StrikePriceCalculator
              direction={form.direction}
              lockedStructure={form.structure}
              accountSize={profile?.account_size}
              initialStockPrice={form.stock_price_at_signal}
              initialBuyStrike={form.long_strike || undefined}
              initialSellStrike={form.short_strike || undefined}
              initialPremium={form.prefill_premium || undefined}
              initialExpiry={
                isGexFlow ? form.expiry_date : form.expiry_date || undefined
              }
              catalystDate={isGexFlow ? undefined : form.catalyst_date}
              buyStrikeOtmPct={analysis?.strike_suggestion?.buy_strike_pct_otm}
              sellStrikeOtmPct={analysis?.strike_suggestion?.sell_strike_pct_otm}
              onCalculationComplete={(calc) => {
                // Capture the calculator's authoritative result so the
                // open_positions row we auto-create on submit gets the
                // exact strikes/expiry/contracts/debit the user sized to.
                setForm((prev) => ({
                  ...prev,
                  long_strike: calc?.buyStrike ?? prev.long_strike,
                  short_strike: calc?.sellStrike ?? prev.sellStrike,
                  expiry_date: calc?.expiry || prev.expiry_date,
                  contracts:
                    calc?.contracts != null
                      ? String(calc.contracts)
                      : prev.contracts,
                  entry_price:
                    !prev.entry_price && calc?.premium
                      ? calc.premium
                      : prev.entry_price,
                }))
              }}
            />
          )}

          {/* POP input lives on step 2 alongside the calculator output
              so the user can dial in their entry probability while
              still looking at strikes / breakeven / max-loss. The
              field is the same hash-locked entry POP that appears on
              the step 4 confirmation summary; editing here is what
              feeds the verification modal at submit time. */}
          <div className="bg-card border border-border rounded-xl p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <p className="text-muted text-xs uppercase tracking-wider">
                  Entry POP
                  {form.entry_pop_bp != null && form.entry_pop_bp === prefilledPopBp && (
                    <span className="ml-2 text-[10px] text-green-400/80 font-semibold">
                      AUTO
                    </span>
                  )}
                </p>
                <p className="text-muted text-[11px] leading-snug mt-1">
                  Honest probability this trade hits its breakeven by
                  expiration. Locked into the v2 signal hash —
                  reviewable on the Confirm step.
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  value={
                    form.entry_pop_bp != null && Number.isFinite(Number(form.entry_pop_bp))
                      ? Math.round(Number(form.entry_pop_bp) / 100)
                      : ''
                  }
                  onChange={(e) => {
                    const raw = e.target.value
                    if (raw === '') {
                      update('entry_pop_bp', null)
                      return
                    }
                    const n = Math.round(Number(raw))
                    if (!Number.isFinite(n)) return
                    update('entry_pop_bp', Math.max(0, Math.min(100, n)) * 100)
                  }}
                  className="w-16 bg-bg-elev border border-border rounded-md px-2 py-1.5 text-right text-base font-mono-tab tabular-nums text-white focus:outline-none focus:border-amber-400/40"
                  placeholder="—"
                />
                <span className="text-subtle text-sm">%</span>
              </div>
            </div>
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setStep(1)}
              className="flex-1 bg-card border border-border text-zinc-400 font-semibold rounded-xl py-3 text-sm"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => setStep(3)}
              className="flex-1 bg-red-600 hover:bg-red-500 disabled:bg-red-950 disabled:text-red-900 text-white font-semibold rounded-xl py-3 text-sm transition-colors"
            >
              Next: Checklist
            </button>
          </div>
      </div>

      <div className={clsx('space-y-4', step !== 3 && 'hidden')}>
          <div>
            <h2 className="text-white font-semibold">Pre-Trade Checklist</h2>
            <p className="text-subtle text-xs mt-1">All 10 must be checked to proceed</p>
          </div>

          <div className="space-y-3">
            {CHECKLIST_ITEMS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => update(key, !form[key])}
                className={clsx(
                  'w-full flex items-start gap-3 p-3 rounded-xl border text-left transition-colors',
                  form[key] ? 'border-red-900/50 bg-red-950/20' : 'border-border bg-card',
                )}
                aria-pressed={form[key]}
              >
                <div
                  className={clsx(
                    'w-5 h-5 rounded flex items-center justify-center flex-shrink-0 mt-0.5',
                    form[key] ? 'bg-red-600' : 'border border-zinc-700',
                  )}
                >
                  {form[key] && <Check size={12} className="text-white" />}
                </div>
                <p className={clsx('text-sm', form[key] ? 'text-white' : 'text-subtle')}>
                  {label}
                </p>
              </button>
            ))}
          </div>

          <div className="flex items-center justify-between text-xs text-subtle">
            <span>{CHECKLIST_ITEMS.filter((i) => form[i.key]).length} of 10 checked</span>
            {checklistComplete && <span className="text-green-400">✓ Ready to log</span>}
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setStep(2)}
              className="flex-1 bg-card border border-border text-zinc-400 font-semibold rounded-xl py-3 text-sm"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => setStep(4)}
              disabled={!checklistComplete}
              className="flex-1 bg-red-600 hover:bg-red-500 disabled:bg-red-950 disabled:text-red-900 text-white font-semibold rounded-xl py-3 text-sm transition-colors"
            >
              Next: Confirm
            </button>
          </div>
      </div>

      <div className={clsx('space-y-4', step !== 4 && 'hidden')}>
        <h2 className="text-white font-semibold">Confirm Signal</h2>

          <div className="bg-card border border-border rounded-xl p-4 space-y-3">
            <Row label="Ticker" value={form.ticker} />
            {!isGexFlow && <Row label="Company" value={form.company_name} />}
            {isGexFlow && <Row label="Source" value="GEX Flow Trade" />}
            <Row label="Direction" value={directionLabelLong(form.direction)} highlight />
            <Row label="Structure" value={form.structure.replace(/_/g, ' ').toUpperCase()} />
            <Row
              label={isGexFlow ? 'Expiration' : 'Catalyst'}
              value={isGexFlow ? form.expiry_date : form.catalyst_date}
            />
            <Row label="Type" value={form.trade_type.toUpperCase()} />
            <Row label="Confidence" value={`${form.confidence_score}/10`} />
            <PopRow
              valueBp={form.entry_pop_bp}
              prefilledBp={prefilledPopBp}
              onChange={(v) => update('entry_pop_bp', v)}
            />
          </div>

          <div className="bg-card border border-border rounded-xl p-4">
            <p className="text-muted text-[10px] uppercase tracking-wider mb-2">Thesis</p>
            <p className="text-zinc-300 text-sm leading-relaxed whitespace-pre-wrap">
              {form.thesis}
            </p>
          </div>

          <div className="bg-yellow-950/20 border border-yellow-900/40 rounded-xl p-4">
            <p className="text-yellow-400 text-xs font-semibold mb-1">⚠ Immutable Record</p>
            <p className="text-subtle text-xs">
              Once logged, your thesis, direction, catalyst date, and signal hash cannot be changed.
              This is by design — your track record must be tamper-proof. To retract a signal, set
              its status to <span className="text-white">dismissed</span>.
            </p>
          </div>

          {submitError && (
            <div className="bg-red-950/30 border border-red-900/50 rounded-lg p-3">
              <p className="text-red-400 text-xs" role="alert">
                {submitError}
              </p>
            </div>
          )}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setStep(3)}
              className="flex-1 bg-card border border-border text-zinc-400 font-semibold rounded-xl py-3 text-sm"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => {
                // POP changed from prefill OR was set fresh by the user
                // → fire the verification modal. Untouched auto-POPs
                // skip the modal (deterministic math, nothing to verify).
                const submittedPop = form.entry_pop_bp ?? null
                const userModifiedPop = submittedPop !== prefilledPopBp
                if (submittedPop != null && userModifiedPop) {
                  setPopVerifyOpen(true)
                } else {
                  submitSignal()
                }
              }}
              disabled={loading}
              className="flex-1 bg-red-600 hover:bg-red-500 disabled:bg-red-900 text-white font-semibold rounded-xl py-3 text-sm transition-colors"
            >
              {loading ? 'Logging…' : '🔒 Lock & Log Signal'}
            </button>
          </div>
      </div>

      <PopVerificationModal
        open={popVerifyOpen}
        popBp={form.entry_pop_bp}
        onCancel={() => setPopVerifyOpen(false)}
        onConfirm={() => {
          setPopVerifyOpen(false)
          submitSignal()
        }}
      />

      <TickerDrawer
        open={tickerDrawerOpen}
        onClose={() => setTickerDrawerOpen(false)}
        curated={TICKER_UNIVERSE}
        watchlist={[]}
        gatedSet={new Set()}
        selected={form.ticker}
        onSelect={(sym) => update('ticker', sym.toUpperCase())}
        allowCustom={true}
      />
    </div>
  )
}

// Returns days remaining in the 90-day paper-trading window. 0 if the
// user is past the window (or hasn't started — the Dashboard widget
// stamps paper_trading_started_at on first render).
// Auto-generated thesis when the user didn't type one. The DB column
// is NOT NULL, but typed-thesis copy adds no signal for GEX-flow
// trades — the structure + ticker + expiration captures the bet
// completely. This produces a deterministic, machine-readable string
// that can later be re-parsed if needed.
function autoThesis(form, ticker) {
  const structure = (form.structure || '').replace(/_/g, ' ')
  const target = form.expiry_date || form.catalyst_date || ''
  if (form.signal_source === 'gex_flow') {
    return `GEX-flow ${structure} on ${ticker} · expires ${target}`
  }
  return `${ticker} ${form.catalyst_type || 'event'} catalyst on ${target}`
}

function paperDaysRemaining(startedAt) {
  if (!startedAt) return 0
  const start = new Date(`${startedAt}T00:00:00Z`).getTime()
  const elapsed = (Date.now() - start) / 86_400_000
  return Math.max(0, Math.ceil(90 - elapsed))
}

function Input({ label, value, onChange, placeholder, type = 'text', required, min, inputMode }) {
  return (
    <div>
      <label className="text-muted text-xs uppercase tracking-wider block mb-1">
        {label}
        {required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        min={min}
        inputMode={inputMode || (type === 'number' ? 'decimal' : undefined)}
        className="w-full bg-card border border-border text-white placeholder-zinc-700 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-red-500 transition-colors"
      />
    </div>
  )
}

function Row({ label, value, highlight }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <p className="text-subtle text-xs">{label}</p>
      <p className={clsx('text-xs font-semibold text-right', highlight ? 'text-red-400' : 'text-white')}>
        {value}
      </p>
    </div>
  )
}

// Entry POP input row. Editable for everyone — the user can override
// an auto-computed value (e.g. they think the chain's IV is unreliable
// and want to use their own probability) or supply one fresh on a
// manual log. Validation: integer 0-100. Stored as basis points
// (×100) so the integer never has a decimal point in the hash payload.
//
// "Auto" badge appears when the value matches what came in from prefill
// AND prefill is non-null — signals "we computed this from the chain;
// you can change it if you disagree." Once the user types a new value,
// the badge disappears, marking it as their judgement.
function PopRow({ valueBp, prefilledBp, onChange }) {
  const valuePct =
    valueBp != null && Number.isFinite(Number(valueBp))
      ? Math.round(Number(valueBp) / 100)
      : ''
  const isAuto = prefilledBp != null && valueBp === prefilledBp
  return (
    <div className="flex items-start justify-between gap-4 pt-1">
      <div className="flex-1">
        <p className="text-subtle text-xs">
          Entry POP
          {isAuto && (
            <span className="ml-2 text-[10px] uppercase tracking-wider text-green-400/80">
              Auto
            </span>
          )}
        </p>
        <p className="text-muted text-[10px] leading-snug mt-0.5">
          Locked into the v2 signal hash. Honest probability that this
          trade hits its breakeven by expiration.
        </p>
      </div>
      <div className="flex items-center gap-1">
        <input
          type="number"
          min="0"
          max="100"
          step="1"
          value={valuePct}
          onChange={(e) => {
            const raw = e.target.value
            if (raw === '') {
              onChange(null)
              return
            }
            const n = Math.round(Number(raw))
            if (!Number.isFinite(n)) return
            const clamped = Math.max(0, Math.min(100, n))
            onChange(clamped * 100)
          }}
          className="w-14 bg-bg-elev border border-border rounded-md px-2 py-1 text-right text-sm font-mono-tab tabular-nums text-white focus:outline-none focus:border-amber-400/40"
          placeholder="—"
        />
        <span className="text-subtle text-xs">%</span>
      </div>
    </div>
  )
}

// Verification modal — fires before submit when the user has manually
// entered or modified the entry POP. The hash chain only carries
// credibility if the user explicitly accepts the number they're
// locking. Untouched auto-computed values skip this modal (the
// lognormal math is deterministic, nothing to verify).
function PopVerificationModal({ open, popBp, onCancel, onConfirm }) {
  const pct = popBp != null ? Math.round(Number(popBp) / 100) : '—'
  return (
    <Modal open={open} onClose={onCancel} ariaLabel="Verify entry POP">
      <div>
        <p className="text-amber-400 text-[10px] uppercase tracking-wider font-semibold">
          Verify entry POP
        </p>
        <h2 className="text-white text-lg font-semibold mt-1">
          Lock {pct}% into the public record?
        </h2>
      </div>
      <p className="text-subtle text-sm leading-relaxed">
        This number is part of the SHA-256 signal hash — once
        submitted it can't be revised. It will appear on your
        public track record at <span className="font-mono text-zinc-300">/r/:slug</span>{' '}
        alongside the actual outcome, and rolls into your
        calibration stats on the Record page.
      </p>
      <p className="text-muted text-xs leading-relaxed">
        Confirm <span className="text-white font-semibold">{pct}%</span>{' '}
        reflects your honest entry-time probability that this trade
        hits its breakeven. If you're unsure, cancel and revise.
      </p>
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="tap-spring flex-1 bg-card border border-border text-subtle font-semibold rounded-xl py-2.5 text-sm hover:text-fg"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="tap-spring flex-1 bg-amber-400 hover:bg-amber-300 text-bg font-semibold rounded-xl py-2.5 text-sm"
        >
          Lock {pct}% &amp; submit
        </button>
      </div>
    </Modal>
  )
}
