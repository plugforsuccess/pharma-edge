import { Lock, ArrowRight } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

// Subtle CTA shown inline where free-tier users hit a wall. Routes to
// /settings (which is where Stripe checkout will live once wired). For
// now /settings has the upgrade copy; clicking through doesn't charge.
//
// Keep this tight — bigger gating UI fights the workflow. One line +
// one button is enough.

export default function UpgradeNotice({
  message = 'Pro unlocks the full feature.',
  cta = 'Upgrade',
}) {
  const navigate = useNavigate()
  return (
    <div className="bg-card border border-amber-400/30 rounded-lg p-3 flex items-center gap-3">
      <Lock size={16} className="text-amber-400 shrink-0" />
      <div className="flex-1 text-xs text-fg leading-relaxed">{message}</div>
      <button
        onClick={() => navigate('/settings')}
        className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-amber-400 text-bg text-xs font-semibold hover:bg-amber-300 transition"
      >
        {cta}
        <ArrowRight size={12} />
      </button>
    </div>
  )
}
