import clsx from 'clsx'

// Canonical spinner. Two tones (amber for brand actions / page-level
// loads, neutral for inline async on buttons), three sizes (sm 12px,
// md 16px, lg 32px). Replaces the half-dozen one-off border-spin
// divs that had drifted across the app — same shape everywhere now.
//
// Use a Skeleton block instead of this when the layout-to-be is known
// (lists, cards, tables); use Spinner only when the answer to "what
// goes here?" is "we don't know yet" (button confirms, page bootstrap).

const SIZE_MAP = {
  sm: 'w-3 h-3 border',
  md: 'w-4 h-4 border-2',
  lg: 'w-8 h-8 border-2',
}

const TONE_MAP = {
  amber: 'border-transparent border-t-amber-400',
  neutral: 'border-transparent border-t-current',
  red: 'border-transparent border-t-red-500',
}

export default function Spinner({
  size = 'md',
  tone = 'amber',
  className = '',
  label = 'Loading',
}) {
  return (
    <span
      role="status"
      aria-label={label}
      className={clsx(
        'inline-block rounded-full animate-spin border-border/30',
        SIZE_MAP[size] || SIZE_MAP.md,
        TONE_MAP[tone] || TONE_MAP.amber,
        className,
      )}
    />
  )
}
