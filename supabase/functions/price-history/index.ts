// price-history — daily bars for one ticker, for /charts.
//
// POST { ticker: "AAPL", range: "1mo" | "3mo" | "6mo" | "1y" | "2y", crypto?: true }
//   crypto: ticker is the coin ("BTC"), priced in USD.
//   → { success, ticker, range, source: "yahoo", bars: [{ t, o, h, l, c, v }] }
//     t = the bar's exchange day, YYYY-MM-DD.
//
// Source: Yahoo (_shared/yahoo.ts; owner, 2026-10-03 — Polygon was
// cancelled). Cached per (ticker, range) for 15 minutes in the warm
// instance; prices are market data, so the cache is shared across users.
// verify_jwt=true: signed-in users only.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { yahooBars, type Bar } from '../_shared/yahoo.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

const RANGES = new Set(['1mo', '3mo', '6mo', '1y', '2y'])
const CACHE_MS = 15 * 60 * 1000
const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/
const cache = new Map<string, { at: number; bars: Bar[] }>()

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405)

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ success: false, error: 'invalid JSON' }, 400) }
  const ticker = String(body.ticker ?? '').trim().toUpperCase()
  const range = String(body.range ?? '6mo')
  const crypto = body.crypto === true
  if (!TICKER_RE.test(ticker)) return json({ success: false, error: 'invalid ticker' }, 400)
  if (!RANGES.has(range)) return json({ success: false, error: 'invalid range' }, 400)

  const symbol = crypto ? `${ticker}-USD` : ticker
  const key = `${symbol}:${range}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return json({ success: true, ticker, range, source: 'yahoo', bars: hit.bars, cached: true })
  }
  try {
    const bars = await yahooBars(symbol, range)
    cache.set(key, { at: Date.now(), bars })
    return json({ success: true, ticker, range, source: 'yahoo', bars })
  } catch (e) {
    return json({ success: false, error: (e as Error).message }, 502)
  }
})
