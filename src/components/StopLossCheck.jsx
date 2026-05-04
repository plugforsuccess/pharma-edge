import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import clsx from 'clsx'

// Manual decision tool. The audit trail is a row in the alerts table
// (alert_type='stop_loss_triggered', sent_via='in_app') so the decision
// is permanently recorded without inventing a new table.

const DECISIONS = [
  {
    value: 'exit_new_data',
    label: 'Yes — thesis changed',
    sub: 'Exit immediately. New data broke the trade.',
    color: 'border-red-500 bg-red-950/30 text-red-400',
    summary: 'Exited: new data invalidated thesis',
  },
  {
    value: 'hold',
    label: 'No — thesis intact',
    sub: 'You may hold. You must document why.',
    color: 'border-yellow-500 bg-yellow-950/30 text-yellow-400',
    summary: null, // requires justification
  },
  {
    value: 'exit_rule',
    label: 'Exit — follow the rule',
    sub: 'Rule says exit. Discipline over emotion.',
    color: 'border-green-500 bg-green-950/30 text-green-400',
    summary: 'Exited: rule discipline at -50%',
  },
]

export default function StopLossCheck({ signal }) {
  const { user } = useAuth()
  const [open, setOpen] = useState(false)
  const [decision, setDecision] = useState(null)
  const [justification, setJustification] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full flex items-center justify-center gap-2 bg-yellow-950/20 border border-yellow-900/40 hover:border-yellow-500
                   text-yellow-400 font-semibold rounded-xl py-3 text-sm mb-4 transition-colors"
      >
        <AlertTriangle size={14} />
        Stop Loss Decision Tool
      </button>
    )
  }

  if (saved) {
    return (
      <div className="bg-card border border-border rounded-xl p-4 text-center mb-4">
        <p className="text-green-400 text-sm">Decision logged ✓</p>
        <p className="text-muted text-xs mt-1">See it under your alerts history.</p>
      </div>
    )
  }

  async function saveDecision() {
    if (!decision) return
    if (decision === 'hold' && !justification.trim()) return

    setError('')
    setSaving(true)

    const decisionMeta = DECISIONS.find((d) => d.value === decision)
    const message =
      decision === 'hold'
        ? `Held through stop-loss trigger. Justification: ${justification.trim()}`
        : decisionMeta?.summary || decision

    const { error: insertError } = await supabase.from('alerts').insert({
      user_id: user.id,
      signal_id: signal.id,
      alert_type: 'stop_loss_triggered',
      sent_via: 'in_app',
      message,
    })

    setSaving(false)
    if (insertError) {
      setError(insertError.message)
      return
    }
    setSaved(true)
  }

  return (
    <div className="bg-yellow-950/20 border border-yellow-900/40 rounded-xl p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <AlertTriangle size={16} className="text-yellow-400" />
          <h3 className="text-yellow-400 font-semibold text-sm">Stop Loss Decision</h3>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-muted text-xs hover:text-zinc-400"
        >
          Close
        </button>
      </div>

      <p className="text-zinc-400 text-xs mb-1">
        Use this when your option is down <span className="text-red-400 font-bold">-50%</span>.
        Your rule says exit at that threshold.
      </p>
      <p className="text-subtle text-xs mb-4">Before deciding, answer this honestly:</p>

      <p className="text-white text-sm font-semibold mb-3">
        Has new information emerged that changes your thesis?
      </p>

      <div className="space-y-2 mb-4">
        {DECISIONS.map((d) => (
          <button
            key={d.value}
            type="button"
            onClick={() => setDecision(d.value)}
            className={clsx(
              'w-full text-left px-4 py-3 rounded-xl border text-sm transition-colors',
              decision === d.value ? d.color : 'border-border bg-card text-zinc-400',
            )}
          >
            <span className="font-semibold">{d.label}</span>
            <p className="text-xs text-muted mt-0.5">{d.sub}</p>
          </button>
        ))}
      </div>

      {decision === 'hold' && (
        <div className="mb-4">
          <label className="text-muted text-xs uppercase tracking-wider block mb-1">
            Why are you holding? (required)
          </label>
          <textarea
            value={justification}
            onChange={(e) => setJustification(e.target.value)}
            placeholder="Specific reason thesis is still intact despite -50% move…"
            rows={3}
            className="w-full bg-bg border border-yellow-900/50 text-white placeholder-zinc-700 rounded-xl px-4 py-3 text-sm focus:outline-none resize-none"
          />
          <p className="text-muted text-[10px] mt-1">
            Permanently recorded as an in-app alert.
          </p>
        </div>
      )}

      {error && (
        <div className="bg-red-950/30 border border-red-900/50 rounded-lg p-3 mb-3">
          <p className="text-red-400 text-xs" role="alert">
            {error}
          </p>
        </div>
      )}

      {decision && (
        <button
          type="button"
          onClick={saveDecision}
          disabled={saving || (decision === 'hold' && !justification.trim())}
          className="w-full bg-red-600 hover:bg-red-500 disabled:bg-red-950 disabled:text-red-900 text-white font-semibold rounded-xl py-3 text-sm transition-colors"
        >
          {saving ? 'Saving…' : 'Confirm Decision & Log'}
        </button>
      )}
    </div>
  )
}
