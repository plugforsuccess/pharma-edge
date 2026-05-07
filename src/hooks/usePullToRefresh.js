import { useEffect, useRef, useState } from 'react'

// Pull-to-refresh on mobile. Wraps a top-of-page touch handler so a
// downward drag from scrollTop=0 triggers `onRefresh`. We do this by
// hand instead of pulling in a library because:
//   - the only real surface is "top of a scroll container, drag down"
//   - off-the-shelf libs (react-pull-to-refresh, etc.) ship their own
//     spinners and DOM, which fights our design system
//   - the math is ~30 lines
//
// Returns { ref, pullDistance, refreshing }. Attach `ref` to the
// scroll container (or document.body if the page itself scrolls).
// Render a small indicator at the top using `pullDistance` (0..THRESHOLD+).
//
// Bails out automatically when:
//   - prefers-reduced-motion is set
//   - the gesture starts while scrolled (only top-of-page pulls trigger)
//   - the user's finger moves more horizontally than vertically
//     (lets horizontal-scrolling matrices keep working)

const THRESHOLD = 70 // px the user must drag before refresh fires
const MAX_PULL = 110 // visual cap so the indicator doesn't run away

export default function usePullToRefresh(onRefresh, { disabled = false } = {}) {
  const [pullDistance, setPullDistance] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const startY = useRef(null)
  const startX = useRef(null)
  const tracking = useRef(false)
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh

  useEffect(() => {
    if (disabled) return
    if (typeof window === 'undefined') return
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduced) return

    function onTouchStart(e) {
      if (refreshing) return
      const scrollTop = window.scrollY || document.documentElement.scrollTop
      if (scrollTop > 0) return
      const t = e.touches[0]
      startY.current = t.clientY
      startX.current = t.clientX
      tracking.current = true
    }

    function onTouchMove(e) {
      if (!tracking.current) return
      const t = e.touches[0]
      const dy = t.clientY - startY.current
      const dx = t.clientX - startX.current
      // horizontal-dominant gesture — user is swiping a matrix, bail
      if (Math.abs(dx) > Math.abs(dy)) {
        tracking.current = false
        setPullDistance(0)
        return
      }
      if (dy <= 0) {
        setPullDistance(0)
        return
      }
      // resistance curve so the pull feels weightier the further it goes
      const resisted = Math.min(MAX_PULL, dy * 0.5)
      setPullDistance(resisted)
    }

    async function onTouchEnd() {
      if (!tracking.current) return
      tracking.current = false
      const distance = pullDistanceRef.current
      setPullDistance(0)
      if (distance >= THRESHOLD) {
        setRefreshing(true)
        try {
          await onRefreshRef.current?.()
        } finally {
          setRefreshing(false)
        }
      }
    }

    document.addEventListener('touchstart', onTouchStart, { passive: true })
    document.addEventListener('touchmove', onTouchMove, { passive: true })
    document.addEventListener('touchend', onTouchEnd, { passive: true })
    document.addEventListener('touchcancel', onTouchEnd, { passive: true })
    return () => {
      document.removeEventListener('touchstart', onTouchStart)
      document.removeEventListener('touchmove', onTouchMove)
      document.removeEventListener('touchend', onTouchEnd)
      document.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [disabled, refreshing])

  // mirror state into a ref so onTouchEnd reads the latest value
  // without re-binding listeners on every distance change
  const pullDistanceRef = useRef(0)
  pullDistanceRef.current = pullDistance

  return { pullDistance, refreshing, threshold: THRESHOLD }
}
