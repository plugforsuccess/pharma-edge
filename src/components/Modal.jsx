import { useEffect } from 'react'
import clsx from 'clsx'

// Centered modal wrapper. Standardised backdrop + ESC handling +
// outside-click dismiss across the three confirm/form modals that had
// each rolled their own (LogOutcomeModal, AddPositionModal,
// PopVerificationModal).
//
// Pattern split: drawers (TickerDrawer pattern — slides up from
// bottom, picker-style) stay separate; this is for confirm / form /
// alert dialogs that should be centered with a backdrop.
//
// Behavior:
// - ESC key closes via onClose
// - Click on backdrop closes
// - Click on inner panel does NOT close (event.stopPropagation)
// - body scroll locked while open
// - aria-modal + role="dialog" wired automatically
//
// Sizing: width prop accepts 'sm' (320px), 'md' (400px, default),
// 'lg' (560px). Card-style — bg-bg-elev, amber-tinted top accent.

const SIZE_MAP = {
  sm: 'max-w-xs',
  md: 'max-w-sm',
  lg: 'max-w-lg',
}

export default function Modal({
  open,
  onClose,
  children,
  size = 'md',
  ariaLabel,
  // accent: amber (default) for confirms, red for destructive,
  // green for success. Sets the top-border tint.
  accent = 'amber',
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.()
    }
    document.addEventListener('keydown', onKey)
    // Lock body scroll so the page behind doesn't scroll while modal
    // is up. Restore on unmount / close.
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  if (!open) return null

  const accentBorder =
    accent === 'red' ? 'border-red-700/60'
    : accent === 'green' ? 'border-green-700/60'
    : 'border-amber-400/40'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
    >
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div
        className={clsx(
          'relative w-full bg-bg-elev border rounded-2xl p-5 space-y-4',
          accentBorder,
          SIZE_MAP[size] || SIZE_MAP.md,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}
