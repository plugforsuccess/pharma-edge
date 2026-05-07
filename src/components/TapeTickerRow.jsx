import clsx from 'clsx'

// Horizontal ticker chip row for the Tape. Tapping a chip swaps the
// active ticker on Market Pulse + Suggested Plays underneath, so the
// Tape can serve as a multi-ticker action surface without bouncing
// to /markets.
//
// Layout: -mx-5 px-5 + overflow-x-auto so the row bleeds off the
// container edges on mobile (Skylit-style scroll-snap) but contains
// itself within the column gutter on desktop. touch-pan-x to opt the
// container into horizontal touch gestures so iOS doesn't interpret
// a swipe as edge-back-nav.

const DEFAULT_TICKERS = ['SPY', 'QQQ', 'IWM', 'NVDA', 'AAPL', 'TSLA']

export default function TapeTickerRow({ active, onSelect, tickers = DEFAULT_TICKERS }) {
  return (
    <div className="-mx-5 px-5 lg:mx-0 lg:px-0 overflow-x-auto touch-pan-x mb-4">
      <div className="flex gap-1.5 pb-1">
        {tickers.map((t) => {
          const isActive = t === active
          return (
            <button
              key={t}
              type="button"
              onClick={() => onSelect(t)}
              className={clsx(
                'tap-spring shrink-0 px-3.5 py-1.5 rounded-full border text-xs font-mono-tab font-semibold transition-colors',
                isActive
                  ? 'bg-amber-400 text-bg border-amber-400'
                  : 'bg-card text-subtle border-border hover:text-fg hover:border-border-hover',
              )}
              aria-pressed={isActive}
            >
              {t}
            </button>
          )
        })}
      </div>
    </div>
  )
}
