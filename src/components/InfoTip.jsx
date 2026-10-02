import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Info, X } from 'lucide-react'
import clsx from 'clsx'

// (i) button that opens a closable explainer. Keeps cards clean: the
// detail is one tap away instead of a paragraph under every number.
// Bottom sheet on phones, centered card on wider screens. Closes on the
// X, the backdrop, or Escape.
//
//   <InfoTip title="How the tax rate works">…copy…</InfoTip>

export default function InfoTip({ title, children, label, className, size = 15 }) {
  const [open, setOpen] = useState(false)
  const titleId = useId()
  const closeRef = useRef(null)
  const triggerRef = useRef(null)

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
      triggerRef.current?.focus()
    }
  }, [open])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true) }}
        aria-label={label ?? `About: ${title}`}
        aria-haspopup="dialog"
        className={clsx(
          'inline-flex items-center justify-center min-h-[44px] min-w-[44px] -m-3 rounded-full text-muted hover:text-fg transition shrink-0',
          className,
        )}
      >
        <Info size={size} />
      </button>
      {open && createPortal(
        <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" aria-hidden />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onClick={(e) => e.stopPropagation()}
            className="relative w-full sm:max-w-md bg-card border border-border rounded-t-2xl sm:rounded-2xl shadow-2xl px-5 pt-5 pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:pb-6 max-h-[80vh] overflow-y-auto"
          >
            <div className="flex items-start gap-3 mb-3">
              <h2 id={titleId} className="flex-1 text-base font-semibold leading-snug pt-1.5">{title}</h2>
              <button ref={closeRef} type="button" onClick={() => setOpen(false)} aria-label="Close"
                className="-mr-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full text-subtle hover:text-fg hover:bg-card-hover transition">
                <X size={18} />
              </button>
            </div>
            <div className="text-sm text-subtle leading-relaxed space-y-3">{children}</div>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
