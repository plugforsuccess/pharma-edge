// leaps-entry — data for the LEAPS entry chart (/charts/entry/:ticker).
//
// POST { ticker: "AAPL" }
//   → { success, ticker, source: "yahoo", bars: [{ t, o, h, l, c, v }],
//       iv_points: [{ t, iv }], iv_today, iv_today_expiry }
//   bars: 5 years of daily bars (the page shows the last 2; the rest warms
//   up the 200-day SMA / 252-day ranks and feeds the backtest).
//   iv_points: stored 30-day IV from iv_history (decimal). Values outside
//   2%–300% are dropped as bad samples.
//   iv_today: today's ATM IV from Yahoo — the expiry nearest 30 days out,
//   mean of the call and put IV at the strike nearest spot. null on failure.
//
// The indicators and the buy-zone signal are computed in the browser
// (src/utils/indicators.js) so the thresholds can be adjusted live.
// Market data, shared across users: cached 15 minutes in the warm instance.
// verify_jwt=true: signed-in users only.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { yahooChart, yahooOptions, type Bar } from '../_shared/yahoo.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

const CACHE_MS = 15 * 60 * 1000
const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/
const cache = new Map<string, { at: number; body: Record<string, unknown> }>()

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

async function storedIv(ticker: string): Promise<Array<{ t: string; iv: number }>> {
  if (!SUPABASE_URL || !SERVICE_KEY) return []
  const db = createClient(SUPABASE_URL, SERVICE_KEY)
  const { data, error } = await db
    .from('iv_history')
    .select('sample_date, iv_30d')
    .eq('ticker', ticker)
    .not('iv_30d', 'is', null)
    .order('sample_date', { ascending: true })
    .limit(2000)
  if (error || !data) return []
  return data
    .map((r) => ({ t: String(r.sample_date), iv: Number(r.iv_30d) }))
    .filter((p) => p.iv >= 0.02 && p.iv <= 3)
}

async function atmIv(symbol: string): Promise<{ iv: number | null; expiry: string | null }> {
  try {
    const first = await yahooOptions(symbol)
    const dates = first.expirationDates ?? []
    if (!dates.length) return { iv: null, expiry: null }
    const target = Date.now() / 1000 + 30 * 86400
    const pick = dates.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a))
    const chain = pick === first.options?.[0]?.expirationDate ? first : await yahooOptions(symbol, pick)
    const spot = chain.quote?.regularMarketPrice
    const opt = chain.options?.[0]
    if (!spot || !opt) return { iv: null, expiry: null }
    const nearest = (list: Array<{ strike?: number; impliedVolatility?: number }> = []) =>
      list.filter((c) => c.strike && c.impliedVolatility && c.impliedVolatility > 0.02 && c.impliedVolatility < 3)
        .sort((a, b) => Math.abs(a.strike! - spot) - Math.abs(b.strike! - spot))[0]?.impliedVolatility ?? null
    const vals = [nearest(opt.calls), nearest(opt.puts)].filter((x): x is number => x != null)
    const iv = vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : null
    return { iv, expiry: new Date(pick * 1000).toISOString().slice(0, 10) }
  } catch {
    return { iv: null, expiry: null }
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405)

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ success: false, error: 'invalid JSON' }, 400) }
  const ticker = String(body.ticker ?? '').trim().toUpperCase()
  if (!TICKER_RE.test(ticker)) return json({ success: false, error: 'invalid ticker' }, 400)

  const hit = cache.get(ticker)
  if (hit && Date.now() - hit.at < CACHE_MS) return json({ ...hit.body, cached: true })

  // Yahoo writes share classes with a dash (BRK.B → BRK-B).
  const symbol = ticker.replace(/\./g, '-')
  let bars: Bar[]
  try {
    bars = (await yahooChart(symbol, '5y', '1d')).bars
  } catch (e) {
    return json({ success: false, error: (e as Error).message }, 502)
  }
  if (bars.length < 60) return json({ success: false, error: 'not enough price history' }, 404)

  const [ivPoints, today] = await Promise.all([storedIv(ticker), atmIv(symbol)])
  const out = {
    success: true, ticker, source: 'yahoo', bars,
    iv_points: ivPoints, iv_today: today.iv, iv_today_expiry: today.expiry,
  }
  cache.set(ticker, { at: Date.now(), body: out })
  return json(out)
})
