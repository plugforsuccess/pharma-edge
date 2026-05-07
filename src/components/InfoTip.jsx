import { useState } from 'react'
import { Info } from 'lucide-react'
import clsx from 'clsx'

// Mobile-first tooltip. The native HTML `title=` attribute doesn't
// work on touch devices — and 60%+ of Cash Moves traffic is mobile —
// so abstract concepts (calibration delta, dominant gamma, hash chain)
// need an explicit tap-to-explain affordance.
//
// Pattern: a small i-icon next to a non-obvious label. Tap shows a
// popover with the explanation; tap outside (or the icon again) closes.
// On desktop, hover behaves the same way for parity. The popover
// renders absolute-positioned below the icon by default; if it would
// overflow viewport-right, the parent should set `align="right"`.
//
// Use sparingly — too many i-icons make a page feel un-self-explanatory.
// Reserve for concepts a new user genuinely won't know (POP, calibration,
// gamma roll-off) not just for nice-to-have context.

export default function InfoTip({ children, label = 'More info', align = 'left', className = '' }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        className={clsx(
          'inline-flex items-center justify-center text-muted hover:text-amber-400 transition-colors',
          className,
        )}
      >
        <Info size={11} />
      </button>
      {open && (
        <span
          role="tooltip"
          className={clsx(
            'absolute top-full mt-1.5 w-56 p-2.5 rounded-lg bg-bg-elev border border-border shadow-lg text-[10px] text-subtle leading-relaxed z-30 pointer-events-none',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {children}
        </span>
      )}
    </span>
  )
}
