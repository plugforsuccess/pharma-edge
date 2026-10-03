import { X } from 'lucide-react'
import { blended1256Rate } from '../utils/afterTax'

// Estimated tax rates: long-term, short-term and the §1256 blend, each
// with its federal + NIIT + state parts. In the Portfolio's "View rates"
// modal (with a close button) and inline on Taxes (without).
const ratePct = (n) => (Number.isFinite(n) ? `${+(n * 100).toFixed(2)}%` : '—')

export default function RateBreakdown({ rates, state, taxYear, show1256, onClose }) {
  const rows = [
    ['Long-term (held > 1 yr)', rates.long_term],
    ['Short-term', rates.short_term],
  ]
  const blend = blended1256Rate(rates)
  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <h2 className={onClose ? 'text-base font-semibold' : 'text-sm font-semibold'}>Estimated tax rate</h2>
        <span className="flex-1" />
        <span className="text-xs text-muted">{taxYear}</span>
        {onClose && <button type="button" onClick={onClose} aria-label="Close"
          className="-mr-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded text-subtle hover:text-fg">
          <X size={16} />
        </button>}
      </div>
      <div className="space-y-4">
        {rows.map(([label, r]) => (
          <div key={label}>
            <div className="flex items-baseline gap-2 text-sm">
              <span className="text-subtle flex-1">{label}</span>
              <span className="font-mono-tab text-fg font-semibold">{ratePct(r.total)}</span>
            </div>
            <div className="mt-1 text-xs text-muted font-mono-tab">
              {r.overridden
                ? 'CPA-provided rate (override)'
                : `${ratePct(r.federal)} federal + ${ratePct(r.niit)} NIIT + ${ratePct(r.state)} ${state?.state_code ?? 'state'} = ${ratePct(r.total)}`}
            </div>
          </div>
        ))}
        {show1256 && (
          <div>
            <div className="flex items-baseline gap-2 text-sm">
              <span className="text-subtle flex-1">Index options (§1256)</span>
              <span className="font-mono-tab text-fg font-semibold">{ratePct(blend)}</span>
            </div>
            <div className="mt-1 text-xs text-muted font-mono-tab">
              60% × {ratePct(rates.long_term.total)} + 40% × {ratePct(rates.short_term.total)} = {ratePct(blend)} · any holding period
            </div>
          </div>
        )}
      </div>
      {state?.confidence === 'low' && (
        <p className="mt-4 text-xs text-amber-200/90">
          These residency figures are flagged for review — consider entering a CPA rate in Settings.
        </p>
      )}
    </div>
  )
}
