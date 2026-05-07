import { RefreshCw } from 'lucide-react'
import clsx from 'clsx'

// Visual companion to usePullToRefresh. Sits absolutely-positioned
// at the top of the page, fading in as the user drags. Once the
// drag passes `threshold` the icon flips amber to telegraph that
// releasing now will refresh. While `refreshing` is true the icon
// spins.

export default function PullToRefreshIndicator({ pullDistance, refreshing, threshold = 70 }) {
  const visible = refreshing || pullDistance > 4
  if (!visible) return null
  const armed = pullDistance >= threshold || refreshing
  const opacity = refreshing ? 1 : Math.min(1, pullDistance / threshold)
  const translateY = refreshing ? 24 : Math.min(48, pullDistance - 4)
  return (
    <div
      className="fixed inset-x-0 top-0 z-40 pointer-events-none flex justify-center"
      style={{ transform: `translateY(${translateY}px)`, opacity, transition: refreshing ? 'transform 200ms ease' : 'none' }}
      aria-hidden="true"
    >
      <div
        className={clsx(
          'w-9 h-9 rounded-full border flex items-center justify-center bg-bg-elev shadow-lg',
          armed ? 'border-amber-400' : 'border-border',
        )}
      >
        <RefreshCw
          size={16}
          className={clsx(
            armed ? 'text-amber-400' : 'text-muted',
            refreshing && 'animate-spin',
          )}
          style={{
            transform: refreshing ? 'none' : `rotate(${Math.min(360, pullDistance * 4)}deg)`,
          }}
        />
      </div>
    </div>
  )
}
