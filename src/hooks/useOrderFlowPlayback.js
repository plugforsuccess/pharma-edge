import { useCallback, useEffect, useRef, useState } from 'react'
import { OrderFlowEngine } from '../utils/orderflow/engine.js'

// Plays a recorded or synthetic event stream through the NIGHTFLOW engine
// in the browser: a simulated clock, speed control, seek (rebuilds the
// engine from the start — nothing after the clock is ever fed in) and a
// snapshot every 5 simulated seconds, exactly like the live worker.
const STEP_MS = 5_000
const TICK_MS = 250

export function useOrderFlowPlayback({ events, symbol, source, context, startAt }) {
  const eng = useRef(null)
  const idx = useRef(0)
  const nextSnap = useRef(null)
  const [clock, setClock] = useState(null)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(10)
  const [snap, setSnap] = useState(null)
  const [history, setHistory] = useState([])
  const hist = useRef([])

  const first = events?.[0]?.t ?? null
  const last = events?.length ? events[events.length - 1].t : null

  // Feed every event with t ≤ to, snapshotting at each 5 s boundary.
  const advance = useCallback((to) => {
    const e = eng.current
    if (!e || !events) return
    let latest = null
    while (idx.current < events.length && events[idx.current].t <= to) {
      const ev = events[idx.current]
      while (ev.t >= nextSnap.current) { latest = e.snapshot(nextSnap.current); hist.current.push(point(latest)); nextSnap.current += STEP_MS }
      if (ev.kind === 'quote') e.onQuote(ev)
      else if (ev.kind === 'book') e.onBook(ev)
      else e.onTrade(ev)
      idx.current++
    }
    while (nextSnap.current <= to) { latest = e.snapshot(nextSnap.current); hist.current.push(point(latest)); nextSnap.current += STEP_MS }
    if (hist.current.length > 1440) hist.current.splice(0, hist.current.length - 1440)
    if (latest) { setSnap(latest); setHistory(hist.current.slice()) }
  }, [events])

  const seek = useCallback((to) => {
    if (!events?.length) return
    const t = Math.max(first, Math.min(last, to))
    eng.current = new OrderFlowEngine({ symbol, source, context })
    idx.current = 0
    nextSnap.current = first + STEP_MS
    hist.current = []
    advance(t)
    setClock(t)
  }, [events, first, last, symbol, source, context, advance])

  // New stream → start at startAt (e.g. after the synthetic warm-up).
  useEffect(() => {
    setPlaying(false); setSnap(null); setHistory([])
    if (events?.length) seek(startAt ?? first)
    else { eng.current = null; setClock(null) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events])

  const clockRef = useRef(null)
  clockRef.current = clock
  useEffect(() => {
    if (!playing) return undefined
    const id = setInterval(() => {
      if (clockRef.current == null) return
      const n = Math.min(last, clockRef.current + TICK_MS * speed)
      advance(n)
      clockRef.current = n
      setClock(n)
      if (n >= last) setPlaying(false)
    }, TICK_MS)
    return () => clearInterval(id)
  }, [playing, speed, last, advance])

  return { clock, playing, setPlaying, speed, setSpeed, seek, snap, history, first, last }
}

export function point(s) {
  return {
    t: s.t, score: s.score?.value ?? null, spreadPct: s.liquidity?.spreadPct ?? null,
    imbalance: s.liquidity?.depth?.imbalance ?? s.liquidity?.imbalanceTop ?? null,
    bidUsd: s.liquidity?.depth?.bidUsd1pct ?? s.liquidity?.bidUsd ?? null,
    askUsd: s.liquidity?.depth?.askUsd1pct ?? s.liquidity?.askUsd ?? null,
  }
}
