import { useEffect, useMemo, useState } from 'react'
import { Clock, Play, Pause } from 'lucide-react'
import { supabase } from '../lib/supabase'

// Time-scrub slider for /markets. When `active` is true we fetch
// today's gex_history rows for `ticker` (5-min cron snapshots), then
// the user drags the slider to pick a moment; we pass that snapshot's
// payload up via onSnapshot so the parent re-renders the matrix.
//
// "Live" position (rightmost) signals the parent to use real-time
// data instead of a historical snapshot — it sets snapshot to null.
//
// We fetch ~24h back so post-market replay still works after-hours.

const LOOKBACK_HOURS = 24

export default function ReplaySlider({ ticker, active, onSnapshot, onClose }) {
  const [snapshots, setSnapshots] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  // index into snapshots; snapshots.length means "live" (rightmost).
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)

  useEffect(() => {
    if (!active || !ticker) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setSnapshots([])
    const since = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString()
    supabase
      .from('gex_history')
      .select('snapshot_at, payload')
      .eq('ticker', ticker)
      .gte('snapshot_at', since)
      .order('snapshot_at', { ascending: true })
      .then(({ data, error: err }) => {
        if (cancelled) return
        setLoading(false)
        if (err) {
          setError(err.message || 'failed to load history')
          return
        }
        const rows = data ?? []
        setSnapshots(rows)
        // Default to the most recent historical snapshot (one to the
        // left of "live") so the slider lands on something meaningful.
        setIndex(rows.length > 0 ? rows.length - 1 : 0)
      })
    return () => {
      cancelled = true
    }
  }, [active, ticker])

  // Auto-play: advance the slider once per second. Stops at the right
  // edge (live). Cameron can hit pause to scrub manually.
  useEffect(() => {
    if (!active || !playing) return
    const id = setInterval(() => {
      setIndex((i) => {
        if (i >= snapshots.length) {
          setPlaying(false)
          return i
        }
        return i + 1
      })
    }, 1000)
    return () => clearInterval(id)
  }, [active, playing, snapshots.length])

  // Push the picked snapshot up. snapshots.length means "live" → null.
  useEffect(() => {
    if (!active) {
      onSnapshot(null)
      return
    }
    if (snapshots.length === 0) {
      onSnapshot(null)
      return
    }
    if (index >= snapshots.length) {
      onSnapshot(null) // live
    } else {
      onSnapshot(snapshots[index]?.payload ?? null)
    }
  }, [active, index, snapshots, onSnapshot])

  const currentTime = useMemo(() => {
    if (!active || snapshots.length === 0) return null
    if (index >= snapshots.length) return 'LIVE'
    const ts = snapshots[index]?.snapshot_at
    if (!ts) return null
    const d = new Date(ts)
    return d.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    })
  }, [active, index, snapshots])

  if (!active) return null

  return (
    <div className="bg-card border border-border rounded-xl p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Clock size={14} className="text-amber-400" />
        <span className="text-xs font-semibold text-fg">Replay</span>
        <span className="text-[10px] uppercase tracking-wider text-subtle">
          {ticker}
        </span>
        <button
          onClick={onClose}
          className="ml-auto text-[10px] uppercase tracking-wider text-subtle hover:text-fg"
        >
          Close
        </button>
      </div>

      {loading && (
        <div className="text-xs text-subtle py-2">Loading today's snapshots…</div>
      )}

      {!loading && error && (
        <div className="text-xs text-crimson">Couldn't load history: {error}</div>
      )}

      {!loading && !error && snapshots.length === 0 && (
        <div className="text-xs text-subtle py-2 leading-relaxed">
          No snapshots yet for {ticker}. Snapshots are taken every 5 min during
          US market hours; check back during the next trading session.
        </div>
      )}

      {!loading && !error && snapshots.length > 0 && (
        <>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPlaying((p) => !p)}
              className="shrink-0 w-7 h-7 rounded-full bg-amber-400 text-bg flex items-center justify-center hover:bg-amber-300 transition"
              aria-label={playing ? 'Pause' : 'Play'}
            >
              {playing ? <Pause size={12} /> : <Play size={12} />}
            </button>

            <input
              type="range"
              min={0}
              max={snapshots.length}
              value={index}
              onChange={(e) => {
                setPlaying(false)
                setIndex(Number(e.target.value))
              }}
              className="flex-1 accent-amber-400"
              aria-label="Time scrub"
            />

            <div className="shrink-0 w-14 text-right font-mono-tab tabular-nums text-xs text-fg">
              {currentTime}
            </div>
          </div>

          <div className="flex justify-between text-[10px] uppercase tracking-wider text-muted px-9">
            <span>
              {formatTime(snapshots[0]?.snapshot_at)}
            </span>
            <span>{snapshots.length} snapshots</span>
            <span>Live</span>
          </div>
        </>
      )}
    </div>
  )
}

function formatTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}
