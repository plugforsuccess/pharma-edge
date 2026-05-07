import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

// Polls dxlink_quotes for the equity row's mid/last so the GEX
// matrix's cursor row can move with live price without re-fetching
// the whole snapshot every couple seconds. The matrix's per-strike
// GEX numbers don't change second-to-second (OI is a daily figure)
// so it's wasteful to re-run compute-gex on every spot tick — but
// the user expectation is that the spot cursor LOOKS live, since
// the badge says LIVE.
//
// Returns { spot, updatedAt }. spot is null until the first poll
// completes; consumers should fall back to the snapshot's baked-in
// spot in that case.

const POLL_INTERVAL_MS = 2000
const STALE_MS = 30_000

export default function useLiveSpot(ticker) {
  const [state, setState] = useState({ spot: null, updatedAt: null })

  useEffect(() => {
    if (!ticker) {
      setState({ spot: null, updatedAt: null })
      return
    }
    let cancelled = false

    async function tick() {
      const { data, error } = await supabase
        .from('dxlink_quotes')
        .select('mid, last, bid, ask, updated_at')
        .eq('symbol', ticker.toUpperCase())
        .eq('kind', 'equity')
        .maybeSingle()
      if (cancelled || error || !data) return
      const updated = new Date(data.updated_at).getTime()
      if (Date.now() - updated > STALE_MS) {
        // Worker is offline or this ticker isn't streamed — don't
        // surface a stale snapshot as if it were live.
        return
      }
      // Prefer mid; fall back to last; finally to (bid+ask)/2.
      let spot = Number(data.mid)
      if (!Number.isFinite(spot)) spot = Number(data.last)
      if (!Number.isFinite(spot)) {
        const b = Number(data.bid)
        const a = Number(data.ask)
        if (Number.isFinite(b) && Number.isFinite(a)) spot = (b + a) / 2
      }
      if (!Number.isFinite(spot) || spot <= 0) return
      setState({ spot, updatedAt: updated })
    }

    tick()
    const id = setInterval(tick, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [ticker])

  return state
}
