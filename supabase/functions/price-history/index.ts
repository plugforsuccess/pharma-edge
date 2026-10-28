// price-history — daily bars for one ticker, for /charts.
//
// POST { ticker: "AAPL", range: "1d" | "5d" | "1mo" | "3mo" | "6mo" | "1y" | "2y" | "5y" | "max", crypto?: true,
//        interval?: "5m" | "15m" | "30m" | "60m" | "1d" }
//   interval "1d" with range 5y / 10y / max = full daily history (owner,
//   2026-10-28: the Top Forming backtest needs daily bars back to 2015).
//   interval (owner, 2026-10-16: intraday candle sizes on the entry chart)
//   overrides the range's default; Yahoo serves 5m / 15m / 30m up to 60
//   days back and 60m up to 730 days, so only those pairings are accepted.
//   crypto: ticker is the coin ("BTC"), priced in USD.
//   → { success, ticker, range, interval, source: "yahoo", prev_close, bars: [{ t, o, h, l, c, v }] }
//     Daily ranges (and 5y weekly / max monthly bars): t = the bar's
//     exchange day, YYYY-MM-DD.
//     1d (5-minute bars) and 5d (30-minute bars): t = unix seconds of the
//     New York wall-clock time read as UTC, so charts label ET times.
//
// Source: Yahoo (_shared/yahoo.ts; owner, 2026-10-03 — Polygon was
// cancelled). Cached per (ticker, range) for 15 minutes (2 for intraday) in the warm
// instance; prices are market data, so the cache is shared across users.
// verify_jwt=true: signed-in users only.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { yahooChart, type Bar } from '../_shared/yahoo.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

// Range → bar interval. Intraday ranges refresh faster.
const INTERVAL: Record<string, string> = {
  '1d': '5m', '5d': '30m', '1mo': '1d', '3mo': '1d', '6mo': '1d', '1y': '1d', '2y': '1d', '5y': '1wk', '10y': '1wk', max: '1mo',
}
const INTRADAY = new Set(['5m', '15m', '30m', '60m'])
// Explicit intraday intervals and the ranges Yahoo allows for each.
const INTERVAL_RANGES: Record<string, Set<string>> = {
  '5m': new Set(['1d', '5d', '1mo']), '15m': new Set(['1d', '5d', '1mo']), '30m': new Set(['1d', '5d', '1mo']),
  '60m': new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y']),
  '1d': new Set(['1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'max']),
}
const CACHE_MS = 15 * 60 * 1000
const INTRADAY_CACHE_MS = 2 * 60 * 1000
// A leading ^ allows indexes (^VIX from the market card).
const TICKER_RE = /^\^?[A-Z][A-Z0-9.\-]{0,9}$/
const cache = new Map<string, { at: number; bars: Bar[]; prevClose: number | null }>()

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405)

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ success: false, error: 'invalid JSON' }, 400) }
  const ticker = String(body.ticker ?? '').trim().toUpperCase()
  const range = String(body.range ?? '6mo')
  const crypto = body.crypto === true
  if (!TICKER_RE.test(ticker)) return json({ success: false, error: 'invalid ticker' }, 400)
  if (!INTERVAL[range]) return json({ success: false, error: 'invalid range' }, 400)
  const asked = body.interval == null ? null : String(body.interval)
  if (asked != null && !INTERVAL_RANGES[asked]?.has(range)) return json({ success: false, error: 'invalid interval for this range' }, 400)
  const interval = asked ?? INTERVAL[range]
  const ttl = INTRADAY.has(interval) ? INTRADAY_CACHE_MS : CACHE_MS

  // Yahoo writes share classes with a dash (BRK.B → BRK-B).
  const symbol = crypto ? `${ticker}-USD` : ticker.replace(/\./g, '-')
  const key = `${symbol}:${range}:${interval}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < ttl) {
    return json({ success: true, ticker, range, interval, source: 'yahoo', prev_close: hit.prevClose, bars: hit.bars, cached: true })
  }
  try {
    const { bars, prevClose } = await yahooChart(symbol, range, interval)
    cache.set(key, { at: Date.now(), bars, prevClose })
    return json({ success: true, ticker, range, interval, source: 'yahoo', prev_close: prevClose, bars })
  } catch (e) {
    return json({ success: false, error: (e as Error).message }, 502)
  }
})
