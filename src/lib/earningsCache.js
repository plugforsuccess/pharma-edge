// Session-scoped earnings calendar cache.
//
// The earnings_calendar table is populated by bot-seed-earnings-finnhub
// once a day at 06:00 ET. It changes at most daily, so we fetch the
// whole next-60d window ONCE per session (5-min TTL) and serve every
// EarningsBadge instance from a single in-memory Map. Without this,
// rendering a picker with 75+ tickers would fire 75 queries; with it,
// it's one.
//
// All consumers go through getEarnings(ticker) or useEarnings(ticker).
// No prop-drilling, no context, no React Query — kept dependency-free
// since this is the only consumer.

import { useEffect, useState } from 'react'
import { supabase } from './supabase'

const TTL_MS = 5 * 60 * 1000
const HORIZON_DAYS = 60

let cache = null      // { fetchedAt: number, byTicker: Map<UPPER, row> }
let inflight = null   // Promise<Map> while a fetch is mid-flight

async function fetchAll() {
  const today = new Date()
  const horizon = new Date()
  horizon.setDate(horizon.getDate() + HORIZON_DAYS)
  const todayStr = today.toISOString().slice(0, 10)
  const horizonStr = horizon.toISOString().slice(0, 10)
  const { data, error } = await supabase
    .from('earnings_calendar')
    .select('ticker, earnings_date, announcement_time, consensus_eps, source')
    .gte('earnings_date', todayStr)
    .lte('earnings_date', horizonStr)
    .order('earnings_date', { ascending: true })
  if (error) {
    console.error('[earningsCache] fetch failed', error)
    return new Map()
  }
  // Take the EARLIEST upcoming earnings per ticker. The query is
  // already ASC by date, so the first row per ticker wins.
  const byTicker = new Map()
  for (const row of data ?? []) {
    const t = String(row.ticker || '').toUpperCase()
    if (!t || byTicker.has(t)) continue
    byTicker.set(t, row)
  }
  return byTicker
}

async function ensureFresh() {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache.byTicker
  if (inflight) return inflight
  inflight = (async () => {
    const byTicker = await fetchAll()
    cache = { fetchedAt: Date.now(), byTicker }
    return byTicker
  })()
  try {
    return await inflight
  } finally {
    inflight = null
  }
}

export async function getEarnings(ticker) {
  if (!ticker) return null
  const byTicker = await ensureFresh()
  return byTicker.get(String(ticker).toUpperCase()) ?? null
}

// Force-refresh the cache. Call after the user manually triggers the
// seeder, or wire to a "refresh" button if we add one later.
export async function refreshEarnings() {
  cache = null
  inflight = null
  return ensureFresh()
}

// React hook wrapper. Returns null while loading or when the ticker
// has no upcoming earnings in the next HORIZON_DAYS window.
export function useEarnings(ticker) {
  const [data, setData] = useState(null)
  useEffect(() => {
    if (!ticker) { setData(null); return }
    let cancelled = false
    getEarnings(ticker).then((r) => { if (!cancelled) setData(r) })
    return () => { cancelled = true }
  }, [ticker])
  return data
}
