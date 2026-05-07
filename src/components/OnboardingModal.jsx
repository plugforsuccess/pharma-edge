import { useEffect, useState } from 'react'
import { Activity, Sparkles, FileText, Share2, ChevronRight, ChevronLeft, X } from 'lucide-react'
import clsx from 'clsx'
import Modal from './Modal'

// First-time-user walkthrough. 4 slides covering the core loop:
//   1. The Tape (read the regime)
//   2. Suggested Plays (R/R + EV-edge filter)
//   3. Log a Move (hash-locked thesis)
//   4. Public Record (shareable proof)
//
// Triggered once per browser per user via localStorage flag. The
// in-product OnboardingCard on the Tape covers the same ground for
// users who dismiss this and want to revisit; the modal is the
// "get this in front of your eyes the first time you open the app"
// surface that the card alone can't guarantee.
//
// Persistence: localStorage key includes the user id so a shared
// device with multiple accounts doesn't carry the flag across.

const STORAGE_KEY_PREFIX = 'pe_onboarded_v1__'

const SLIDES = [
  {
    icon: Activity,
    eyebrow: 'Step 1',
    title: 'Read the tape',
    body: 'Market Pulse shows where dealer hedging concentrates: The Flip (zero-gamma level) and The Wall (largest dealer position). When spot sits above the flip, dealers buy dips and sell rallies — pin environment. Below the flip, hedging amplifies moves. Tap a ticker chip to switch markets.',
    accent: 'amber',
  },
  {
    icon: Sparkles,
    eyebrow: 'Step 2',
    title: 'Pick a +EV play',
    body: "Suggested Plays only surfaces spreads that clear two rules: R/R ≥ 1:1.5, and the IV-implied probability beats the breakeven win rate the structure needs. Plays show PoP, Breakeven, and the EV edge between them — green chip = +EV, no chip = data unavailable. Empty list means no high-conviction setup right now.",
    accent: 'amber',
  },
  {
    icon: FileText,
    eyebrow: 'Step 3',
    title: 'Lock the thesis',
    body: 'Tapping Log a Move opens a 4-step flow: ticker + structure → strikes + IV-derived PoP → checklist → confirm. On confirm, the signal is SHA-256 hashed and the thesis becomes immutable. You can never edit your prediction after the fact — that is the entire credibility model.',
    accent: 'amber',
  },
  {
    icon: Share2,
    eyebrow: 'Step 4',
    title: 'Build a record',
    body: 'Every locked move + outcome anchors to a public GitHub commit and feeds your share page at /r/your-slug. Calibration delta (does your stated PoP match your actual hit rate?) and EV per signal are the two numbers that matter. Make Settings → Public Profile public when you are ready to share.',
    accent: 'amber',
  },
]

export default function OnboardingModal({ userId, onClose }) {
  const [step, setStep] = useState(0)

  // ESC + outside-click are handled by the Modal primitive. We handle
  // arrow keys here for desktop pagination and dismiss on completion.
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'ArrowRight' && step < SLIDES.length - 1) setStep((s) => s + 1)
      if (e.key === 'ArrowLeft' && step > 0) setStep((s) => s - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step])

  function dismiss() {
    if (userId && typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(STORAGE_KEY_PREFIX + userId, '1')
      } catch { /* private mode */ }
    }
    onClose?.()
  }

  const slide = SLIDES[step]
  const Icon = slide.icon
  const isLast = step === SLIDES.length - 1

  return (
    <Modal open onClose={dismiss} size="md" ariaLabel="Welcome to Cash Moves">
      <div className="p-6 space-y-5">
        <div className="flex items-start justify-between">
          <span className="eyebrow text-amber-400">{slide.eyebrow} of {SLIDES.length}</span>
          <button
            type="button"
            onClick={dismiss}
            className="text-muted hover:text-fg p-1 -m-1"
            aria-label="Skip walkthrough"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex items-center justify-center pt-2">
          <div className="w-14 h-14 rounded-2xl bg-amber-400/10 border border-amber-400/30 flex items-center justify-center">
            <Icon size={26} className="text-amber-400" strokeWidth={1.5} />
          </div>
        </div>

        <div className="text-center space-y-2.5">
          <h2 className="font-display text-2xl text-fg leading-tight">
            {slide.title}
          </h2>
          <p className="text-subtle text-sm leading-relaxed max-w-md mx-auto">
            {slide.body}
          </p>
        </div>

        {/* Progress dots */}
        <div className="flex items-center justify-center gap-1.5 pt-1">
          {SLIDES.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setStep(i)}
              className={clsx(
                'h-1.5 rounded-full transition-all',
                i === step ? 'w-6 bg-amber-400' : 'w-1.5 bg-border hover:bg-border-hover',
              )}
              aria-label={`Go to step ${i + 1}`}
            />
          ))}
        </div>

        <div className="flex items-center justify-between pt-2">
          <button
            type="button"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0}
            className="tap-spring inline-flex items-center gap-1 px-3 py-2 text-sm text-subtle hover:text-fg disabled:opacity-30 disabled:hover:text-subtle"
          >
            <ChevronLeft size={14} />
            Back
          </button>

          {isLast ? (
            <button
              type="button"
              onClick={dismiss}
              className="tap-spring btn-primary inline-flex items-center gap-1.5 px-5 py-2 rounded-xl text-sm font-semibold"
            >
              Get started
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setStep((s) => s + 1)}
              className="tap-spring btn-primary inline-flex items-center gap-1 px-4 py-2 rounded-xl text-sm font-semibold"
            >
              Next
              <ChevronRight size={14} />
            </button>
          )}
        </div>
      </div>
    </Modal>
  )
}

// Helper for callers — checks whether the modal should be shown for
// this user. Keeps the localStorage key convention in one place.
export function shouldShowOnboarding(userId) {
  if (!userId || typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(STORAGE_KEY_PREFIX + userId) !== '1'
  } catch {
    return false
  }
}
