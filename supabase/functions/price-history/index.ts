// price-history — daily closes for one ticker, for /charts.
//
// POST { ticker: "AAPL", range: "3mo" | "6mo" | "1y" | "2y", crypto?: true }
//   crypto: ticker is the coin ("BTC") — priced against USD.
//   → { success, ticker, range, source: "polygon" | "yahoo", bars: [{ t, o, h, l, c }] }
//     t = the bar's date, YYYY-MM-DD (exchange day).
//
// Primary: Polygon (Massive) daily aggregates — MASSIVE_API_KEY, the same
// key compute-gex uses. Fallback: Yahoo's chart endpoint (no key, may be
// delayed). Responses are cached per (ticker, range) for 15 minutes in
// the warm instance; prices are market data, not user data, so the
// cache is shared across users. verify_jwt=true: signed-in users only.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'

const POLYGON_BASE = Deno.env.get('POLYGON_BASE_URL') || 'https://api.polygon.io'
const MASSIVE_API_KEY = Deno.env.get('MASSIVE_API_KEY')

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

const RANGE_DAYS: Record<string, number> = { '3mo': 92, '6mo': 183, '1y': 366, '2y': 731 }
const CACHE_MS = 15 * 60 * 1000
const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/

interface Bar { t: string; o: number; h: number; l: number; c: number }
const cache = new Map<string, { at: number; source: string; bars: Bar[] }>()

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10)
// Exchange-day date for a bar timestamp (bars are stamped in ET).
const etDay = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ms))

async function fromPolygon(ticker: string, days: number, crypto: boolean): Promise<Bar[] | null> {
  if (!MASSIVE_API_KEY) return null
  const symbol = crypto ? `X:${ticker}USD` : ticker
  const to = Date.now()
  const from = to - days * 86_400_000
  const url = new URL(`${POLYGON_BASE}/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${ymd(from)}/${ymd(to)}`)
  url.searchParams.set('adjusted', 'true')
  url.searchParams.set('sort', 'asc')
  url.searchParams.set('limit', '5000')
  url.searchParams.set('apiKey', MASSIVE_API_KEY)
  try {
    const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(6000) })
    if (!resp.ok) return null
    const body: { results?: Array<{ t: number; o: number; h: number; l: number; c: number }> } = await resp.json()
    const bars = (body.results ?? [])
      .filter((r) => Number.isFinite(r.c) && r.c > 0)
      .map((r) => ({ t: etDay(r.t), o: r.o, h: r.h, l: r.l, c: r.c }))
    return bars.length ? bars : null
  } catch {
    return null
  }
}

async function fromYahoo(ticker: string, range: string, crypto: boolean): Promise<Bar[] | null> {
  const symbol = crypto ? `${ticker}-USD` : ticker
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d&includePrePost=false`
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CashMoves/1.0)' },
      signal: AbortSignal.timeout(6000),
    })
    if (!resp.ok) return null
    const body = await resp.json()
    const r = body?.chart?.result?.[0]
    const ts: number[] = r?.timestamp ?? []
    const q = r?.indicators?.quote?.[0] ?? {}
    const bars: Bar[] = []
    ts.forEach((s, i) => {
      const c = Number(q.close?.[i])
      if (!Number.isFinite(c) || c <= 0) return
      bars.push({ t: etDay(s * 1000), o: Number(q.open?.[i]) || c, h: Number(q.high?.[i]) || c, l: Number(q.low?.[i]) || c, c })
    })
    return bars.length ? bars : null
  } catch {
    return null
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405)

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ success: false, error: 'invalid JSON' }, 400) }
  const ticker = String(body.ticker ?? '').trim().toUpperCase()
  const range = String(body.range ?? '6mo')
  const crypto = body.crypto === true
  if (!TICKER_RE.test(ticker)) return json({ success: false, error: 'invalid ticker' }, 400)
  const days = RANGE_DAYS[range]
  if (!days) return json({ success: false, error: 'invalid range' }, 400)

  const key = `${crypto ? 'X:' : ''}${ticker}:${range}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return json({ success: true, ticker, range, source: hit.source, bars: hit.bars, cached: true })
  }

  let source = 'polygon'
  let bars = await fromPolygon(ticker, days, crypto)
  if (!bars) { source = 'yahoo'; bars = await fromYahoo(ticker, range, crypto) }
  if (!bars) return json({ success: false, error: 'no price data' }, 502)

  cache.set(key, { at: Date.now(), source, bars })
  return json({ success: true, ticker, range, source, bars })
})
