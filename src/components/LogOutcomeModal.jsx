import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import clsx from 'clsx'

// Outcome categories for GEX/options-flow spread trades. The biotech
// list (FDA Approved / Trial Data / etc.) was retired alongside the
// biotech-catalyst pipeline on 2026-05-09 but the modal kept
// rendering them — fixed here.
//
// Each entry carries its OWN `thesis_correct` value rather than
// inferring through a per-direction `positive` flag like the old
// list did. The old flag (was-spot-up = was-thesis-right-if-bullish)
// doesn't map cleanly to outcomes like "regime flipped" or
// "vol crush" where direction isn't the dispositive question.
// thesis_correct stays nullable so the user can override on the
// confirmation step before submitting.
//
// `catalyst_result` is the DB column (free-form text). Historical
// biotech values stay readable; new rows use the values below.
const SPREAD_OUTCOMES = [
  { value: 'wall_held',              label: 'Wall held / pin succeeded',          thesisCorrect: true },
  { value: 'target_broken_in_favor', label: 'Target wall broken (favorable)',     thesisCorrect: true },
  { value: 'profit_target_hit',      label: 'Profit target hit (per playbook)',   thesisCorrect: true },
  { value: 'wall_broken_against',    label: 'Wall broke against thesis',          thesisCorrect: false },
  { value: 'stop_loss',              label: 'Stop loss triggered',                thesisCorrect: false },
  { value: 'regime_flipped',         label: 'Regime flipped mid-trade',           thesisCorrect: false },
  { value: 'theta_decay',            label: "Theta decay (spot didn't move)",     thesisCorrect: null },
  { value: 'vol_crush',              label: 'Vol crush',                          thesisCorrect: null },
  { value: 'other',                  label: 'Other',                              thesisCorrect: null },
]

const EXIT_REASONS = [
  { value: 'catalyst_resolved', label: 'Catalyst resolved — natural exit' },
  { value: 'stop_loss_50pct', label: 'Stop loss triggered (-50%)' },
  { value: 'thesis_invalidated', label: 'Thesis invalidated by new data' },
  { value: 'profit_100pct', label: 'Profit target hit (+100%)' },
  { value: 'profit_200pct', label: 'Profit target hit (+200%)' },
  { value: 'pre_catalyst_exit', label: 'Pre-catalyst exit (day before)' },
  { value: 'dte_expired', label: 'DTE expired' },
  { value: 'manual', label: 'Manual exit' },
]

export default function LogOutcomeModal({ signal, prefill, onClose, onComplete }) {
  const { user } = useAuth()
  const [loading, setLoading] = useState(false)
  // Step 0 is the new "auto-derived review" screen — one-tap confirm
  // or edit-details escape hatch into the existing 3-step flow.
  // Modal opens on step 0 when a prefill was passed in; otherwise
  // step 1 (the legacy manual flow) as before.
  const [step, setStep] = useState(prefill ? 0 : 1)
  const [error, setError] = useState('')

  const [form, setForm] = useState({
    catalyst_result: prefill?.catalyst_result ?? '',
    stock_price_at_outcome: '',
    option_price_at_outcome: '',
    exit_price: prefill?.exit_price != null ? String(prefill.exit_price.toFixed(2)) : '',
    pnl_dollars: prefill?.pnl_dollars != null ? String(prefill.pnl_dollars.toFixed(2)) : '',
    pnl_percent: prefill?.pnl_percent != null ? String(prefill.pnl_percent.toFixed(2)) : '',
    thesis_correct: prefill?.thesis_correct ?? null,
    exit_reason: prefill?.exit_reason ?? '',
    rules_followed: prefill?.rules_followed ?? true,
    rules_broken: '',
    post_trade_notes: '',
  })

  // Lock body scroll + add Escape-to-close while open.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  function update(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function selectCatalystResult(result) {
    // SPREAD_OUTCOMES entries carry an explicit `thesisCorrect`
    // (true / false / null) so we don't have to map through a
    // direction-aware truth table the way the biotech list did.
    setForm((prev) => ({
      ...prev,
      catalyst_result: result.value,
      thesis_correct: result.thesisCorrect ?? null,
    }))
  }

  async function submitOutcome() {
    setError('')
    setLoading(true)

    const num = (v) => (v === '' || v == null ? null : Number(v))
    const outcomeData = {
      signal_id: signal.id,
      user_id: user.id,
      catalyst_result: form.catalyst_result,
      stock_price_at_outcome: num(form.stock_price_at_outcome),
      option_price_at_outcome: num(form.option_price_at_outcome),
      exit_price: num(form.exit_price),
      pnl_dollars: num(form.pnl_dollars),
      pnl_percent: num(form.pnl_percent),
      thesis_correct: form.thesis_correct ?? false,
      exit_reason: form.exit_reason || null,
      rules_followed: form.rules_followed,
      rules_broken: form.rules_followed ? null : form.rules_broken || null,
      post_trade_notes: form.post_trade_notes || null,
      // outcome_hash and recorded_at intentionally omitted: DB trigger
      // computes the canonical hash and recorded_at defaults to NOW().
    }

    const { error: insertError } = await supabase.from('outcomes').insert(outcomeData)
    if (insertError) {
      setLoading(false)
      // Postgres unique_violation = 23505 (outcomes_signal_unique).
      if (insertError.code === '23505') {
        setError('This signal already has an outcome logged. Outcomes are write-once.')
      } else {
        setError(insertError.message)
      }
      return
    }

    const { error: updateError } = await supabase
      .from('signals')
      .update({ status: 'closed' })
      .eq('id', signal.id)
      .eq('user_id', user.id)

    setLoading(false)
    if (updateError) {
      setError(`Outcome saved, but failed to close signal: ${updateError.message}`)
      return
    }
    onComplete?.()
  }

  return (
    <div
      className="fixed inset-0 bg-black/80 z-[60] flex items-end justify-center"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Log outcome"
    >
      <div
        className="bg-bg border-t border-border rounded-t-2xl w-full max-w-md max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-10 h-1 bg-zinc-700 rounded-full mx-auto mt-3 mb-4" aria-hidden="true" />

        <div className="px-4 pb-8" style={{ paddingBottom: 'calc(2rem + env(safe-area-inset-bottom))' }}>
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-white font-bold">Log Outcome</h2>
              <p className="text-subtle text-xs">
                {signal.ticker} — {(signal.structure ?? signal.direction ?? '').replace(/_/g, ' ').toUpperCase()}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="text-subtle hover:text-white"
            >
              <X size={18} />
            </button>
          </div>

          {step > 0 && (
            <div className="flex gap-1 mb-6" aria-hidden="true">
              {[1, 2, 3].map((s) => (
                <div
                  key={s}
                  className={clsx(
                    'h-1 flex-1 rounded-full',
                    s <= step ? 'bg-red-500' : 'bg-zinc-800',
                  )}
                />
              ))}
            </div>
          )}

          {step === 0 && prefill && (
            <AutoReviewScreen
              prefill={prefill}
              form={form}
              signal={signal}
              onPostTradeNotes={(v) => setForm((p) => ({ ...p, post_trade_notes: v }))}
              onEdit={() => setStep(1)}
              onConfirm={submitOutcome}
              loading={loading}
              error={error}
            />
          )}

          {step === 1 && (
            <div className="space-y-4">
              <h3 className="text-white text-sm font-semibold">What happened?</h3>

              <div className="space-y-2">
                {SPREAD_OUTCOMES.map((result) => (
                  <button
                    key={result.value}
                    type="button"
                    onClick={() => selectCatalystResult(result)}
                    className={clsx(
                      'w-full text-left px-4 py-3 rounded-xl border text-sm transition-colors',
                      form.catalyst_result === result.value
                        ? 'border-red-500 bg-red-950/30 text-white'
                        : 'border-border bg-card text-zinc-400',
                    )}
                  >
                    {result.label}
                  </button>
                ))}
              </div>

              {form.catalyst_result && form.thesis_correct !== null && (
                <div
                  className={clsx(
                    'rounded-xl p-3 border',
                    form.thesis_correct
                      ? 'bg-green-950/20 border-green-900/40'
                      : 'bg-red-950/20 border-red-900/40',
                  )}
                >
                  <p
                    className={clsx(
                      'text-sm font-semibold',
                      form.thesis_correct ? 'text-green-400' : 'text-red-400',
                    )}
                  >
                    {form.thesis_correct ? '✓ Thesis Correct' : '✗ Thesis Wrong'}
                  </p>
                </div>
              )}

              <button
                type="button"
                onClick={() => setStep(2)}
                disabled={!form.catalyst_result}
                className="w-full bg-red-600 hover:bg-red-500 disabled:bg-red-950 disabled:text-red-900 text-white font-semibold rounded-xl py-3 text-sm transition-colors"
              >
                Next: P&amp;L Details
              </button>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <h3 className="text-white text-sm font-semibold">P&amp;L Details</h3>

              <NumberInput
                label="Stock Price at Outcome"
                value={form.stock_price_at_outcome}
                onChange={(v) => update('stock_price_at_outcome', v)}
                prefix="$"
              />
              <NumberInput
                label="Option Price at Outcome"
                value={form.option_price_at_outcome}
                onChange={(v) => update('option_price_at_outcome', v)}
                prefix="$"
              />
              <NumberInput
                label="Your Exit Price"
                value={form.exit_price}
                onChange={(v) => update('exit_price', v)}
                prefix="$"
              />
              <NumberInput
                label="P&L ($)"
                value={form.pnl_dollars}
                onChange={(v) => update('pnl_dollars', v)}
                prefix="$"
              />
              <NumberInput
                label="P&L (%)"
                value={form.pnl_percent}
                onChange={(v) => update('pnl_percent', v)}
                suffix="%"
              />

              <div>
                <label className="text-muted text-xs uppercase tracking-wider block mb-1">
                  Exit Reason
                </label>
                <select
                  value={form.exit_reason}
                  onChange={(e) => update('exit_reason', e.target.value)}
                  className="w-full bg-card border border-border text-white rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-red-500"
                >
                  <option value="">Select exit reason</option>
                  {EXIT_REASONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
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
                  className="flex-1 bg-red-600 hover:bg-red-500 text-white font-semibold rounded-xl py-3 text-sm transition-colors"
                >
                  Next: Rules
                </button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <h3 className="text-white text-sm font-semibold">Did you follow your rules?</h3>
              <p className="text-subtle text-xs">
                Permanently recorded. Be honest — the data only helps you if it's accurate.
              </p>

              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => {
                    update('rules_followed', true)
                    update('rules_broken', '')
                  }}
                  className={clsx(
                    'py-4 rounded-xl border font-semibold text-sm transition-colors',
                    form.rules_followed === true
                      ? 'border-green-500 bg-green-950/30 text-green-400'
                      : 'border-border bg-card text-subtle',
                  )}
                >
                  ✓ Yes, followed rules
                </button>
                <button
                  type="button"
                  onClick={() => update('rules_followed', false)}
                  className={clsx(
                    'py-4 rounded-xl border font-semibold text-sm transition-colors',
                    form.rules_followed === false
                      ? 'border-red-500 bg-red-950/30 text-red-400'
                      : 'border-border bg-card text-subtle',
                  )}
                >
                  ✗ Broke a rule
                </button>
              </div>

              {form.rules_followed === false && (
                <div>
                  <label className="text-muted text-xs uppercase tracking-wider block mb-1">
                    Which rule did you break?
                  </label>
                  <textarea
                    value={form.rules_broken}
                    onChange={(e) => update('rules_broken', e.target.value)}
                    placeholder="Be specific. What rule did you break and why?"
                    rows={3}
                    className="w-full bg-card border border-red-900 text-white placeholder-zinc-700 rounded-xl px-4 py-3 text-sm focus:outline-none resize-none"
                  />
                </div>
              )}

              <div>
                <label className="text-muted text-xs uppercase tracking-wider block mb-1">
                  Post-Trade Notes (optional)
                </label>
                <textarea
                  value={form.post_trade_notes}
                  onChange={(e) => update('post_trade_notes', e.target.value)}
                  placeholder="What did you learn? What would you do differently?"
                  rows={3}
                  className="w-full bg-card border border-border text-white placeholder-zinc-700 rounded-xl px-4 py-3 text-sm focus:outline-none resize-none"
                />
              </div>

              {error && (
                <div className="bg-red-950/30 border border-red-900/50 rounded-lg p-3">
                  <p className="text-red-400 text-xs" role="alert">
                    {error}
                  </p>
                </div>
              )}

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
                  onClick={submitOutcome}
                  disabled={loading || (form.rules_followed === false && !form.rules_broken.trim())}
                  className="flex-1 bg-red-600 hover:bg-red-500 disabled:bg-red-950 disabled:text-red-900 text-white font-semibold rounded-xl py-3 text-sm transition-colors"
                >
                  {loading ? 'Saving…' : '🔒 Lock Outcome'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function NumberInput({ label, value, onChange, prefix, suffix }) {
  return (
    <div>
      <label className="text-muted text-xs uppercase tracking-wider block mb-1">{label}</label>
      <div className="relative">
        {prefix && (
          <span className="absolute left-4 top-1/2 -translate-y-1/2 text-subtle text-sm">
            {prefix}
          </span>
        )}
        <input
          type="number"
              inputMode="decimal"
          step="any"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={clsx(
            'w-full bg-card border border-border text-white rounded-xl py-3 text-sm focus:outline-none focus:border-red-500',
            prefix ? 'pl-8 pr-4' : suffix ? 'pl-4 pr-8' : 'px-4',
          )}
        />
        {suffix && (
          <span className="absolute right-4 top-1/2 -translate-y-1/2 text-subtle text-sm">
            {suffix}
          </span>
        )}
      </div>
    </div>
  )
}

// One-tap confirm screen. Renders when the OutcomeInbox handed us a
// prefill payload — i.e. the system reconstructed everything from
// order_history + auto_triggers and just needs the user to confirm
// (and optionally add a "lessons learned" note before locking).
//
// Falls through to the legacy 3-step manual flow when the user taps
// "Edit details" (sets step=1 in the parent).
function AutoReviewScreen({ prefill, form, signal, onPostTradeNotes, onEdit, onConfirm, loading, error }) {
  const labelByCategory = {
    wall_held: 'Wall held / pin succeeded',
    target_broken_in_favor: 'Target wall broken (favorable)',
    profit_target_hit: 'Profit target hit',
    wall_broken_against: 'Wall broke against thesis',
    stop_loss: 'Stop loss triggered',
    regime_flipped: 'Regime flipped mid-trade',
    theta_decay: "Theta decay (spot didn't move)",
    vol_crush: 'Vol crush',
    other: 'Other',
  }
  const category = labelByCategory[prefill.catalyst_result] ?? prefill.catalyst_result
  const pnlPositive = (prefill.pnl_dollars ?? 0) >= 0
  const pnlTone = pnlPositive ? 'text-green-400' : 'text-crimson'
  const trigKind = prefill._meta?.triggered_by_kind
  const isAutoClose = prefill.exit_reason === 'auto_trigger'

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-white text-sm font-semibold mb-1">Confirm outcome</h3>
        <p className="text-[11px] text-subtle leading-relaxed">
          {isAutoClose
            ? `Auto-derived from your ${trigKind?.replace(/_/g, ' ') ?? 'auto-trigger'} close + broker fills. Tap confirm to lock, or edit if anything's off.`
            : 'Auto-derived from your broker close fills. Pick a category and tap confirm.'}
        </p>
      </div>

      <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl divide-y divide-zinc-800">
        <Row label="What happened" value={category} />
        <Row
          label="Thesis correct"
          value={
            prefill.thesis_correct === true ? '✓ Yes' :
            prefill.thesis_correct === false ? '✗ No' :
            '—'
          }
          tone={prefill.thesis_correct === true ? 'text-green-400' : prefill.thesis_correct === false ? 'text-crimson' : 'text-subtle'}
        />
        {Number.isFinite(prefill.pnl_dollars) && (
          <Row
            label="Realized P&L"
            value={`${pnlPositive ? '+' : ''}$${Math.abs(prefill.pnl_dollars).toFixed(0)}${
              Number.isFinite(prefill.pnl_percent)
                ? ` (${pnlPositive ? '+' : ''}${prefill.pnl_percent.toFixed(0)}%)`
                : ''
            }`}
            tone={pnlTone}
          />
        )}
        {Number.isFinite(prefill.exit_price) && (
          <Row label="Avg exit price" value={`$${prefill.exit_price.toFixed(2)}`} />
        )}
        {prefill._meta?.total_contracts_closed > 0 && (
          <Row
            label="Contracts closed"
            value={`${prefill._meta.total_contracts_closed} of ${prefill._meta.original_contracts}`}
          />
        )}
        {prefill.rules_followed === true && (
          <Row label="Rules followed" value="✓ All 10 attested at entry" tone="text-green-400" />
        )}
      </div>

      <label className="block">
        <span className="text-[11px] uppercase tracking-wider text-muted mb-1.5 inline-block">
          Lessons learned (optional)
        </span>
        <textarea
          rows={3}
          value={form.post_trade_notes}
          onChange={(e) => onPostTradeNotes(e.target.value)}
          placeholder="What worked, what didn't, anything to remember next time…"
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-fg placeholder:text-muted focus:outline-none focus:border-amber-400/40"
        />
      </label>

      {error && (
        <div className="text-xs text-crimson">{error}</div>
      )}

      <div className="flex gap-2 pt-1">
        <button
          onClick={onConfirm}
          disabled={loading}
          className="flex-1 bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-bg font-semibold text-sm rounded-lg py-3 transition"
        >
          {loading ? 'Locking…' : 'Confirm + Lock'}
        </button>
        <button
          onClick={onEdit}
          disabled={loading}
          className="flex-1 border border-zinc-700 text-subtle hover:text-fg disabled:opacity-50 text-sm font-medium rounded-lg py-3 transition"
        >
          Edit details
        </button>
      </div>
    </div>
  )
}

function Row({ label, value, tone = 'text-fg' }) {
  return (
    <div className="px-3 py-2 flex items-baseline justify-between gap-3">
      <span className="text-[11px] uppercase tracking-wider text-muted">{label}</span>
      <span className={clsx('text-sm font-medium text-right', tone)}>{value}</span>
    </div>
  )
}
